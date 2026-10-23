import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";

/**
 * The git host port's PR feedback reads (spec E.1; ADR 0075) against the testenv fake git
 * host: every page of the conversation comments (a PR with more comments than one page still
 * shows the newest), `since` keeps the comments updated at or after it, and the reviews list
 * maps author, state and text. The in-memory host honours the same contract.
 */
const owner = "someone";
const repo = { owner, name: "app" };
let root: string;
let clock: SimulatedClock;
let host: FakeGitHost;
let gh: GitHubHost;
let reviewerGh: GitHubHost;
let prNumber: number;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fr-githost-feedback-"));
  clock = new SimulatedClock("2026-10-20T09:00:00.000Z");
  host = await FakeGitHost.start({ rootDir: root, clock });
  host.createUser({ login: owner, name: "Someone", email: "someone@example.test" });
  host.createUser({ login: "reviewer", name: "Reviewer", email: "reviewer@example.test" });
  const token = host.createToken({ owner, kind: "classic", scopes: ["repo"] }).token;
  const reviewerToken = host.createToken({
    owner: "reviewer",
    kind: "classic",
    scopes: ["repo"],
  }).token;
  await host.createRepo({ owner, name: "app", private: false, initialFiles: { "a.md": "a\n" } });
  host.addCollaborator(`${owner}/app`, "reviewer");
  await host.seedCommit(`${owner}/app`, { "b.md": "b\n" }, "b", "feature/b");
  // A page of two items, so three comments already span two pages.
  gh = new GitHubHost({ token, baseUrl: host.baseUrl, clock, pageSize: 2 });
  reviewerGh = new GitHubHost({ token: reviewerToken, baseUrl: host.baseUrl, clock });
  prNumber = (
    await gh.createPullRequest(repo, { title: "b", body: "", head: "feature/b", base: "main" })
  ).number;
});

afterAll(async () => {
  await host.stop();
  await rm(root, { recursive: true, force: true });
});

describe("GitHubHost PR feedback against the fake git host", () => {
  it("lists every page of the comments and filters by since", async () => {
    await gh.commentOnPullRequest(repo, prNumber, "one");
    await clock.advance(60_000);
    await reviewerGh.commentOnPullRequest(repo, prNumber, "two");
    await clock.advance(60_000);
    const since = clock.nowIso();
    await reviewerGh.commentOnPullRequest(repo, prNumber, "three");
    const all = await gh.listPullRequestComments(repo, prNumber);
    expect(all.map((c) => c.body)).toEqual(["one", "two", "three"]);
    expect(all.map((c) => c.author)).toEqual([owner, "reviewer", "reviewer"]);
    expect(all[2]?.htmlUrl).toContain(`/pull/${prNumber}#issuecomment-`);
    const recent = await gh.listPullRequestComments(repo, prNumber, { since });
    expect(recent.map((c) => c.body)).toEqual(["three"]);
    const pages = host
      .requests()
      .filter((r) => r.path.startsWith(`/repos/${owner}/app/issues/${prNumber}/comments`));
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  it("lists the reviews with author, state and text", async () => {
    await reviewerGh.reviewPullRequest(repo, prNumber, {
      event: "REQUEST_CHANGES",
      body: "Rename the helper.",
    });
    await reviewerGh.reviewPullRequest(repo, prNumber, { event: "APPROVE", body: "" });
    const reviews = await gh.listPullRequestReviews(repo, prNumber);
    expect(reviews.map((r) => [r.author, r.state, r.body])).toEqual([
      ["reviewer", "CHANGES_REQUESTED", "Rename the helper."],
      ["reviewer", "APPROVED", ""],
    ]);
    expect(reviews[0]?.id).toBeLessThan(reviews[1]?.id ?? 0);
  });
});

describe("MemoryGitHost PR feedback", () => {
  it("keeps the comments since an instant and records reviews", async () => {
    const m = new MemoryGitHost("alice");
    await m.createRepo({ name: "r", private: true });
    const r = { owner: "alice", name: "r" };
    await m.commentOnPullRequest(r, 1, "first");
    expect(await m.listPullRequestComments(r, 1, { since: "2000-01-01T00:00:00.000Z" })).toEqual(
      [],
    );
    expect((await m.listPullRequestComments(r, 1)).map((c) => c.body)).toEqual(["first"]);
    await m.reviewPullRequest(r, 1, { event: "REQUEST_CHANGES", body: "fix it" });
    expect((await m.listPullRequestReviews(r, 1)).map((x) => [x.state, x.body])).toEqual([
      ["CHANGES_REQUESTED", "fix it"],
    ]);
  });
});
