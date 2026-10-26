import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGitHost,
  type HostEvent,
  type IssuedToken,
  locateHttpBackend,
  signPayload,
} from "../src/githost/index.ts";

type Json = Record<string, unknown>;

interface ApiResponse {
  status: number;
  headers: Headers;
  json: Json;
  list: Json[];
  text: string;
}

async function api(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "forerunner-test",
    ...(opts.headers ?? {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.raw
      ? Buffer.from(opts.raw)
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    headers: res.headers,
    json: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {},
    list: Array.isArray(parsed) ? (parsed as Json[]) : [],
    text,
  };
}

/** A tiny receiver for webhook deliveries. */
async function startReceiver(): Promise<{
  url: string;
  received: Array<{ headers: Record<string, string>; body: string }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ headers: Record<string, string>; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
      received.push({ headers, body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = addr && typeof addr !== "string" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected a value");
  return v;
}

function fakeJwt(iss: string | number, exp?: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss, iat: 1, exp: exp ?? 4_000_000_000 })}.signature`;
}

const gitEnv = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_NOSYSTEM: "1" };
const gitUser = [
  "-c",
  "user.name=Alice Tester",
  "-c",
  "user.email=alice@example.test",
  "-c",
  "credential.helper=",
];

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(["git", ...gitUser, ...args], { cwd, env: { ...process.env, ...gitEnv } });
  return r.stdout.trim();
}

describe("FakeGitHost", () => {
  let root: string;
  let host: FakeGitHost;
  let base: string;
  let alice: IssuedToken;
  let clock: SimulatedClock;
  const repoName = "demo";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fr-githost-"));
    clock = new SimulatedClock("2026-03-01T09:00:00.000Z");
    host = await FakeGitHost.start({ rootDir: root, clock });
    base = host.baseUrl;
    host.createUser({ login: "alice", name: "Alice", email: "alice@example.test" });
    host.createUser({ login: "bob", name: "Bob", email: "bob@example.test" });
    host.createOrg({ login: "acme", members: ["alice"] });
    alice = host.createToken({
      owner: "alice",
      kind: "classic",
      scopes: ["repo", "admin:repo_hook", "project"],
    });
    await host.createRepo({
      owner: "alice",
      name: repoName,
      private: true,
      initialFiles: { "README.md": "# demo\n", "src/app.ts": "export const v = 1;\n" },
    });
  });

  afterAll(async () => {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });

  const eventsOf = (name: string, action?: string): HostEvent[] =>
    host.events().filter((e) => e.event === name && (action === undefined || e.action === action));

  describe("authentication and users", () => {
    it("GET /user returns the token owner and X-OAuth-Scopes for classic tokens", async () => {
      const res = await api(base, "GET", "/user", { token: alice.token });
      expect(res.status).toBe(200);
      expect(res.json.login).toBe("alice");
      expect(res.json.type).toBe("User");
      expect(typeof res.json.id).toBe("number");
      expect(typeof res.json.node_id).toBe("string");
      expect(res.headers.get("x-oauth-scopes")).toBe("repo, admin:repo_hook, project");
      expect(res.headers.get("x-ratelimit-limit")).toBe("5000");
    });

    it("rejects unknown tokens with 401 Bad credentials and requires auth for /user", async () => {
      const bad = await api(base, "GET", "/user", { token: `ghp_${"x".repeat(36)}` }); // not-a-secret
      expect(bad.status).toBe(401);
      expect(bad.json.message).toBe("Bad credentials");
      const anon = await api(base, "GET", "/user");
      expect(anon.status).toBe(401);
      expect(anon.json.message).toBe("Requires authentication");
    });

    it("accepts token and Basic schemes like GitHub", async () => {
      const viaToken = await api(base, "GET", "/user", {
        headers: { Authorization: `token ${alice.token}` },
      });
      expect(viaToken.status).toBe(200);
      const basic = Buffer.from(`x-access-token:${alice.token}`).toString("base64");
      const viaBasic = await api(base, "GET", "/user", {
        headers: { Authorization: `Basic ${basic}` },
      });
      expect(viaBasic.status).toBe(200);
    });
  });

  describe("repositories", () => {
    it("serves the seeded repo in GitHub's shape", async () => {
      const res = await api(base, "GET", `/repos/alice/${repoName}`, { token: alice.token });
      expect(res.status).toBe(200);
      expect(res.json.full_name).toBe(`alice/${repoName}`);
      expect(res.json.private).toBe(true);
      expect(res.json.default_branch).toBe("main");
      expect(res.json.html_url).toBe(`${base}/alice/${repoName}`);
      expect(res.json.clone_url).toBe(`${base}/alice/${repoName}.git`);
      expect((res.json.owner as Json).login).toBe("alice");
      expect((res.json.permissions as Json).push).toBe(true);
      const list = await api(base, "GET", "/user/repos", { token: alice.token });
      expect(list.list.map((r) => r.full_name)).toContain(`alice/${repoName}`);
    });

    it("creates repos through POST /user/repos and /orgs/:org/repos with auto_init", async () => {
      const created = await api(base, "POST", "/user/repos", {
        token: alice.token,
        body: { name: "made-by-api", private: false, auto_init: true, description: "hello" },
      });
      expect(created.status).toBe(201);
      expect(created.json.full_name).toBe("alice/made-by-api");
      const branches = await api(base, "GET", "/repos/alice/made-by-api/branches", {
        token: alice.token,
      });
      expect(branches.list.map((b) => b.name)).toEqual(["main"]);
      const readme = await api(base, "GET", "/repos/alice/made-by-api/contents/README.md", {
        token: alice.token,
      });
      expect(Buffer.from(String(readme.json.content), "base64").toString("utf8")).toContain(
        "# made-by-api",
      );
      const dup = await api(base, "POST", "/user/repos", {
        token: alice.token,
        body: { name: "made-by-api" },
      });
      expect(dup.status).toBe(422);
      const org = await api(base, "POST", "/orgs/acme/repos", {
        token: alice.token,
        body: { name: "org-repo", private: true },
      });
      expect(org.status).toBe(201);
      expect(org.json.full_name).toBe("acme/org-repo");
      const orgList = await api(base, "GET", "/orgs/acme/repos", { token: alice.token });
      expect(orgList.list.map((r) => r.name)).toEqual(["org-repo"]);
    });

    it("lists branches, refs and commits and paginates with a Link header", async () => {
      await host.seedCommit(`alice/${repoName}`, { "docs/a.md": "a\n" }, "docs: a", "feature/docs");
      const refs = await api(base, "GET", `/repos/alice/${repoName}/git/refs/heads`, {
        token: alice.token,
      });
      expect(refs.list.map((r) => r.ref).sort()).toEqual([
        "refs/heads/feature/docs",
        "refs/heads/main",
      ]);
      const one = await api(base, "GET", `/repos/alice/${repoName}/git/ref/heads/main`, {
        token: alice.token,
      });
      expect(one.status).toBe(200);
      expect((one.json.object as Json).type).toBe("commit");
      const page = await api(base, "GET", `/repos/alice/${repoName}/branches?per_page=1`, {
        token: alice.token,
      });
      expect(page.list).toHaveLength(1);
      expect(page.headers.get("link")).toContain('rel="next"');
      const commits = await api(base, "GET", `/repos/alice/${repoName}/commits?sha=feature/docs`, {
        token: alice.token,
      });
      expect(commits.status).toBe(200);
      expect((must(commits.list[0]).commit as Json).message).toBe("docs: a");
      const single = await api(base, "GET", `/repos/alice/${repoName}/commits/feature/docs`, {
        token: alice.token,
      });
      expect((single.json.files as Json[]).map((f) => f.filename)).toEqual(["docs/a.md"]);
      const encoded = await api(
        base,
        "GET",
        `/repos/alice/${repoName}/commits/${encodeURIComponent("feature/docs")}`,
        { token: alice.token },
      );
      expect(encoded.json.sha).toBe(single.json.sha);
    });

    it("creates and deletes refs through the git refs API with create/delete events", async () => {
      const main = await api(base, "GET", `/repos/alice/${repoName}/branches/main`, {
        token: alice.token,
      });
      const sha = String((main.json.commit as Json).sha);
      const created = await api(base, "POST", `/repos/alice/${repoName}/git/refs`, {
        token: alice.token,
        body: { ref: "refs/heads/via-api", sha },
      });
      expect(created.status).toBe(201);
      expect(created.json.ref).toBe("refs/heads/via-api");
      expect(eventsOf("create").some((e) => e.payload.ref === "via-api")).toBe(true);
      const dup = await api(base, "POST", `/repos/alice/${repoName}/git/refs`, {
        token: alice.token,
        body: { ref: "refs/heads/via-api", sha },
      });
      expect(dup.status).toBe(422);
      const del = await api(base, "DELETE", `/repos/alice/${repoName}/git/refs/heads/via-api`, {
        token: alice.token,
      });
      expect(del.status).toBe(204);
      expect(eventsOf("delete").some((e) => e.payload.ref === "via-api")).toBe(true);
      const gone = await api(base, "GET", `/repos/alice/${repoName}/git/ref/heads/via-api`, {
        token: alice.token,
      });
      expect(gone.status).toBe(404);
    });
  });

  describe("contents API", () => {
    it("reads a file at a ref as base64 and lists directories", async () => {
      const file = await api(base, "GET", `/repos/alice/${repoName}/contents/src/app.ts?ref=main`, {
        token: alice.token,
      });
      expect(file.status).toBe(200);
      expect(file.json.type).toBe("file");
      expect(file.json.encoding).toBe("base64");
      expect(Buffer.from(String(file.json.content), "base64").toString("utf8")).toBe(
        "export const v = 1;\n",
      );
      expect(String(file.json.sha)).toMatch(/^[0-9a-f]{40}$/);
      const dir = await api(base, "GET", `/repos/alice/${repoName}/contents/src`, {
        token: alice.token,
      });
      expect(dir.list.map((e) => e.path)).toEqual(["src/app.ts"]);
      const root = await api(base, "GET", `/repos/alice/${repoName}/contents`, {
        token: alice.token,
      });
      expect(root.list.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
      const missing = await api(base, "GET", `/repos/alice/${repoName}/contents/nope.txt`, {
        token: alice.token,
      });
      expect(missing.status).toBe(404);
      const raw = await api(base, "GET", `/repos/alice/${repoName}/contents/README.md`, {
        token: alice.token,
        headers: { Accept: "application/vnd.github.raw" },
      });
      expect(raw.text).toBe("# demo\n");
    });

    it("creates and updates files with commits, refusing stale shas", async () => {
      const create = await api(base, "PUT", `/repos/alice/${repoName}/contents/notes/todo.md`, {
        token: alice.token,
        body: {
          message: "add todo",
          content: Buffer.from("- one\n").toString("base64"),
          branch: "main",
        },
      });
      expect(create.status).toBe(201);
      const sha = String((create.json.content as Json).sha);
      expect((create.json.commit as Json).sha).toMatch(/^[0-9a-f]{40}$/);
      const noSha = await api(base, "PUT", `/repos/alice/${repoName}/contents/notes/todo.md`, {
        token: alice.token,
        body: { message: "x", content: Buffer.from("- two\n").toString("base64") },
      });
      expect(noSha.status).toBe(422);
      const stale = await api(base, "PUT", `/repos/alice/${repoName}/contents/notes/todo.md`, {
        token: alice.token,
        body: {
          message: "x",
          content: Buffer.from("- two\n").toString("base64"),
          sha: "0".repeat(40),
        },
      });
      expect(stale.status).toBe(409);
      const update = await api(base, "PUT", `/repos/alice/${repoName}/contents/notes/todo.md`, {
        token: alice.token,
        body: {
          message: "update todo",
          content: Buffer.from("- one\n- two\n").toString("base64"),
          sha,
        },
      });
      expect(update.status).toBe(200);
      const after = await api(base, "GET", `/repos/alice/${repoName}/contents/notes/todo.md`, {
        token: alice.token,
      });
      expect(Buffer.from(String(after.json.content), "base64").toString("utf8")).toBe(
        "- one\n- two\n",
      );
      const pushes = eventsOf("push").filter((e) => e.payload.ref === "refs/heads/main");
      const last = pushes[pushes.length - 1];
      expect(last).toBeDefined();
      expect((must(last).payload.head_commit as Json).message).toBe("update todo");
      expect(must((must(last).payload.commits as Json[])[0]).modified).toEqual(["notes/todo.md"]);
    });
  });

  describe("pull requests", () => {
    it("opens a PR, reports mergeability and files, and merges with a merge commit", async () => {
      await host.seedCommit(
        `alice/${repoName}`,
        { "src/feature.ts": "export const f = 2;\n" },
        "feat: f",
        "feature/one",
      );
      const opened = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Feature one", body: "Adds f", head: "feature/one", base: "main" },
      });
      expect(opened.status).toBe(201);
      const number = Number(opened.json.number);
      expect(number).toBeGreaterThan(0);
      expect(opened.json.state).toBe("open");
      expect((opened.json.head as Json).ref).toBe("feature/one");
      expect(opened.json.html_url).toBe(`${base}/alice/${repoName}/pull/${number}`);
      expect(eventsOf("pull_request", "opened")).toHaveLength(1);

      const pr = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}`, {
        token: alice.token,
      });
      expect(pr.json.mergeable).toBe(true);
      expect(pr.json.mergeable_state).toBe("clean");
      expect(pr.json.changed_files).toBe(1);
      expect(pr.json.commits).toBe(1);

      const files = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}/files`, {
        token: alice.token,
      });
      expect(files.list).toHaveLength(1);
      expect(files.list[0]?.filename).toBe("src/feature.ts");
      expect(files.list[0]?.status).toBe("added");
      expect(files.list[0]?.additions).toBe(1);
      expect(String(files.list[0]?.patch)).toContain("+export const f = 2;");

      const dup = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "again", head: "feature/one", base: "main" },
      });
      expect(dup.status).toBe(422);

      const merged = await api(base, "PUT", `/repos/alice/${repoName}/pulls/${number}/merge`, {
        token: alice.token,
        body: { merge_method: "merge" },
      });
      expect(merged.status).toBe(200);
      expect(merged.json.merged).toBe(true);
      const mergeSha = String(merged.json.sha);
      const afterMerge = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}`, {
        token: alice.token,
      });
      expect(afterMerge.json.merged).toBe(true);
      expect(afterMerge.json.state).toBe("closed");
      expect(afterMerge.json.merge_commit_sha).toBe(mergeSha);
      const head = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      expect(head.json.sha).toBe(mergeSha);
      expect(head.json.parents as Json[]).toHaveLength(2);
      const closed = eventsOf("pull_request", "closed");
      expect((must(closed[closed.length - 1]).payload.pull_request as Json).merged).toBe(true);
      const again = await api(base, "PUT", `/repos/alice/${repoName}/pulls/${number}/merge`, {
        token: alice.token,
        body: {},
      });
      expect(again.status).toBe(405);
      const check = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}/merge`, {
        token: alice.token,
      });
      expect(check.status).toBe(204);
    });

    it("reports conflicts as mergeable=false and refuses to merge with 405", async () => {
      // the branch forks from main first, then both sides add conflict.txt differently
      await host.seedCommit(
        `alice/${repoName}`,
        { "conflict.txt": "branch version\n" },
        "branch side",
        "feature/conflict",
      );
      await host.seedCommit(
        `alice/${repoName}`,
        { "conflict.txt": "main version\n" },
        "main side",
        "main",
      );
      const opened = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Conflicting", head: "feature/conflict", base: "main" },
      });
      expect(opened.status).toBe(201);
      const number = Number(opened.json.number);
      const pr = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}`, {
        token: alice.token,
      });
      expect(pr.json.mergeable).toBe(false);
      expect(pr.json.mergeable_state).toBe("dirty");
      const merge = await api(base, "PUT", `/repos/alice/${repoName}/pulls/${number}/merge`, {
        token: alice.token,
        body: { merge_method: "squash" },
      });
      expect(merge.status).toBe(405);
      expect(merge.json.message).toBe("Pull Request is not mergeable");
      // resolving the conflict on the branch (a new push to the PR head) makes it mergeable again
      await host.seedCommit(
        `alice/${repoName}`,
        { "conflict.txt": "main version\n" },
        "resolve",
        "feature/conflict",
      );
      const synced = eventsOf("pull_request", "synchronize").filter(
        (e) => e.payload.number === number,
      );
      expect(synced).toHaveLength(1);
      const fixed = await api(base, "GET", `/repos/alice/${repoName}/pulls/${number}`, {
        token: alice.token,
      });
      expect(fixed.json.mergeable).toBe(true);
      expect((fixed.json.head as Json).sha).toBe(synced[0]?.payload.after);
    });

    it("supports squash and rebase merges", async () => {
      await host.seedCommit(`alice/${repoName}`, { "sq/1.txt": "1\n" }, "sq one", "feature/squash");
      await host.seedCommit(`alice/${repoName}`, { "sq/2.txt": "2\n" }, "sq two", "feature/squash");
      const sq = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Squash me", body: "two commits", head: "feature/squash", base: "main" },
      });
      const before = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      const squashed = await api(
        base,
        "PUT",
        `/repos/alice/${repoName}/pulls/${sq.json.number}/merge`,
        {
          token: alice.token,
          body: { merge_method: "squash" },
        },
      );
      expect(squashed.status).toBe(200);
      const tip = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      expect(tip.json.sha).toBe(squashed.json.sha);
      expect((tip.json.parents as Json[]).map((p) => p.sha)).toEqual([before.json.sha]);
      expect((tip.json.commit as Json).message).toBe(
        `Squash me (#${sq.json.number})\n\ntwo commits`,
      );
      expect((tip.json.files as Json[]).map((f) => f.filename).sort()).toEqual([
        "sq/1.txt",
        "sq/2.txt",
      ]);

      await host.seedCommit(`alice/${repoName}`, { "rb/1.txt": "1\n" }, "rb one", "feature/rebase");
      await host.seedCommit(`alice/${repoName}`, { "rb/2.txt": "2\n" }, "rb two", "feature/rebase");
      await host.seedCommit(
        `alice/${repoName}`,
        { "main-moves.txt": "x\n" },
        "main moves on",
        "main",
      );
      const rb = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Rebase me", head: "feature/rebase", base: "main" },
      });
      const mainBefore = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      const rebased = await api(
        base,
        "PUT",
        `/repos/alice/${repoName}/pulls/${rb.json.number}/merge`,
        {
          token: alice.token,
          body: { merge_method: "rebase" },
        },
      );
      expect(rebased.status).toBe(200);
      const log = await api(base, "GET", `/repos/alice/${repoName}/commits?sha=main&per_page=3`, {
        token: alice.token,
      });
      expect(log.list.map((c) => (c.commit as Json).message)).toEqual([
        "rb two",
        "rb one",
        "main moves on",
      ]);
      expect(log.list.every((c) => (c.parents as Json[]).length === 1)).toBe(true);
      expect((log.list[2] as Json).sha).toBe(mainBefore.json.sha);
    });

    it("lists PRs by state and head, edits them and records reviews", async () => {
      await host.seedCommit(
        `alice/${repoName}`,
        { "rv.txt": "r\n" },
        "review me",
        "feature/review",
      );
      const opened = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Review", head: "feature/review", base: "main", draft: true },
      });
      const n = Number(opened.json.number);
      expect(opened.json.draft).toBe(true);
      const byHead = await api(
        base,
        "GET",
        `/repos/alice/${repoName}/pulls?head=alice:feature/review`,
        { token: alice.token },
      );
      expect(byHead.list.map((p) => p.number)).toEqual([n]);
      const closedList = await api(base, "GET", `/repos/alice/${repoName}/pulls?state=closed`, {
        token: alice.token,
      });
      expect(closedList.list.length).toBeGreaterThanOrEqual(3);
      const review = await api(base, "POST", `/repos/alice/${repoName}/pulls/${n}/reviews`, {
        token: alice.token,
        body: { event: "APPROVE", body: "LGTM" },
      });
      expect(review.status).toBe(200);
      expect(review.json.state).toBe("APPROVED");
      const reviews = await api(base, "GET", `/repos/alice/${repoName}/pulls/${n}/reviews`, {
        token: alice.token,
      });
      expect(reviews.list).toHaveLength(1);
      expect(eventsOf("pull_request_review", "submitted")).toHaveLength(1);
      const edited = await api(base, "PATCH", `/repos/alice/${repoName}/pulls/${n}`, {
        token: alice.token,
        body: { title: "Review (renamed)", state: "closed" },
      });
      expect(edited.json.title).toBe("Review (renamed)");
      expect(edited.json.state).toBe("closed");
      expect(edited.json.merged).toBe(false);
    });

    it("updates a PR branch with the base branch", async () => {
      await host.seedCommit(
        `alice/${repoName}`,
        { "ub/branch.txt": "b\n" },
        "ub branch",
        "feature/update",
      );
      await host.seedCommit(`alice/${repoName}`, { "ub/main.txt": "m\n" }, "ub main", "main");
      const opened = await api(base, "POST", `/repos/alice/${repoName}/pulls`, {
        token: alice.token,
        body: { title: "Update branch", head: "feature/update", base: "main" },
      });
      const n = Number(opened.json.number);
      const res = await api(base, "PUT", `/repos/alice/${repoName}/pulls/${n}/update-branch`, {
        token: alice.token,
        body: {},
      });
      expect(res.status).toBe(202);
      const file = await api(
        base,
        "GET",
        `/repos/alice/${repoName}/contents/ub/main.txt?ref=feature/update`,
        { token: alice.token },
      );
      expect(file.status).toBe(200);
    });
  });

  describe("issues, comments and labels", () => {
    it("creates issues with labels, comments on them and closes them with events", async () => {
      const created = await api(base, "POST", `/repos/alice/${repoName}/issues`, {
        token: alice.token,
        body: { title: "Message from bob", body: "hello", labels: ["message", "bug"] },
      });
      expect(created.status).toBe(201);
      const n = Number(created.json.number);
      expect((created.json.labels as Json[]).map((l) => l.name)).toEqual(["message", "bug"]);
      expect(created.json.html_url).toBe(`${base}/alice/${repoName}/issues/${n}`);
      expect(eventsOf("issues", "opened").some((e) => (e.payload.issue as Json).number === n)).toBe(
        true,
      );

      const comment = await api(base, "POST", `/repos/alice/${repoName}/issues/${n}/comments`, {
        token: alice.token,
        body: { body: "ack" },
      });
      expect(comment.status).toBe(201);
      expect((comment.json.user as Json).login).toBe("alice");
      const comments = await api(base, "GET", `/repos/alice/${repoName}/issues/${n}/comments`, {
        token: alice.token,
      });
      expect(comments.list.map((c) => c.body)).toEqual(["ack"]);
      expect(
        eventsOf("issue_comment", "created").some(
          (e) => (e.payload.comment as Json).body === "ack",
        ),
      ).toBe(true);

      const labeled = await api(base, "POST", `/repos/alice/${repoName}/issues/${n}/labels`, {
        token: alice.token,
        body: { labels: ["urgent"] },
      });
      expect(labeled.list.map((l) => l.name)).toEqual(["message", "bug", "urgent"]);
      const removed = await api(base, "DELETE", `/repos/alice/${repoName}/issues/${n}/labels/bug`, {
        token: alice.token,
      });
      expect(removed.list.map((l) => l.name)).toEqual(["message", "urgent"]);
      const labels = await api(base, "GET", `/repos/alice/${repoName}/labels`, {
        token: alice.token,
      });
      expect(labels.list.map((l) => l.name)).toContain("urgent");
      const newLabel = await api(base, "POST", `/repos/alice/${repoName}/labels`, {
        token: alice.token,
        body: { name: "needs-human", color: "ff0000", description: "waiting" },
      });
      expect(newLabel.status).toBe(201);
      expect(newLabel.json.color).toBe("ff0000");

      const byLabel = await api(base, "GET", `/repos/alice/${repoName}/issues?labels=urgent`, {
        token: alice.token,
      });
      expect(byLabel.list.map((i) => i.number)).toEqual([n]);
      const closed = await api(base, "PATCH", `/repos/alice/${repoName}/issues/${n}`, {
        token: alice.token,
        body: { state: "closed", labels: ["done"] },
      });
      expect(closed.json.state).toBe("closed");
      expect(closed.json.closed_at).toBe(clock.nowIso());
      expect((closed.json.labels as Json[]).map((l) => l.name)).toEqual(["done"]);
      expect(eventsOf("issues", "closed").some((e) => (e.payload.issue as Json).number === n)).toBe(
        true,
      );
      const openOnly = await api(base, "GET", `/repos/alice/${repoName}/issues`, {
        token: alice.token,
      });
      expect(openOnly.list.map((i) => i.number)).not.toContain(n);
    });

    it("exposes PRs through the issues endpoints with a pull_request field and PR comments", async () => {
      const pulls = await api(base, "GET", `/repos/alice/${repoName}/pulls?state=all`, {
        token: alice.token,
      });
      const n = Number(pulls.list[0]?.number);
      const asIssue = await api(base, "GET", `/repos/alice/${repoName}/issues/${n}`, {
        token: alice.token,
      });
      expect(asIssue.status).toBe(200);
      expect((asIssue.json.pull_request as Json).url).toBe(
        `${base}/repos/alice/${repoName}/pulls/${n}`,
      );
      const comment = await api(base, "POST", `/repos/alice/${repoName}/issues/${n}/comments`, {
        token: alice.token,
        body: { body: "PR comment" },
      });
      expect(comment.status).toBe(201);
      expect(String(comment.json.html_url)).toContain(`/pull/${n}#issuecomment-`);
      const all = await api(base, "GET", `/repos/alice/${repoName}/issues?state=all`, {
        token: alice.token,
      });
      expect(all.list.some((i) => i.number === n && i.pull_request)).toBe(true);
    });
  });

  describe("releases", () => {
    it("creates releases with tags, accepts asset uploads with sha256 digests and serves latest/tags", async () => {
      const rel = await api(base, "POST", `/repos/alice/${repoName}/releases`, {
        token: alice.token,
        body: { tag_name: "v1.0.0", name: "Forerunner 1.0", body: "notes" },
      });
      expect(rel.status).toBe(201);
      const id = Number(rel.json.id);
      expect(String(rel.json.upload_url)).toBe(
        `${base}/repos/alice/${repoName}/releases/${id}/assets{?name,label}`,
      );
      const tag = await api(base, "GET", `/repos/alice/${repoName}/git/ref/tags/v1.0.0`, {
        token: alice.token,
      });
      expect(tag.status).toBe(200);
      expect(eventsOf("release", "published")).toHaveLength(1);

      const bytes = Buffer.from("binary-installer-content");
      const asset = await api(
        base,
        "POST",
        `/repos/alice/${repoName}/releases/${id}/assets?name=forerunner.msi`,
        {
          token: alice.token,
          raw: bytes,
          headers: { "Content-Type": "application/octet-stream" },
        },
      );
      expect(asset.status).toBe(201);
      const digest = createHmac("sha256", "").update(bytes).digest("hex");
      expect(String(asset.json.digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(asset.json.digest)).not.toBe(`sha256:${digest}`); // a digest, not an HMAC
      expect(asset.json.size).toBe(bytes.length);
      const download = await fetch(String(asset.json.browser_download_url), {
        headers: { Authorization: `Bearer ${alice.token}` },
      });
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      expect(download.headers.get("x-checksum-sha256")).toBe(
        String(asset.json.digest).slice("sha256:".length),
      );
      const viaApi = await fetch(String(asset.json.url), {
        headers: { Accept: "application/octet-stream", Authorization: `Bearer ${alice.token}` },
      });
      expect(Buffer.from(await viaApi.arrayBuffer())).toEqual(bytes);

      await api(base, "POST", `/repos/alice/${repoName}/releases`, {
        token: alice.token,
        body: { tag_name: "v1.1.0-rc.1", name: "rc", prerelease: true },
      });
      const latest = await api(base, "GET", `/repos/alice/${repoName}/releases/latest`, {
        token: alice.token,
      });
      expect(latest.json.tag_name).toBe("v1.0.0");
      expect((latest.json.assets as Json[]).map((a) => a.name)).toEqual(["forerunner.msi"]);
      const byTag = await api(base, "GET", `/repos/alice/${repoName}/releases/tags/v1.1.0-rc.1`, {
        token: alice.token,
      });
      expect(byTag.json.prerelease).toBe(true);
      const list = await api(base, "GET", `/repos/alice/${repoName}/releases`, {
        token: alice.token,
      });
      expect(list.list).toHaveLength(2);
      const none = await api(base, "GET", "/repos/alice/made-by-api/releases/latest", {
        token: alice.token,
      });
      expect(none.status).toBe(404);
    });
  });

  describe("check runs and statuses", () => {
    it("records check runs per commit and emits check_run events on completion", async () => {
      const main = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      const sha = String(main.json.sha);
      const created = await api(base, "POST", `/repos/alice/${repoName}/check-runs`, {
        token: alice.token,
        body: { name: "ci", head_sha: sha, status: "in_progress", external_id: "run-1" },
      });
      expect(created.status).toBe(201);
      expect(created.json.status).toBe("in_progress");
      const id = Number(created.json.id);
      const done = await api(base, "PATCH", `/repos/alice/${repoName}/check-runs/${id}`, {
        token: alice.token,
        body: {
          status: "completed",
          conclusion: "success",
          output: { title: "ok", summary: "all green" },
        },
      });
      expect(done.json.conclusion).toBe("success");
      expect(done.json.completed_at).toBe(clock.nowIso());
      const list = await api(base, "GET", `/repos/alice/${repoName}/commits/${sha}/check-runs`, {
        token: alice.token,
      });
      expect(list.json.total_count).toBe(1);
      expect((list.json.check_runs as Json[])[0]?.name).toBe("ci");
      const completed = eventsOf("check_run", "completed");
      expect((must(completed[completed.length - 1]).payload.check_run as Json).id).toBe(id);
      const bad = await api(base, "POST", `/repos/alice/${repoName}/check-runs`, {
        token: alice.token,
        body: { name: "ci", head_sha: "0".repeat(40) },
      });
      expect(bad.status).toBe(422);
    });

    it("stores commit statuses and computes the combined status", async () => {
      const main = await api(base, "GET", `/repos/alice/${repoName}/commits/main`, {
        token: alice.token,
      });
      const sha = String(main.json.sha);
      const pending = await api(base, "POST", `/repos/alice/${repoName}/statuses/${sha}`, {
        token: alice.token,
        body: { state: "pending", context: "ci/build", description: "building" },
      });
      expect(pending.status).toBe(201);
      const combined1 = await api(base, "GET", `/repos/alice/${repoName}/commits/${sha}/status`, {
        token: alice.token,
      });
      expect(combined1.json.state).toBe("pending");
      await api(base, "POST", `/repos/alice/${repoName}/statuses/${sha}`, {
        token: alice.token,
        body: { state: "success", context: "ci/build", target_url: "http://ci.local/1" },
      });
      const combined2 = await api(base, "GET", `/repos/alice/${repoName}/commits/${sha}/status`, {
        token: alice.token,
      });
      expect(combined2.json.state).toBe("success");
      expect(combined2.json.total_count).toBe(1);
      const list = await api(base, "GET", `/repos/alice/${repoName}/commits/${sha}/statuses`, {
        token: alice.token,
      });
      expect(list.list).toHaveLength(2);
      expect(eventsOf("status").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("webhooks", () => {
    it("delivers ping and subscribed events with X-GitHub-Event and a valid HMAC signature", async () => {
      const receiver = await startReceiver();
      try {
        const hook = await api(base, "POST", `/repos/alice/${repoName}/hooks`, {
          token: alice.token,
          body: {
            name: "web",
            active: true,
            events: ["issues", "push"],
            config: { url: receiver.url, content_type: "json", secret: "hush" },
          },
        });
        expect(hook.status).toBe(201);
        expect((hook.json.config as Json).secret).toBe("********");
        const issue = await api(base, "POST", `/repos/alice/${repoName}/issues`, {
          token: alice.token,
          body: { title: "hooked", body: "" },
        });
        await api(base, "POST", `/repos/alice/${repoName}/issues/${issue.json.number}/comments`, {
          token: alice.token,
          body: { body: "not subscribed" },
        });
        await host.settle();
        const events = receiver.received.map((r) => r.headers["x-github-event"]);
        expect(events).toEqual(["ping", "issues"]);
        const delivery = receiver.received[1];
        expect(delivery).toBeDefined();
        if (!delivery) return;
        expect(delivery.headers["x-hub-signature-256"]).toBe(
          signPayload("hush", delivery.body, "sha256"),
        );
        expect(delivery.headers["x-github-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(delivery.headers["content-type"]).toBe("application/json");
        const payload = JSON.parse(delivery.body) as Json;
        expect(payload.action).toBe("opened");
        expect((payload.repository as Json).full_name).toBe(`alice/${repoName}`);
        expect((payload.sender as Json).login).toBe("alice");
        const recorded = host.deliveries().filter((d) => d.hookId === hook.json.id);
        expect(recorded.map((d) => d.status)).toEqual(["delivered", "delivered"]);
        expect(recorded[1]?.responseStatus).toBe(204);
        const listed = await api(
          base,
          "GET",
          `/repos/alice/${repoName}/hooks/${hook.json.id}/deliveries`,
          { token: alice.token },
        );
        expect(listed.list).toHaveLength(2);
        await api(base, "DELETE", `/repos/alice/${repoName}/hooks/${hook.json.id}`, {
          token: alice.token,
        });
      } finally {
        await receiver.close();
      }
    });

    it("records failed deliveries without throwing", async () => {
      const hook = await api(base, "POST", `/repos/alice/${repoName}/hooks`, {
        token: alice.token,
        body: { config: { url: "http://127.0.0.1:1/unreachable" }, events: ["*"] },
      });
      await host.settle();
      const failed = host.deliveries().filter((d) => d.hookId === hook.json.id);
      expect(failed[0]?.status).toBe("failed");
      expect(failed[0]?.error).toBeTruthy();
      await api(base, "DELETE", `/repos/alice/${repoName}/hooks/${hook.json.id}`, {
        token: alice.token,
      });
    });
  });

  describe("token scopes and permissions", () => {
    it("hides private repos from classic tokens without the repo scope and keeps public repos readable", async () => {
      const noScopes = host.createToken({ owner: "alice", kind: "classic", scopes: [] });
      const hidden = await api(base, "GET", `/repos/alice/${repoName}`, { token: noScopes.token });
      expect(hidden.status).toBe(404);
      const pub = await api(base, "GET", "/repos/alice/made-by-api", { token: noScopes.token });
      expect(pub.status).toBe(200);
      expect((pub.json.permissions as Json).push).toBe(false);
      const write = await api(base, "POST", "/repos/alice/made-by-api/issues", {
        token: noScopes.token,
        body: { title: "x" },
      });
      expect(write.status).toBe(403);
      const withPublic = host.createToken({
        owner: "alice",
        kind: "classic",
        scopes: ["public_repo"],
      });
      const ok = await api(base, "POST", "/repos/alice/made-by-api/issues", {
        token: withPublic.token,
        body: { title: "x" },
      });
      expect(ok.status).toBe(201);
      const stillHidden = await api(base, "GET", `/repos/alice/${repoName}`, {
        token: withPublic.token,
      });
      expect(stillHidden.status).toBe(404);
      const hooks = await api(base, "GET", "/repos/alice/made-by-api/hooks", {
        token: withPublic.token,
      });
      expect(hooks.status).toBe(403);
    });

    it("enforces fine-grained allowlists (404) and permission levels (403)", async () => {
      await host.createRepo({
        owner: "alice",
        name: "other",
        private: true,
        initialFiles: { "a.txt": "a\n" },
      });
      const limited = host.createToken({
        owner: "alice",
        kind: "fine_grained",
        permissions: { contents: "read", issues: "read" },
        repos: [repoName],
      });
      const inList = await api(base, "GET", `/repos/alice/${repoName}`, { token: limited.token });
      expect(inList.status).toBe(200);
      const outside = await api(base, "GET", "/repos/alice/other", { token: limited.token });
      expect(outside.status).toBe(404);
      expect(outside.json.message).toBe("Not Found");
      const listed = await api(base, "GET", "/user/repos", { token: limited.token });
      expect(listed.list.map((r) => r.full_name)).toEqual([`alice/${repoName}`]);
      const read = await api(base, "GET", `/repos/alice/${repoName}/issues`, {
        token: limited.token,
      });
      expect(read.status).toBe(200);
      const write = await api(base, "POST", `/repos/alice/${repoName}/issues`, {
        token: limited.token,
        body: { title: "x" },
      });
      expect(write.status).toBe(403);
      expect(write.json.message).toBe("Resource not accessible by personal access token");
      const pulls = await api(base, "GET", `/repos/alice/${repoName}/pulls`, {
        token: limited.token,
      });
      expect(pulls.status).toBe(403);
      const contents = await api(base, "PUT", `/repos/alice/${repoName}/contents/x.txt`, {
        token: limited.token,
        body: { message: "m", content: Buffer.from("x").toString("base64") },
      });
      expect(contents.status).toBe(403);
      const noSuchUserRepo = await api(base, "GET", "/repos/nobody/nothing", {
        token: limited.token,
      });
      expect(noSuchUserRepo.status).toBe(404);
      const bobs = host.createToken({ owner: "bob", kind: "classic", scopes: ["repo"] });
      const foreign = await api(base, "GET", `/repos/alice/${repoName}`, { token: bobs.token });
      expect(foreign.status).toBe(404);
      host.addCollaborator(`alice/${repoName}`, "bob");
      const collaborator = await api(base, "GET", `/repos/alice/${repoName}`, {
        token: bobs.token,
      });
      expect(collaborator.status).toBe(200);
    });

    it("issues installation tokens for a GitHub App scoped to the installation", async () => {
      const app = host.createApp({ slug: "forerunner-bot", owner: "alice" });
      const inst = host.createInstallation({
        appId: app.id,
        account: "alice",
        repos: [repoName],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      });
      const denied = await api(base, "POST", `/app/installations/${inst.id}/access_tokens`, {
        token: alice.token,
      });
      expect(denied.status).toBe(401);
      const wrongApp = await fetch(`${base}/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fakeJwt(999999)}`,
          Accept: "application/vnd.github+json",
        },
      });
      expect(wrongApp.status).toBe(401);
      const res = await fetch(`${base}/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fakeJwt(app.id)}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissions: { contents: "read" } }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Json;
      const token = String(body.token);
      expect(token.startsWith("ghs_")).toBe(true);
      expect(body.expires_at).toBe(new Date(clock.now() + 3_600_000).toISOString());
      expect((body.repositories as Json[]).map((r) => r.full_name)).toEqual([`alice/${repoName}`]);
      const repo = await api(base, "GET", `/repos/alice/${repoName}`, { token });
      expect(repo.status).toBe(200);
      const other = await api(base, "GET", "/repos/alice/other", { token });
      expect(other.status).toBe(404);
      const narrowed = await api(base, "PUT", `/repos/alice/${repoName}/contents/bot.txt`, {
        token,
        body: { message: "m", content: Buffer.from("x").toString("base64") },
      });
      expect(narrowed.status).toBe(403);
      expect(narrowed.json.message).toBe("Resource not accessible by integration");
      const installRepos = await api(base, "GET", "/installation/repositories", { token });
      expect(installRepos.json.total_count).toBe(1);
      const tooMuch = await fetch(`${base}/app/installations/${inst.id}/access_tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fakeJwt(app.id)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { issues: "write" } }),
      });
      expect(tooMuch.status).toBe(422);
      await clock.advance(3_600_000 + 1);
      const expired = await api(base, "GET", `/repos/alice/${repoName}`, { token });
      expect(expired.status).toBe(401);
    });
  });

  describe("projects (classic)", () => {
    it("creates projects, columns and cards and moves cards between columns", async () => {
      const project = await api(base, "POST", `/repos/alice/${repoName}/projects`, {
        token: alice.token,
        body: { name: "Forerunner board", body: "mirror" },
      });
      expect(project.status).toBe(201);
      const pid = Number(project.json.id);
      expect(project.json.columns_url).toBe(`${base}/projects/${pid}/columns`);
      const todo = await api(base, "POST", `/projects/${pid}/columns`, {
        token: alice.token,
        body: { name: "To do" },
      });
      const doing = await api(base, "POST", `/projects/${pid}/columns`, {
        token: alice.token,
        body: { name: "In progress" },
      });
      expect(todo.status).toBe(201);
      const cols = await api(base, "GET", `/projects/${pid}/columns`, { token: alice.token });
      expect(cols.list.map((c) => c.name)).toEqual(["To do", "In progress"]);
      const issue = await api(base, "POST", `/repos/alice/${repoName}/issues`, {
        token: alice.token,
        body: { title: "task A" },
      });
      const card = await api(base, "POST", `/projects/columns/${todo.json.id}/cards`, {
        token: alice.token,
        body: { content_id: issue.json.id, content_type: "Issue" },
      });
      expect(card.status).toBe(201);
      expect(card.json.content_url).toBe(
        `${base}/repos/alice/${repoName}/issues/${issue.json.number}`,
      );
      const note = await api(base, "POST", `/projects/columns/${todo.json.id}/cards`, {
        token: alice.token,
        body: { note: "free text" },
      });
      expect(note.status).toBe(201);
      const moved = await api(base, "POST", `/projects/columns/cards/${card.json.id}/moves`, {
        token: alice.token,
        body: { position: "top", column_id: doing.json.id },
      });
      expect(moved.status).toBe(201);
      const inDoing = await api(base, "GET", `/projects/columns/${doing.json.id}/cards`, {
        token: alice.token,
      });
      expect(inDoing.list.map((c) => c.id)).toEqual([card.json.id]);
      const patched = await api(base, "PATCH", `/projects/columns/cards/${note.json.id}`, {
        token: alice.token,
        body: { column_id: doing.json.id, note: "edited" },
      });
      expect(patched.json.column_url).toBe(`${base}/projects/columns/${doing.json.id}`);
      const inTodo = await api(base, "GET", `/projects/columns/${todo.json.id}/cards`, {
        token: alice.token,
      });
      expect(inTodo.list).toHaveLength(0);
      const listed = await api(base, "GET", `/repos/alice/${repoName}/projects`, {
        token: alice.token,
      });
      expect(listed.list.map((p) => p.name)).toEqual(["Forerunner board"]);
      const noProject = host.createToken({
        owner: "alice",
        kind: "fine_grained",
        permissions: { contents: "read" },
        repos: [repoName],
      });
      const denied = await api(base, "GET", `/projects/${pid}`, { token: noProject.token });
      expect(denied.status).toBe(403);
    });
  });

  describe("request log", () => {
    it("records every request with method, path, status and token identity but never the token value", async () => {
      await api(base, "GET", "/meta", { token: alice.token });
      const entries = host.requests();
      const last = entries[entries.length - 1];
      expect(last?.method).toBe("GET");
      expect(last?.path).toBe("/meta");
      expect(last?.status).toBe(200);
      expect(last?.auth).toEqual({ kind: "classic", login: "alice", tokenId: alice.id });
      expect(JSON.stringify(entries)).not.toContain(alice.token);
      expect(JSON.stringify(host.events())).not.toContain(alice.token);
    });
  });
});

describe("FakeGitHost rate limiting", () => {
  it("returns 403 with rate-limit headers when exhausted and resets on the clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "fr-githost-rl-"));
    const clock = new SimulatedClock("2026-03-01T09:00:00.000Z");
    const host = await FakeGitHost.start({ rootDir: root, clock, rateLimit: { perHour: 3 } });
    try {
      host.createUser({ login: "alice" });
      const tok = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] });
      const base = host.baseUrl;
      const first = await api(base, "GET", "/user", { token: tok.token });
      expect(first.headers.get("x-ratelimit-limit")).toBe("3");
      expect(first.headers.get("x-ratelimit-remaining")).toBe("2");
      const reset = Number(first.headers.get("x-ratelimit-reset"));
      expect(reset).toBe(Math.floor(clock.now() / 1000) + 3600);
      await api(base, "GET", "/user", { token: tok.token });
      const third = await api(base, "GET", "/user", { token: tok.token });
      expect(third.status).toBe(200);
      expect(third.headers.get("x-ratelimit-remaining")).toBe("0");
      const status = await api(base, "GET", "/rate_limit", { token: tok.token });
      expect(status.status).toBe(200);
      expect((status.json.rate as Json).remaining).toBe(0);
      const blocked = await api(base, "GET", "/user", { token: tok.token });
      expect(blocked.status).toBe(403);
      expect(String(blocked.json.message)).toContain("API rate limit exceeded");
      expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(blocked.headers.get("x-ratelimit-reset")).toBe(String(reset));
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      // another token has its own window
      const other = host.createToken({ owner: "alice", kind: "classic", scopes: [] });
      expect((await api(base, "GET", "/user", { token: other.token })).status).toBe(200);
      await clock.advance(3_600_000);
      const afterReset = await api(base, "GET", "/user", { token: tok.token });
      expect(afterReset.status).toBe(200);
      expect(afterReset.headers.get("x-ratelimit-remaining")).toBe("2");
      expect(Number(afterReset.headers.get("x-ratelimit-reset"))).toBe(reset + 3600);
    } finally {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Resolved at module load so skipIf() can see it when the suite is collected.
const backend = await locateHttpBackend();

describe("FakeGitHost git over HTTP", () => {
  let root: string;
  let work: string;
  let host: FakeGitHost;
  let token: IssuedToken;
  const full = "acme/service";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fr-githost-git-"));
    work = await mkdtemp(join(tmpdir(), "fr-githost-work-"));
    host = await FakeGitHost.start({
      rootDir: root,
      clock: new SimulatedClock("2026-03-01T09:00:00.000Z"),
    });
    host.createUser({ login: "alice", name: "Alice", email: "alice@example.test" });
    host.createUser({ login: "bob" });
    host.createOrg({ login: "acme", members: ["alice"] });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] });
    await host.createRepo({
      owner: "acme",
      name: "service",
      private: true,
      initialFiles: { "README.md": "# service\n" },
    });
  });

  afterAll(async () => {
    await host.stop();
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const skipReason = () => (backend ? false : "git http-backend not found next to git --exec-path");

  it.skipIf(skipReason())(
    "clones with a token, pushes a branch and emits a push webhook event",
    async () => {
      expect(host.gitHttpAvailable).toBe(true);
      const clone = join(work, "clone1");
      await gitIn(work, "clone", "--quiet", host.cloneUrl(full, token.token), clone);
      expect(await readFile(join(clone, "README.md"), "utf8")).toBe("# service\n");
      await gitIn(clone, "checkout", "--quiet", "-b", "feature/http");
      await writeFile(join(clone, "feature.txt"), "pushed over http\n");
      await gitIn(clone, "add", "feature.txt");
      await gitIn(clone, "commit", "--quiet", "-m", "feat: over http");
      const sha = await gitIn(clone, "rev-parse", "HEAD");
      await gitIn(clone, "push", "--quiet", "origin", "feature/http");
      await host.settle();
      const branches = await api(host.baseUrl, "GET", `/repos/${full}/branches`, {
        token: token.token,
      });
      expect(branches.list.map((b) => b.name).sort()).toEqual(["feature/http", "main"]);
      const push = host
        .events()
        .find((e) => e.event === "push" && e.payload.ref === "refs/heads/feature/http");
      expect(push).toBeDefined();
      expect(push?.payload.after).toBe(sha);
      expect(push?.payload.created).toBe(true);
      expect((must(push).payload.pusher as Json).name).toBe("alice");
      expect(must((must(push).payload.commits as Json[])[0]).added).toEqual(["feature.txt"]);
      const log = host.requests().filter((r) => r.path.endsWith("/git-receive-pack"));
      expect(log.length).toBeGreaterThan(0);
      expect(log[0]?.auth?.login).toBe("alice");
    },
  );

  it.skipIf(skipReason())(
    "updates PR head and mergeability on push, merge is visible to a fresh clone",
    async () => {
      const opened = await api(host.baseUrl, "POST", `/repos/${full}/pulls`, {
        token: token.token,
        body: { title: "over http", head: "feature/http", base: "main" },
      });
      expect(opened.status).toBe(201);
      const n = Number(opened.json.number);
      const clone = join(work, "clone1");
      await writeFile(join(clone, "feature.txt"), "pushed over http, twice\n");
      await gitIn(clone, "commit", "--quiet", "-am", "feat: second");
      const sha2 = await gitIn(clone, "rev-parse", "HEAD");
      await gitIn(clone, "push", "--quiet", "origin", "feature/http");
      await host.settle();
      const pr = await api(host.baseUrl, "GET", `/repos/${full}/pulls/${n}`, {
        token: token.token,
      });
      expect((pr.json.head as Json).sha).toBe(sha2);
      expect(pr.json.mergeable).toBe(true);
      expect(pr.json.commits).toBe(2);
      const sync = host
        .events()
        .filter((e) => e.event === "pull_request" && e.action === "synchronize");
      expect(sync[sync.length - 1]?.payload.after).toBe(sha2);
      const merged = await api(host.baseUrl, "PUT", `/repos/${full}/pulls/${n}/merge`, {
        token: token.token,
        body: { merge_method: "rebase" },
      });
      expect(merged.status).toBe(200);
      const clone2 = join(work, "clone2");
      await gitIn(work, "clone", "--quiet", host.cloneUrl(full, token.token), clone2);
      expect(await readFile(join(clone2, "feature.txt"), "utf8")).toBe("pushed over http, twice\n");
      expect(await gitIn(clone2, "rev-parse", "HEAD")).toBe(String(merged.json.sha));
    },
  );

  it.skipIf(skipReason())(
    "rejects anonymous access to private repos and pushes without write access",
    async () => {
      const anon = await run(["git", ...gitUser, "ls-remote", host.cloneUrl(full)], {
        cwd: work,
        env: { ...process.env, ...gitEnv },
        allowFailure: true,
      });
      expect(anon.code).not.toBe(0);
      expect(anon.stderr).toMatch(/Authentication failed|401|could not read Username/);
      const reader = host.createToken({
        owner: "alice",
        kind: "fine_grained",
        permissions: { contents: "read" },
        repos: ["acme/service"],
      });
      const clone = join(work, "clone-ro");
      await gitIn(work, "clone", "--quiet", host.cloneUrl(full, reader.token), clone);
      await writeFile(join(clone, "ro.txt"), "x\n");
      await gitIn(clone, "add", "ro.txt");
      await gitIn(clone, "commit", "--quiet", "-m", "should be rejected");
      const push = await run(
        ["git", ...gitUser, "push", "--quiet", "origin", "HEAD:refs/heads/ro"],
        {
          cwd: clone,
          env: { ...process.env, ...gitEnv },
          allowFailure: true,
        },
      );
      expect(push.code).not.toBe(0);
      expect(push.stderr).toMatch(/403|not granted|Forbidden/);
      const bobs = host.createToken({ owner: "bob", kind: "classic", scopes: ["repo"] });
      const hidden = await run(["git", ...gitUser, "ls-remote", host.cloneUrl(full, bobs.token)], {
        cwd: work,
        env: { ...process.env, ...gitEnv },
        allowFailure: true,
      });
      expect(hidden.code).not.toBe(0);
      expect(hidden.stderr).toMatch(/not found|404/);
    },
  );

  it.skipIf(skipReason())(
    "takes only Basic on git smart HTTP, like GitHub, while the REST API takes bearer",
    async () => {
      // github.com, 2026-10-26: `bearer` / `token` on /info/refs answer 401 "invalid
      // credentials" for a token the REST API accepts; Basic x-access-token:<token> works.
      const pat = host.createToken({
        owner: "alice",
        kind: "fine_grained",
        permissions: { contents: "write" },
        repos: [full],
      });
      const refs = `${host.baseUrl}/${full}.git/info/refs?service=git-upload-pack`;
      for (const scheme of ["bearer", "Bearer", "token"]) {
        const res = await fetch(refs, { headers: { Authorization: `${scheme} ${pat.token}` } });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Basic/);
        expect(await res.text()).toBe("invalid credentials");
      }
      const basic = Buffer.from(`x-access-token:${pat.token}`).toString("base64");
      const ok = await fetch(refs, { headers: { Authorization: `Basic ${basic}` } });
      expect(ok.status).toBe(200);
      await ok.arrayBuffer();
      const rest = await api(host.baseUrl, "GET", "/user", { token: pat.token });
      expect(rest.status).toBe(200);
    },
  );
});
