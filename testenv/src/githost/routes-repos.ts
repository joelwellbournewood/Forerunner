/**
 * Users, orgs, repositories, branches, git refs, commits and the contents API.
 */
import { canCreateRepo, canSeeRepo, isAffiliated, matchesAllowlist } from "./auth.ts";
import {
  bool,
  guardRepo,
  type HostApp,
  type HostContext,
  HttpError,
  paginate,
  readJson,
  requireLogin,
  requireRepo,
  requireStr,
  str,
  validationFailed,
  wildcardPath,
} from "./http.ts";
import type { RepoOps } from "./ops.ts";
import type { HostStore, Json, RepoRecord } from "./store.ts";

export interface RouteContext {
  store: HostStore;
  ops: RepoOps;
}

function visibleRepos(
  c: HostContext,
  store: HostStore,
  filter: (r: RepoRecord) => boolean,
): Json[] {
  const auth = c.get("auth");
  return [...store.repos.values()]
    .filter((r) => filter(r) && canSeeRepo(auth.subject, r))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((r) => store.repoJson(r, auth.subject));
}

async function createRepoRoute(
  c: HostContext,
  ctx: RouteContext,
  owner: string,
): Promise<Response> {
  const login = requireLogin(c);
  const body = await readJson(c);
  const name = requireStr(body, "name", "Repository");
  const isPrivate = bool(body, "private") ?? false;
  const decision = canCreateRepo(c.get("auth").subject, owner, isPrivate);
  if (decision === "not_found") throw new HttpError(404, "Not Found");
  if (decision === "forbidden")
    throw new HttpError(403, "Resource not accessible by personal access token");
  if (decision === "unauthenticated") throw new HttpError(401, "Requires authentication");
  const autoInit = bool(body, "auto_init") ?? false;
  const repo = await ctx.ops.createRepo({
    owner,
    name,
    private: isPrivate,
    defaultBranch: str(body, "default_branch") ?? "main",
    description: str(body, "description") ?? "",
    initialFiles: autoInit
      ? { "README.md": `# ${name}\n\n${str(body, "description") ?? ""}\n` }
      : undefined,
    creator: login,
  });
  return c.json(ctx.store.repoJson(repo, c.get("auth").subject), 201);
}

export function registerRepoRoutes(app: HostApp, ctx: RouteContext): void {
  const { store, ops } = ctx;

  // ---- users and orgs ----------------------------------------------------------------------
  app.get("/user", (c) => {
    const auth = c.get("auth");
    if (!auth.login) throw new HttpError(401, "Requires authentication");
    const u = store.user(auth.login);
    if (!u) throw new HttpError(401, "Bad credentials");
    return c.json(store.userJson(u));
  });

  app.get("/users/:login", (c) => {
    const u = store.user(c.req.param("login") ?? "");
    if (!u) throw new HttpError(404, "Not Found");
    return c.json(store.userJson(u));
  });

  app.get("/orgs/:org", (c) => {
    const u = store.user(c.req.param("org") ?? "");
    if (u?.type !== "Organization") throw new HttpError(404, "Not Found");
    return c.json(store.userJson(u));
  });

  app.get("/user/orgs", (c) => {
    const login = requireLogin(c);
    const orgs = [...store.users.values()].filter(
      (u) => u.type === "Organization" && u.members.has(login.toLowerCase()),
    );
    return c.json(
      paginate(
        c,
        orgs.map((o) => store.userJson(o)),
      ),
    );
  });

  // ---- repositories ------------------------------------------------------------------------
  app.get("/user/repos", (c) => {
    const auth = c.get("auth");
    if (!auth.token) throw new HttpError(401, "Requires authentication");
    const token = auth.token;
    return c.json(
      paginate(
        c,
        visibleRepos(c, store, (r) =>
          token.kind === "app_installation"
            ? matchesAllowlist(token.repos, r)
            : token.kind === "fine_grained"
              ? matchesAllowlist(token.repos, r) &&
                (isAffiliated(auth.subject, r) || r.collaborators.has(token.owner.toLowerCase()))
              : isAffiliated(auth.subject, r) || r.collaborators.has(token.owner.toLowerCase()),
        ),
      ),
    );
  });

  app.get("/installation/repositories", (c) => {
    const auth = c.get("auth");
    if (auth.token?.kind !== "app_installation")
      throw new HttpError(401, "Requires authentication");
    const token = auth.token;
    const repos = visibleRepos(c, store, (r) => matchesAllowlist(token.repos, r));
    return c.json({
      total_count: repos.length,
      repository_selection: "selected",
      repositories: paginate(c, repos),
    });
  });

  app.get("/orgs/:org/repos", (c) => {
    const org = store.user(c.req.param("org") ?? "");
    if (org?.type !== "Organization") throw new HttpError(404, "Not Found");
    return c.json(
      paginate(
        c,
        visibleRepos(c, store, (r) => r.owner.toLowerCase() === org.login.toLowerCase()),
      ),
    );
  });

  app.get("/users/:login/repos", (c) => {
    const u = store.user(c.req.param("login") ?? "");
    if (!u) throw new HttpError(404, "Not Found");
    return c.json(
      paginate(
        c,
        visibleRepos(c, store, (r) => r.owner.toLowerCase() === u.login.toLowerCase()),
      ),
    );
  });

  app.post("/user/repos", (c) => createRepoRoute(c, ctx, requireLogin(c)));

  app.post("/orgs/:org/repos", (c) => {
    const org = store.user(c.req.param("org") ?? "");
    if (org?.type !== "Organization") throw new HttpError(404, "Not Found");
    return createRepoRoute(c, ctx, org.login);
  });

  app.get("/repos/:owner/:repo", (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    return c.json(store.repoJson(repo, c.get("auth").subject));
  });

  app.patch("/repos/:owner/:repo", async (c) => {
    const repo = requireRepo(c, store, "administration", "write");
    const body = await readJson(c);
    const desc = str(body, "description");
    if (desc !== undefined) repo.description = desc;
    const priv = bool(body, "private");
    if (priv !== undefined) repo.private = priv;
    const def = str(body, "default_branch");
    if (def !== undefined) {
      if (!(await repo.git.revParse(`refs/heads/${def}`)))
        throw new HttpError(422, "Branch does not exist");
      repo.defaultBranch = def;
      await repo.git.setHead(def);
    }
    repo.updatedAt = store.clock.nowIso();
    return c.json(store.repoJson(repo, c.get("auth").subject));
  });

  app.delete("/repos/:owner/:repo", async (c) => {
    const repo = requireRepo(c, store, "administration", "write");
    const auth = c.get("auth");
    if (auth.token?.kind === "classic" && !auth.token.scopes.includes("delete_repo")) {
      throw new HttpError(403, "Must have admin rights to Repository.");
    }
    await ops.deleteRepo(repo);
    return c.body(null, 204);
  });

  // ---- branches and refs ---------------------------------------------------------------------
  app.get("/repos/:owner/:repo/branches", async (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const branches = (await repo.git.branches()).sort((a, b) => a.name.localeCompare(b.name));
    return c.json(
      paginate(
        c,
        branches.map((b) => store.branchJson(repo, b.name, b.sha)),
      ),
    );
  });

  app.get("/repos/:owner/:repo/branches/*", async (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const name = wildcardPath(c, "/branches/");
    const sha = await repo.git.revParse(`refs/heads/${name}`);
    if (!sha) throw new HttpError(404, "Branch not found");
    const info = await repo.git.commit(sha);
    return c.json({
      ...store.branchJson(repo, name, sha),
      commit: info ? store.commitJson(repo, info) : { sha },
      _links: { html: `${store.baseUrl}/${repo.fullName}/tree/${name}` },
    });
  });

  const listRefs = async (c: HostContext, prefix: string) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const refs = (await repo.git.refs()).filter((r) => r.ref.startsWith(prefix));
    return c.json(refs.map((r) => store.refJson(repo, r.ref, r.sha)));
  };

  app.get("/repos/:owner/:repo/git/refs", (c) => listRefs(c, "refs/"));

  app.get("/repos/:owner/:repo/git/refs/*", async (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const rest = wildcardPath(c, "/git/refs/");
    const refs = await repo.git.refs();
    const exact = refs.find((r) => r.ref === `refs/${rest}`);
    if (exact) return c.json(store.refJson(repo, exact.ref, exact.sha));
    const matching = refs.filter((r) => r.ref.startsWith(`refs/${rest}`));
    if (matching.length === 0) throw new HttpError(404, "Not Found");
    return c.json(matching.map((r) => store.refJson(repo, r.ref, r.sha)));
  });

  app.get("/repos/:owner/:repo/git/ref/*", async (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const rest = wildcardPath(c, "/git/ref/");
    const match = (await repo.git.refs()).find((r) => r.ref === `refs/${rest}`);
    if (!match) throw new HttpError(404, "Not Found");
    return c.json(store.refJson(repo, match.ref, match.sha));
  });

  app.post("/repos/:owner/:repo/git/refs", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const body = await readJson(c);
    const ref = requireStr(body, "ref", "Reference");
    const sha = requireStr(body, "sha", "Reference");
    await ops.setRef(repo, ref, sha, requireLogin(c), { mustNotExist: true });
    const resolved = (await repo.git.revParse(ref)) ?? sha;
    return c.json(store.refJson(repo, ref, resolved), 201);
  });

  app.patch("/repos/:owner/:repo/git/refs/*", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const ref = `refs/${wildcardPath(c, "/git/refs/")}`;
    const body = await readJson(c);
    const sha = requireStr(body, "sha", "Reference");
    await ops.setRef(repo, ref, sha, requireLogin(c), {
      force: bool(body, "force") ?? false,
      mustExist: true,
    });
    return c.json(store.refJson(repo, ref, (await repo.git.revParse(ref)) ?? sha));
  });

  app.delete("/repos/:owner/:repo/git/refs/*", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const ref = `refs/${wildcardPath(c, "/git/refs/")}`;
    await ops.setRef(repo, ref, null, requireLogin(c));
    return c.body(null, 204);
  });

  // ---- commits -------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/commits", async (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    const start = c.req.query("sha") ?? repo.defaultBranch;
    const sha = await repo.git.revParse(start);
    if (!sha) {
      if ((await repo.git.branches()).length === 0)
        throw new HttpError(409, "Git Repository is empty.");
      throw new HttpError(404, "Not Found");
    }
    const path = c.req.query("path");
    const commits = await repo.git.log(path ? [sha, "--", path] : [sha], 250);
    return c.json(
      paginate(
        c,
        commits.map((info) => store.commitJson(repo, info)),
      ),
    );
  });

  // `/repos/:owner/:repo/commits/<ref>` (refs may contain slashes) is served by the wildcard
  // dispatcher in routes-checks.ts, which calls commitDetail().

  // ---- contents ------------------------------------------------------------------------------
  const getContents = async (c: HostContext) => {
    const repo = requireRepo(c, store, "contents", "read");
    const path = wildcardPath(c, "/contents");
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const commit = await repo.git.revParse(ref);
    if (!commit) throw new HttpError(404, "Not Found");
    const type = await repo.git.entryType(commit, path);
    if (type === "blob") {
      const blob = await repo.git.readBlob(commit, path);
      if (!blob) throw new HttpError(404, "Not Found");
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/vnd.github.raw")) {
        return c.body(new Uint8Array(blob.content), 200, {
          "Content-Type": "application/vnd.github.raw",
        });
      }
      return c.json(store.fileJson(repo, path, ref, blob, "file"));
    }
    if (type === "tree") {
      const entries = (await repo.git.listTree(commit, path)) ?? [];
      return c.json(
        entries
          .map((e) =>
            store.fileJson(
              repo,
              path ? `${path}/${e.name}` : e.name,
              ref,
              e.type === "blob" ? { sha: e.sha, size: e.size, content: Buffer.alloc(0) } : null,
              e.type === "blob" ? "file" : "dir",
            ),
          )
          .map((j) => {
            const copy: Json = { ...j };
            delete copy.content;
            delete copy.encoding;
            return copy;
          }),
      );
    }
    throw new HttpError(404, "Not Found");
  };
  app.get("/repos/:owner/:repo/contents", getContents);
  app.get("/repos/:owner/:repo/contents/*", getContents);

  app.put("/repos/:owner/:repo/contents/*", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const path = wildcardPath(c, "/contents/");
    if (!path) throw validationFailed([{ resource: "Contents", field: "path", code: "missing" }]);
    const body = await readJson(c);
    const message = requireStr(body, "message", "Contents");
    const contentB64 = str(body, "content");
    if (contentB64 === undefined)
      throw validationFailed([{ resource: "Contents", field: "content", code: "missing_field" }]);
    const branch = str(body, "branch") ?? repo.defaultBranch;
    const parent = await repo.git.revParse(`refs/heads/${branch}`);
    if (!parent && branch !== repo.defaultBranch) throw new HttpError(404, "Branch not found");
    const existing = parent ? await repo.git.readBlob(parent, path) : null;
    const givenSha = str(body, "sha");
    if (existing && !givenSha) {
      throw validationFailed(
        [{ resource: "Contents", field: "sha", code: "missing_field" }],
        'Invalid request.\n\n"sha" wasn\'t supplied.',
      );
    }
    if (existing && givenSha && givenSha !== existing.sha) {
      throw new HttpError(409, `${path} does not match ${givenSha}`);
    }
    if (!existing && givenSha)
      throw new HttpError(422, "Invalid request.\n\nSha does not match the provided path.");
    const content = Buffer.from(contentB64, "base64");
    const sha = await ops.commitFiles(repo, branch, { [path]: content }, message, login);
    const blob = await repo.git.readBlob(sha, path);
    const info = await repo.git.commit(sha);
    return c.json(
      {
        content: store.fileJson(repo, path, branch, blob, "file"),
        commit: info ? store.commitJson(repo, info) : { sha },
      },
      existing ? 200 : 201,
    );
  });

  app.delete("/repos/:owner/:repo/contents/*", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const path = wildcardPath(c, "/contents/");
    const body = await readJson(c);
    const message = requireStr(body, "message", "Contents");
    const givenSha = requireStr(body, "sha", "Contents");
    const branch = str(body, "branch") ?? repo.defaultBranch;
    const parent = await repo.git.revParse(`refs/heads/${branch}`);
    if (!parent) throw new HttpError(404, "Branch not found");
    const existing = await repo.git.readBlob(parent, path);
    if (!existing) throw new HttpError(404, "Not Found");
    if (existing.sha !== givenSha) throw new HttpError(409, `${path} does not match ${givenSha}`);
    const sha = await ops.commitFiles(repo, branch, { [path]: null }, message, login);
    const info = await repo.git.commit(sha);
    return c.json({ content: null, commit: info ? store.commitJson(repo, info) : { sha } });
  });

  // browser_download_url and raw file urls on the "web" side of the fake host
  app.get("/:owner/:repo/raw/:ref/*", async (c) => {
    const repo = store.repo(c.req.param("owner") ?? "", c.req.param("repo") ?? "");
    if (!repo) throw new HttpError(404, "Not Found");
    guardRepo(c, repo, "contents", "read");
    const ref = c.req.param("ref") ?? repo.defaultBranch;
    const path = wildcardPath(c, `/raw/${ref}/`);
    const commit = await repo.git.revParse(ref);
    const blob = commit ? await repo.git.readBlob(commit, path) : null;
    if (!blob) throw new HttpError(404, "Not Found");
    return c.body(new Uint8Array(blob.content), 200, {
      "Content-Type": "application/octet-stream",
    });
  });
}

/** GET /repos/:owner/:repo/commits/:ref — one commit with stats and files. */
export async function commitDetail(
  c: HostContext,
  store: HostStore,
  ref: string,
): Promise<Response> {
  const repo = requireRepo(c, store, "metadata", "read");
  const sha = await repo.git.revParse(ref);
  if (!sha) throw new HttpError(422, "No commit found for SHA");
  const info = await repo.git.commit(sha);
  if (!info) throw new HttpError(404, "Not Found");
  const parent = info.parents[0];
  const files = parent ? await repo.git.diffFiles(parent, sha) : [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return c.json(
    store.commitJson(repo, info, {
      stats: { additions, deletions, total: additions + deletions },
      files: files.map((f) => fileJsonForDiff(store, repo, sha, f)),
    }),
  );
}

function fileJsonForDiff(
  store: HostStore,
  repo: RepoRecord,
  sha: string,
  f: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    sha: string;
    patch?: string;
    previous_filename?: string;
  },
): Json {
  return {
    sha: f.sha,
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blob_url: `${store.baseUrl}/${repo.fullName}/blob/${sha}/${f.filename}`,
    raw_url: `${store.baseUrl}/${repo.fullName}/raw/${sha}/${f.filename}`,
    contents_url: `${store.baseUrl}/repos/${repo.fullName}/contents/${f.filename}?ref=${sha}`,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
    ...(f.previous_filename !== undefined ? { previous_filename: f.previous_filename } : {}),
  };
}

export { fileJsonForDiff };
