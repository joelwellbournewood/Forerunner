/**
 * Releases and release assets (with sha256 digests), including the "web" download URL.
 */
import { createHash } from "node:crypto";
import type { HostApp, HostContext } from "./http.ts";
import {
  bool,
  guardRepo,
  HttpError,
  intParam,
  paginate,
  readJson,
  requireLogin,
  requireRepo,
  requireStr,
  str,
  validationFailed,
} from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { ReleaseAssetRecord, ReleaseRecord, RepoRecord } from "./store.ts";

export function registerReleaseRoutes(app: HostApp, ctx: RouteContext): void {
  const { store, ops } = ctx;

  const releaseOf = (c: HostContext, repo: RepoRecord): ReleaseRecord => {
    const rel = repo.releases.get(intParam(c, "id"));
    if (!rel) throw new HttpError(404, "Not Found");
    return rel;
  };

  const sorted = (repo: RepoRecord) =>
    [...repo.releases.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
    );

  app.get("/repos/:owner/:repo/releases", (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    const canSeeDrafts = c.get("auth").token !== null;
    const list = sorted(repo).filter((r) => canSeeDrafts || !r.draft);
    return c.json(
      paginate(
        c,
        list.map((r) => store.releaseJson(repo, r)),
      ),
    );
  });

  app.get("/repos/:owner/:repo/releases/latest", (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    const latest = sorted(repo).find((r) => !r.draft && !r.prerelease);
    if (!latest) throw new HttpError(404, "Not Found");
    return c.json(store.releaseJson(repo, latest));
  });

  app.get("/repos/:owner/:repo/releases/tags/:tag", (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    const tag = c.req.param("tag") ?? "";
    const rel = sorted(repo).find((r) => r.tagName === tag && !r.draft);
    if (!rel) throw new HttpError(404, "Not Found");
    return c.json(store.releaseJson(repo, rel));
  });

  app.get("/repos/:owner/:repo/releases/assets/:id", async (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    const found = store.assetsById.get(intParam(c, "id"));
    if (!found || found.repo !== repo) throw new HttpError(404, "Not Found");
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/octet-stream")) {
      return c.body(new Uint8Array(found.asset.content), 200, {
        "Content-Type": found.asset.contentType,
        "Content-Length": String(found.asset.size),
      });
    }
    return c.json(store.assetJson(repo, found.release, found.asset));
  });

  app.delete("/repos/:owner/:repo/releases/assets/:id", (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const found = store.assetsById.get(intParam(c, "id"));
    if (!found || found.repo !== repo) throw new HttpError(404, "Not Found");
    found.release.assets.delete(found.asset.id);
    store.assetsById.delete(found.asset.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/releases/:id", (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    return c.json(store.releaseJson(repo, releaseOf(c, repo)));
  });

  app.post("/repos/:owner/:repo/releases", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const tagName = requireStr(body, "tag_name", "Release");
    const draft = bool(body, "draft") ?? false;
    if (!draft && sorted(repo).some((r) => r.tagName === tagName && !r.draft)) {
      throw validationFailed([{ resource: "Release", field: "tag_name", code: "already_exists" }]);
    }
    const target = str(body, "target_commitish") ?? repo.defaultBranch;
    let tagSha = await repo.git.revParse(`refs/tags/${tagName}`);
    if (!tagSha && !draft) {
      const commit = await repo.git.revParse(target);
      if (!commit)
        throw validationFailed([
          { resource: "Release", field: "target_commitish", code: "invalid" },
        ]);
      await ops.setRef(repo, `refs/tags/${tagName}`, commit, login, { mustNotExist: true });
      tagSha = commit;
    }
    const now = store.clock.nowIso();
    const rel: ReleaseRecord = {
      id: store.nextId(),
      tagName,
      targetCommitish: target,
      name: str(body, "name") ?? tagName,
      body: str(body, "body") ?? "",
      draft,
      prerelease: bool(body, "prerelease") ?? false,
      author: login,
      createdAt: now,
      publishedAt: draft ? null : now,
      assets: new Map(),
    };
    repo.releases.set(rel.id, rel);
    if (!draft)
      store.emit(repo, "release", "published", { release: store.releaseJson(repo, rel) }, login);
    return c.json(store.releaseJson(repo, rel), 201);
  });

  app.patch("/repos/:owner/:repo/releases/:id", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const rel = releaseOf(c, repo);
    const body = await readJson(c);
    const name = str(body, "name");
    if (name !== undefined) rel.name = name;
    const text = str(body, "body");
    if (text !== undefined) rel.body = text;
    const tag = str(body, "tag_name");
    if (tag !== undefined) rel.tagName = tag;
    const pre = bool(body, "prerelease");
    if (pre !== undefined) rel.prerelease = pre;
    const draft = bool(body, "draft");
    if (draft === false && rel.draft) {
      rel.draft = false;
      rel.publishedAt = store.clock.nowIso();
      if (!(await repo.git.revParse(`refs/tags/${rel.tagName}`))) {
        const commit = await repo.git.revParse(rel.targetCommitish);
        if (commit)
          await ops.setRef(repo, `refs/tags/${rel.tagName}`, commit, login, { mustNotExist: true });
      }
      store.emit(repo, "release", "published", { release: store.releaseJson(repo, rel) }, login);
    } else {
      store.emit(repo, "release", "edited", { release: store.releaseJson(repo, rel) }, login);
    }
    return c.json(store.releaseJson(repo, rel));
  });

  app.delete("/repos/:owner/:repo/releases/:id", (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const rel = releaseOf(c, repo);
    repo.releases.delete(rel.id);
    for (const a of rel.assets.keys()) store.assetsById.delete(a);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/releases/:id/assets", (c) => {
    const repo = requireRepo(c, store, "contents", "read");
    const rel = releaseOf(c, repo);
    return c.json(
      paginate(
        c,
        [...rel.assets.values()].map((a) => store.assetJson(repo, rel, a)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/releases/:id/assets", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const rel = releaseOf(c, repo);
    const name = c.req.query("name");
    if (!name)
      throw validationFailed([{ resource: "ReleaseAsset", field: "name", code: "missing_field" }]);
    if ([...rel.assets.values()].some((a) => a.name === name)) {
      throw validationFailed([{ resource: "ReleaseAsset", field: "name", code: "already_exists" }]);
    }
    const content = Buffer.from(await c.req.arrayBuffer());
    const now = store.clock.nowIso();
    const asset: ReleaseAssetRecord = {
      id: store.nextId(),
      name,
      label: c.req.query("label") ?? null,
      contentType: c.req.header("content-type") ?? "application/octet-stream",
      size: content.length,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      uploader: login,
      createdAt: now,
      updatedAt: now,
    };
    rel.assets.set(asset.id, asset);
    store.assetsById.set(asset.id, { repo, release: rel, asset });
    return c.json(store.assetJson(repo, rel, asset), 201);
  });

  // browser_download_url
  app.get("/:owner/:repo/releases/download/:tag/:name", (c) => {
    const repo = store.repo(c.req.param("owner") ?? "", c.req.param("repo") ?? "");
    if (!repo) throw new HttpError(404, "Not Found");
    guardRepo(c, repo, "contents", "read");
    const tag = c.req.param("tag") ?? "";
    const name = c.req.param("name") ?? "";
    const rel = sorted(repo).find((r) => r.tagName === tag);
    const asset = rel ? [...rel.assets.values()].find((a) => a.name === name) : undefined;
    if (!asset) throw new HttpError(404, "Not Found");
    return c.body(new Uint8Array(asset.content), 200, {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.size),
      "X-Checksum-Sha256": asset.sha256,
    });
  });
}
