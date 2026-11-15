import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";

/**
 * d1109-onerepo-link (ADR 0117): whether a Forerunner project that is not on this computer is
 * still worked on is read from its pull requests' update time and author, and a renamed
 * repository is told by GitHub's numeric id. Before, `PullRequestInfo` carried neither and
 * `RepoInfo` dropped the id, so nothing could tell a project in use from an abandoned one.
 */
describe("d1109-onerepo-link, run C: pull request activity and the repository id", () => {
  let host: FakeGitHost;
  let root: string;
  let ada: GitHubHost;
  let bob: GitHubHost;
  const clock = new SimulatedClock("2026-11-01T09:00:00Z");
  const repo = { owner: "ada", name: "kite" };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-gh-activity-"));
    host = await FakeGitHost.start({ rootDir: root, clock });
    host.createUser({ login: "ada", name: "Ada", email: "ada@example.test" });
    host.createUser({ login: "bob", name: "Bob", email: "bob@example.test" });
    const adaToken = host.createToken({ owner: "ada", kind: "classic", scopes: ["repo"] }).token;
    const bobToken = host.createToken({ owner: "bob", kind: "classic", scopes: ["repo"] }).token;
    ada = new GitHubHost({ token: adaToken, baseUrl: host.baseUrl, clock });
    bob = new GitHubHost({ token: bobToken, baseUrl: host.baseUrl, clock });
    await host.createRepo({ ...repo, initialFiles: { "README.md": "# kite\n" } });
    host.addCollaborator("ada/kite", "bob");
    await host.seedCommit(repo, { "a.md": "a\n" }, "a", "fr/a");
    await host.seedCommit(repo, { "b.md": "b\n" }, "b", "fr/b");
  });
  afterAll(async () => {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("a pull request says when it was last updated and who opened it; the latest first", async () => {
    const first = await ada.createPullRequest(repo, {
      title: "A",
      body: "a",
      head: "fr/a",
      base: "main",
    });
    await clock.advance(3_600_000);
    const second = await bob.createPullRequest(repo, {
      title: "B",
      body: "b",
      head: "fr/b",
      base: "main",
    });
    await clock.advance(3_600_000);
    // The first is touched again: it is now the latest.
    await ada.updatePullRequest(repo, first.number, { title: "A again" });
    const all = await ada.listPullRequests(repo, { state: "all", sort: "updated" });
    expect(all.map((p) => [p.number, p.authorLogin])).toEqual([
      [first.number, "ada"],
      [second.number, "bob"],
    ]);
    expect(Date.parse(all[0]?.updatedAt ?? "")).toBe(clock.now());
    expect(Date.parse(all[1]?.updatedAt ?? "")).toBe(clock.now() - 3_600_000);
  });

  it("a repository carries GitHub's numeric id", async () => {
    const info = await ada.getRepo(repo);
    expect(typeof info.id).toBe("number");
  });

  it("the memory host stamps, sorts and answers the same", async () => {
    const mem = new MemoryGitHost("ada");
    mem.now = () => "2026-11-01T09:00:00.000Z";
    await mem.createRepo({ owner: "ada", name: "kite", private: false });
    const own = await mem.createPullRequest(repo, {
      title: "A",
      body: "",
      head: "a",
      base: "main",
    });
    const theirs = await mem.openPullRequestAs(repo, "bob", {
      title: "B",
      body: "",
      head: "b",
      state: "closed",
      merged: true,
      updatedAt: "2026-11-03T09:00:00.000Z",
    });
    expect(own).toMatchObject({ authorLogin: "ada", updatedAt: "2026-11-01T09:00:00.000Z" });
    const all = await mem.listPullRequests(repo, { state: "all", sort: "updated" });
    expect(all.map((p) => [p.number, p.authorLogin, p.merged])).toEqual([
      [theirs.number, "bob", true],
      [own.number, "ada", false],
    ]);
    expect(typeof (await mem.getRepo(repo)).id).toBe("number");
  });
});
