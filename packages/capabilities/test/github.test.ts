import { createServer, type Server } from "node:http";
import { SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function stub(): Promise<{
  server: Server;
  url: string;
  seen: Seen[];
  rateLimitOnce: { on: boolean };
}> {
  const seen: Seen[] = [];
  const rateLimitOnce = { on: false };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(obj));
        };
        const u = req.url ?? "";
        if (rateLimitOnce.on) {
          rateLimitOnce.on = false;
          return json(
            403,
            { message: "API rate limit exceeded" },
            {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1),
            },
          );
        }
        if (u === "/user") return json(200, { login: "alice" });
        if (u === "/repos/o/r")
          return json(200, {
            name: "r",
            full_name: "o/r",
            owner: { login: "o" },
            default_branch: "main",
            private: true,
            html_url: "http://x/o/r",
            clone_url: "http://x/o/r.git",
            permissions: { pull: true, push: true, admin: false },
          });
        if (u === "/repos/o/r/pulls" && req.method === "POST")
          return json(201, {
            number: 7,
            title: JSON.parse(body).title,
            body: "",
            state: "open",
            mergeable: true,
            head: { ref: "feat", sha: "abc" },
            base: { ref: "main", sha: "def" },
            html_url: "http://x/o/r/pull/7",
          });
        if (u === "/repos/o/r/pulls/7/merge" && req.method === "PUT")
          return json(405, { message: "Pull Request is not mergeable" });
        if (u === "/repos/o/r/issues/7/comments" && req.method === "POST")
          return json(201, {
            id: 1,
            body: JSON.parse(body).body,
            user: { login: "alice" },
            created_at: "2026-01-01T00:00:00Z",
            html_url: "http://x/c/1",
          });
        if (u.startsWith("/repos/o/r/contents/docs/a.md"))
          return req.method === "GET"
            ? json(200, {
                type: "file",
                sha: "s1",
                content: Buffer.from("hello").toString("base64"),
              })
            : json(200, { content: { sha: "s2" } });
        if (u === "/repos/o/r/releases/latest") return json(404, { message: "Not Found" });
        if (u === "/repos/o/r/commits/abc/check-runs?per_page=100")
          return json(200, {
            check_runs: [
              { id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null },
            ],
          });
        if (u === "/repos/o/missing") return json(404, { message: "Not Found" });
        if (u === "/flaky") return json(500, { message: "boom" });
        json(404, { message: `unhandled ${u}` });
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        seen,
        rateLimitOnce,
      }),
    );
  });
}

describe("GitHubHost", () => {
  let s: Awaited<ReturnType<typeof stub>>;
  beforeAll(async () => {
    s = await stub();
  });
  afterAll(() => s.server.close());

  it("sends the token as a bearer header and maps repos, PRs, comments, files, checks", async () => {
    const gh = new GitHubHost({ token: "tok", baseUrl: s.url });
    expect((await gh.whoAmI()).login).toBe("alice");
    expect(s.seen.at(-1)?.headers.authorization).toBe("Bearer tok");
    const repo = await gh.getRepo({ owner: "o", name: "r" });
    expect(repo).toMatchObject({
      fullName: "o/r",
      defaultBranch: "main",
      permissions: { push: true },
    });
    const pr = await gh.createPullRequest(
      { owner: "o", name: "r" },
      { title: "Add thing", body: "b", head: "feat", base: "main" },
    );
    expect(pr.number).toBe(7);
    expect(pr.htmlUrl).toContain("/pull/7");
    const merge = await gh.mergePullRequest({ owner: "o", name: "r" }, 7);
    expect(merge.merged).toBe(false);
    expect(merge.message).toContain("not mergeable");
    const c = await gh.commentOnPullRequest({ owner: "o", name: "r" }, 7, "looks good");
    expect(c.body).toBe("looks good");
    const f = await gh.getFile({ owner: "o", name: "r" }, "docs/a.md");
    expect(f?.content).toBe("hello");
    expect(
      (
        await gh.putFile(
          { owner: "o", name: "r" },
          { path: "docs/a.md", content: "x", message: "m", branch: "feat", sha: "s1" },
        )
      ).sha,
    ).toBe("s2");
    expect(await gh.getFile({ owner: "o", name: "r" }, "nope.md")).toBeNull();
    expect(await gh.getLatestRelease({ owner: "o", name: "r" })).toBeNull();
    expect((await gh.listCheckRuns({ owner: "o", name: "r" }, "abc"))[0]?.conclusion).toBe(
      "success",
    );
  });

  it("maps errors to codes and waits once for a rate-limit reset", async () => {
    const clock = new SimulatedClock(Date.now());
    const gh = new GitHubHost({ token: "tok", baseUrl: s.url, clock });
    await expect(gh.getRepo({ owner: "o", name: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    s.rateLimitOnce.on = true;
    const p = gh.whoAmI();
    await new Promise((r) => setTimeout(r, 20));
    await clock.advance(1_200);
    expect((await p).login).toBe("alice");
    await expect(
      new GitHubHost({ token: "tok", baseUrl: s.url, clock }).getRepo({
        owner: "flaky",
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(() => new GitHubHost({ token: "" })).toThrow(/needs a token/);
  });
});
