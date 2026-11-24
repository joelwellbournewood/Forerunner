import { describe, expect, it } from "vitest";
import { MemoryGitHost } from "../src/githost/memory.ts";

/**
 * w8-two-homes, wave 8 (W8-homes-2): two people's Forerunners meet on one GitHub. Before, the
 * in-memory host held one login per instance and stamped it on every pull request, and a test
 * made Bob with `Object.create(host)` overriding only `whoAmI`, so whatever Bob's Forerunner
 * wrote carried Alice's login. `asLogin` gives each account its own view of one shared host.
 */
describe("w8-two-homes, wave 8: MemoryGitHost per-login views", () => {
  const repo = { owner: "team", name: "shared" };

  it("each view answers whoAmI with its own login and stamps it on what it writes", async () => {
    const ada = new MemoryGitHost("ada");
    await ada.createRepo({ ...repo, private: true });
    const bob = ada.asLogin("bob");
    expect(await ada.whoAmI()).toEqual({ login: "ada" });
    expect(await bob.whoAmI()).toEqual({ login: "bob" });

    const pr = await bob.createPullRequest(repo, {
      title: "Add the about page",
      body: "Body",
      head: "fr/b0b00001-about",
      base: "main",
    });
    expect(pr.authorLogin).toBe("bob");
    const comment = await bob.commentOnPullRequest(repo, pr.number, "Ready for review.");
    expect(comment.author).toBe("bob");
    const review = await ada.reviewPullRequest(repo, pr.number, { event: "COMMENT", body: "ok" });
    expect((await bob.listPullRequestReviews(repo, pr.number))[0]).toMatchObject({
      id: review.id,
      author: "ada",
    });

    // One GitHub: what one account wrote, the other reads; numbers and ids are not reused.
    expect((await ada.listPullRequests(repo)).map((p) => [p.number, p.authorLogin])).toEqual([
      [pr.number, "bob"],
    ]);
    const issue = await ada.createIssue(repo, { title: "Forerunner status: Team site", body: "" });
    expect(issue.number).toBe(pr.number + 1);
    const onIssue = await ada.commentOnIssue(repo, issue.number, "Ada's comment");
    expect(onIssue.author).toBe("ada");
    expect(onIssue.id).not.toBe(comment.id);
  });

  it("the write log names each write's login, and writesBy reads one account's", async () => {
    const ada = new MemoryGitHost("ada");
    await ada.createRepo({ ...repo, private: true });
    const bob = ada.asLogin("bob");
    const pr = await bob.createPullRequest(repo, {
      title: "Bob's task",
      body: "",
      head: "fr/b0b00002-task",
      base: "main",
    });
    await bob.commentOnPullRequest(repo, pr.number, "note");
    await ada.mergePullRequest(repo, pr.number);
    expect(ada.writesBy("bob").map((w) => [w.op, w.number])).toEqual([
      ["createPullRequest", pr.number],
      ["commentOnPullRequest", pr.number],
    ]);
    expect(bob.writesBy("ada").map((w) => w.op)).toEqual(["createRepo", "mergePullRequest"]);
    expect(ada.writes).toBe(bob.writes);
  });

  it("the shared settings (the clock, mergeability, merges) are one for every view", async () => {
    const ada = new MemoryGitHost("ada");
    await ada.createRepo({ ...repo, private: true });
    const bob = ada.asLogin("bob");
    ada.now = () => "2026-11-24T09:00:00.000Z";
    bob.mergeableByDefault = false;
    const pr = await bob.createPullRequest(repo, {
      title: "t",
      body: "",
      head: "fr/b0b00003-t",
      base: "main",
    });
    expect(pr.updatedAt).toBe("2026-11-24T09:00:00.000Z");
    expect(pr.mergeable).toBe(false);
    ada.mergeableByDefault = true;
    expect(bob.mergeableByDefault).toBe(true);
  });

  it("openPullRequestAs writes through that account's view", async () => {
    const ada = new MemoryGitHost("ada");
    await ada.createRepo({ ...repo, private: true });
    const pr = await ada.openPullRequestAs(repo, "carol", {
      title: "Carol's",
      body: "",
      head: "fr/ca401000-x",
    });
    expect(pr.authorLogin).toBe("carol");
    expect(ada.writesBy("carol").map((w) => w.op)).toEqual(["createPullRequest"]);
  });
});
