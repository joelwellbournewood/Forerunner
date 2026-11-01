import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";

/**
 * U-083 (the owner's project on GitHub): every task failed at its start with "git checkout -B
 * fr/… failed: 'origin/fr/…' is not a commit" once the project's docs pull request was open.
 * The task's lookup "the open pull request of my branch" sent `head=<branch>`; GitHub reads
 * `head` only as `owner:branch` and returned every open pull request for a bare branch, so the
 * docs pull request was taken for the task's own and the run started from a branch that did not
 * exist. The fake host matched a bare branch, so no test saw it; it now answers as GitHub did.
 */
describe("the open pull request of a branch (U-083)", () => {
  let host: FakeGitHost;
  let gh: GitHubHost;
  const clock = new SimulatedClock("2026-11-01T00:40:00Z");
  const repo = { owner: "joel", name: "joels-test" };

  beforeAll(async () => {
    host = await FakeGitHost.start({ rootDir: mkdtempSync(join(tmpdir(), "fr-u083-")), clock });
    host.createUser({ login: "joel", name: "Joel", email: "joel@example.test" });
    const token = host.createToken({ owner: "joel", kind: "classic", scopes: ["repo"] }).token;
    gh = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    await host.createRepo({
      ...repo,
      private: true,
      initialFiles: { "README.md": "# Joels Test\n" },
    });
    await host.seedCommit(repo, { "docs/status.md": "status\n" }, "docs status", "fr/docs-status");
    await gh.createPullRequest(repo, {
      title: "Project status",
      body: "docs",
      head: "fr/docs-status",
      base: "main",
    });
  });
  afterAll(async () => {
    await host?.stop();
  });

  it("a branch without a pull request has none, while another branch's pull request is open", async () => {
    expect(await gh.listPullRequests(repo, { state: "open", head: "fr/01a19457-task" })).toEqual(
      [],
    );
  });

  it("a branch with a pull request gets that one only", async () => {
    await host.seedCommit(repo, { "index.html": "<h1>hi</h1>\n" }, "scaffold", "fr/01a19457-task");
    const own = await gh.createPullRequest(repo, {
      title: "Scaffold",
      body: "task",
      head: "fr/01a19457-task",
      base: "main",
    });
    const found = await gh.listPullRequests(repo, { state: "open", head: "fr/01a19457-task" });
    expect(found.map((p) => p.number)).toEqual([own.number]);
    // The qualified form is passed through as it is.
    const qualified = await gh.listPullRequests(repo, {
      state: "open",
      head: "joel:fr/docs-status",
    });
    expect(qualified.map((p) => p.head.ref)).toEqual(["fr/docs-status"]);
  });

  it("the fake host answers a bare branch as GitHub does: every open pull request", async () => {
    const res = await fetch(`${host.baseUrl}/repos/joel/joels-test/pulls?state=open&head=fr/none`, {
      headers: {
        authorization: `Bearer ${host.createToken({ owner: "joel", kind: "classic", scopes: ["repo"] }).token}`,
      },
    });
    expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  });
});
