import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import { AGENT_TEXT_MARKER, isAgentText, markAgentText } from "../src/githost/types.ts";

/**
 * The git host port's PR feedback reads (spec E.1; ADR 0075) against the testenv fake git
 * host: every page of the conversation comments (a PR with more comments than one page still
 * shows the newest), `since` keeps the comments updated at or after it, the reviews list
 * maps author, state and text, the review (line) comments list maps file, line, review and
 * thread and honours `since`, and what the port writes carries the agent's hidden mark (the
 * poller tells the agent's own text from the human's by it when both share a login). The
 * in-memory host honours the same contract.
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
    // Every comment written through the port carries the agent's mark.
    expect(all.map((c) => c.body)).toEqual(["one", "two", "three"].map(markAgentText));
    expect(all.every((c) => isAgentText(c.body))).toBe(true);
    // The mark is appended once, hidden in an HTML comment.
    expect(markAgentText(markAgentText("x"))).toBe(`x\n\n${AGENT_TEXT_MARKER}`);
    expect(AGENT_TEXT_MARKER).toMatch(/^<!--.*-->$/);
    expect(all.map((c) => c.author)).toEqual([owner, "reviewer", "reviewer"]);
    expect(all[2]?.htmlUrl).toContain(`/pull/${prNumber}#issuecomment-`);
    const recent = await gh.listPullRequestComments(repo, prNumber, { since });
    expect(recent.map((c) => c.body)).toEqual([markAgentText("three")]);
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
      ["reviewer", "CHANGES_REQUESTED", markAgentText("Rename the helper.")],
      ["reviewer", "APPROVED", AGENT_TEXT_MARKER],
    ]);
    expect(reviews[0]?.id).toBeLessThan(reviews[1]?.id ?? 0);
  });

  it("lists the review (line) comments with file, line, review and thread, and since", async () => {
    // Raw REST as the reviewer, as a human writes them (no agent mark).
    const reviewerToken = host.createToken({
      owner: "reviewer",
      kind: "classic",
      scopes: ["repo"],
    }).token;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${host.baseUrl}/repos/${owner}/app${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${reviewerToken}`,
          Accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(res.ok).toBe(true);
      return (await res.json()) as { id: number };
    };
    const review = await post(`/pulls/${prNumber}/reviews`, {
      event: "COMMENT",
      comments: [{ path: "b.md", line: 1, body: "Typo here." }],
    });
    await clock.advance(60_000);
    const since = clock.nowIso();
    const lines = await gh.listPullRequestReviewComments(repo, prNumber);
    expect(lines.map((c) => [c.author, c.path, c.line, c.reviewId, c.body])).toEqual([
      ["reviewer", "b.md", 1, review.id, "Typo here."],
    ]);
    expect(lines[0]?.htmlUrl).toContain(`/pull/${prNumber}#discussion_r`);
    const reply = await post(`/pulls/${prNumber}/comments`, {
      body: "And here.",
      in_reply_to: lines[0]?.id,
    });
    const recent = await gh.listPullRequestReviewComments(repo, prNumber, { since });
    expect(recent.map((c) => [c.id, c.inReplyTo, c.path, c.body])).toEqual([
      [reply.id, lines[0]?.id, "b.md", "And here."],
    ]);
    // A pending review's line comment is its author's draft and is not listed.
    await post(`/pulls/${prNumber}/reviews`, {
      comments: [{ path: "b.md", line: 1, body: "draft" }],
    });
    expect((await gh.listPullRequestReviewComments(repo, prNumber)).map((c) => c.body)).toEqual([
      "Typo here.",
      "And here.",
    ]);
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
    expect((await m.listPullRequestComments(r, 1)).map((c) => c.body)).toEqual([
      markAgentText("first"),
    ]);
    await m.reviewPullRequest(r, 1, { event: "REQUEST_CHANGES", body: "fix it" });
    expect((await m.listPullRequestReviews(r, 1)).map((x) => [x.state, x.body])).toEqual([
      ["CHANGES_REQUESTED", markAgentText("fix it")],
    ]);
    const id = m.addReviewComment(r, 1, {
      body: "line note",
      author: "bob",
      createdAt: "2026-01-02T00:00:00.000Z",
      htmlUrl: "memory://alice/r/rc",
      reviewId: null,
      path: "a.md",
      line: 3,
      inReplyTo: null,
    });
    expect((await m.listPullRequestReviewComments(r, 1)).map((c) => [c.id, c.body])).toEqual([
      [id, "line note"],
    ]);
    expect(
      await m.listPullRequestReviewComments(r, 1, { since: "2026-01-03T00:00:00.000Z" }),
    ).toEqual([]);
  });
});
