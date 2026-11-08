import { rm } from "node:fs/promises";
import { GitOps } from "@forerunner/capabilities";
import { join } from "@forerunner/platform";
import { describe, expect, it, vi } from "vitest";
import { MAX_MERGE_ATTEMPTS, MERGE_PR_TOOL } from "../src/loop/merge.ts";
import {
  FULL,
  forcedPushes,
  identity,
  inboxCards,
  LEFT_OPEN_CHOICES,
  mergeLogLines,
  mergeRows,
  REPO,
  recordWorld,
} from "./merge-world.ts";

/**
 * ADR 0111: the merge record, the one gated entry, merge commits only, the branch's rules, and
 * a merge step that never replays merged-in work. Real git against the fake git host (its REST
 * API and git smart HTTP), the session runner and the enforcement hooks.
 *
 * Before: the merge step rebased a moved base and force-pushed (a dependent branch's
 * dependency commits were copied: the dependency's PR never merged), merged with a squash,
 * read the reviewed commit from the worktree whenever it ran, kept nothing when the checks
 * outlasted the wait, never read allow_merge_commit or the branch's rules (an admin token
 * merged around classic protection), and left not_allowed and unverified without a word.
 */
describe("the merge record and the merge step (ADR 0111)", { timeout: 180_000 }, () => {
  it("(a) a dependent branch whose base moved is merged as it is, with a merge commit: nothing replayed or forced, the dependency's commit reaches main once and both PRs are merged", async () => {
    // merge-in-app: in the default mode ("You press Merge") both PRs wait for the person; the
    // second builds on the first. Main moves after the review, and the person's Merge on the
    // second (the click alone: no update, no checks to wait for) merges it as it is.
    const m = await recordWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const prA = await m.pr(a.id);
    expect(prA.merged).toBe(false);
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    expect((await m.pr(b.id)).merged).toBe(false);
    await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
    const clicked = await m.merge.mergeRecorded(await m.record(b.id), {
      kind: "person",
      humanId: m.w.human,
    });
    expect(clicked.status).toBe("merged");
    const prB = await m.pr(b.id);
    expect(prB).toMatchObject({ merged: true, state: "closed" });
    // GitHub marks the dependency merged: its commit reached main as it is.
    expect(await m.pr(a.id)).toMatchObject({ merged: true });
    expect(
      await m.hostGit("merge-base", "--is-ancestor", prA.head.sha, "main").then(() => "yes"),
    ).toBe("yes");
    // One commit adds the dependency's file on main: nothing was copied.
    expect(
      (await m.hostGit("log", "--format=%H", "main", "--", "src/add-page.ts")).split("\n"),
    ).toHaveLength(1);
    // A merge commit with two parents, the second the reviewed head; no force-push anywhere.
    const record = await m.record(b.id);
    expect(record).toMatchObject({
      state: "merged",
      method: "merge",
      approval: "person",
      approved_by: m.w.human,
    });
    const parents = (await m.hostGit("rev-list", "--parents", "-n", "1", record.merge_sha ?? ""))
      .split(" ")
      .slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(record.reviewed_head_sha);
    expect(forcedPushes(m.host, prB.head.ref)).toEqual([]);
    expect(forcedPushes(m.host, prA.head.ref)).toEqual([]);
  });

  it("(a) a rule that the branch be up to date brings main in by merging (a normal push), the record moves to the new head, and the retry merges it once its checks pass", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    m.host.setBranchRules(FULL, "main", [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci/test" }],
        },
      },
    ]);
    let reviewed = "";
    const t = await m.runTask("Add feature", {
      afterPr: async (pr) => {
        reviewed = pr.headSha;
        await m.check(pr.headSha, "ci/test", "completed", "success");
        await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
      },
    });
    const pr = await m.pr(t.id);
    // Brought up to date by a merge commit of main, pushed without force; its checks now run.
    expect(pr.merged).toBe(false);
    expect(pr.head.sha).not.toBe(reviewed);
    const head = (await m.hostGit("rev-list", "--parents", "-n", "1", pr.head.sha)).split(" ");
    expect(head.slice(1)).toEqual([reviewed, await m.hostGit("rev-parse", "main")]);
    expect(forcedPushes(m.host, pr.head.ref)).toEqual([]);
    const waiting = await m.record(t.id);
    expect(waiting).toMatchObject({ state: "waiting_checks", reviewed_head_sha: pr.head.sha });
    expect(waiting.sentence).toMatch(/checks pass/);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
  });

  it("(c) a merge whose checks still run is kept, no card is filed, and the retry merges it with no session on its own narrow token, one audit row each; another agent's record is not touched", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    expect(pr.merged).toBe(false);
    const waiting = await m.record(t.id);
    expect(waiting).toMatchObject({
      state: "waiting_checks",
      agent_id: m.w.alice,
      reviewed_head_sha: pr.head.sha,
      last_outcome: "checks_pending",
    });
    expect(waiting.own_change_id).toMatch(/^[0-9a-f]{40}$/);
    expect(await m.w.store.humanRequest.list({ task_id: t.id } as never)).toEqual([]);
    // Another install's agent's record on the same store waits too: only its own daemon retries it.
    const other = await m.w.addTask("Other install's task", { status: "done" });
    const theirs = await m.w.store.mergeRecord.insert({
      task_id: other.id,
      project_id: m.w.project,
      agent_id: m.w.bob,
      pr_number: 99,
      pr_url: `${m.host.baseUrl}/${FULL}/pull/99`,
      reviewed_head_sha: "f".repeat(40),
      state: "waiting_checks",
    });
    // Still running: one look, no wait, no merge.
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    const sessionCalls = m.calls.length;
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
    // The retries' tokens are their own: merge_pr only, no budget, not the session's.
    const retry = m.calls.slice(sessionCalls);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      allowedTools: [MERGE_PR_TOOL],
      budgetUsdMicro: 0,
      grantedSecrets: [],
      agentId: m.w.alice,
      taskId: t.id,
    });
    expect(retry[0]?.sessionId).not.toBe(m.calls[0]?.sessionId);
    // The session's call and the merge's: the pass that found the checks still running read
    // them first and made no gated call (R-mergeretry; before, it wrote a row of its own).
    const rows = mergeRows(m.audit);
    expect(rows.map((r) => r.allowed)).toEqual([true, true]);
    expect(rows.at(-1)?.tokenId).toBe(retry[0]?.id);
    expect(await m.w.store.mergeRecord.mustGet(theirs.id)).toMatchObject({
      state: "waiting_checks",
      attempts: 0,
    });
  });

  it("(c) Stop all holds the retry: nothing is tried or audited while it holds, and the retry merges once work may run again", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.w.kill.stop("all", "Stop all");
    const rowsBefore = mergeRows(m.audit).length;
    expect(await m.merge.retryWaiting()).toEqual([]);
    expect(mergeRows(m.audit)).toHaveLength(rowsBefore);
    expect(await m.record(t.id)).toMatchObject({ state: "waiting_checks", attempts: 1 });
    expect((await m.pr(t.id)).merged).toBe(false);
    m.w.kill.resume();
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    expect((await m.record(t.id)).state).toBe("merged");
  });

  it("(c) a merge that waited about a day goes to the person, with what it waited on: checks still running, or GitHub not answering", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const running = (pr: { headSha: string }) => m.check(pr.headSha, "ci/test", "in_progress");
    const t = await m.runTask("Add feature", { afterPr: running });
    const pr = await m.pr(t.id);
    await m.w.store.mergeRecord.move((await m.record(t.id)).id, "waiting_checks", {
      attempts: MAX_MERGE_ATTEMPTS,
    });
    await m.merge.retryWaiting();
    const stuck = await m.record(t.id);
    expect(stuck).toMatchObject({
      state: "left_to_you",
      last_outcome: "checks_pending",
      sentence: `The checks of #${pr.number} have not finished in a day: look at them on GitHub, then merge it.`,
    });
    expect((await inboxCards(m, t.id)).map((c) => c.body)).toEqual([stuck.sentence]);
    // GitHub silent for a day is not "the checks have not finished".
    const u = await m.runTask("Add footer", { afterPr: running });
    const prU = await m.pr(u.id);
    await m.w.store.mergeRecord.move((await m.record(u.id)).id, "waiting_checks", {
      attempts: MAX_MERGE_ATTEMPTS,
    });
    m.setHostDown(true);
    try {
      await m.merge.retryWaiting();
    } finally {
      m.setHostDown(false);
    }
    const silent = await m.record(u.id);
    expect(silent).toMatchObject({
      state: "left_to_you",
      last_outcome: "unreachable",
      sentence: `GitHub has not answered about #${prU.number} for a day: look at it on GitHub, then merge it.`,
    });
    expect((await inboxCards(m, u.id)).map((c) => c.body)).toEqual([silent.sentence]);
    expect((await m.pr(u.id)).merged).toBe(false);
  });

  it("(d) the gate reads the mode at every call: a record made under 'Merge automatically after review', the mode then switched to 'You press Merge', is not merged by the retry", async () => {
    // merge-in-app: the merge mode, not the level, frees a merge (before: the level, 3 then 2).
    const m = await recordWorld({ level: 3, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    expect((await m.record(t.id)).state).toBe("waiting_checks");
    await m.setMode("you");
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record.state).toBe("left_to_you");
    expect(record.sentence).toBe(
      `#${pr.number} waits for you to merge it: press Merge on the Overview.`,
    );
    expect(mergeRows(m.audit).at(-1)).toMatchObject({ allowed: false });
    expect(mergeRows(m.audit).at(-1)?.deniedReason).toBe(
      'autonomy_insufficient: the project\'s merge mode is "You press Merge"',
    );
  });

  it("(b) the reviewed version holds: a commit pushed after the accept is never merged by the retry", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    const reviewed = (await m.record(t.id)).reviewed_head_sha;
    const pushed = await m.host.seedCommit(
      FULL,
      { "src/add-feature.ts": "export const v = 2;\n" },
      "pushed after the review",
      pr.head.ref,
    );
    await m.check(pushed.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record).toMatchObject({
      state: "left_to_you",
      reviewed_head_sha: reviewed,
      last_outcome: "head_moved",
    });
    expect(record.sentence).toBe(
      `#${pr.number} changed after the review: look at the new commits, then merge it yourself or send it back.`,
    );
    // The person reads the record's sentence on the one card, with no commit ids.
    const cards = await inboxCards(m, t.id);
    expect(cards).toEqual([
      {
        title: `The critic accepted "Add feature", but pull request #${pr.number} was not merged`,
        body: record.sentence,
        choices: LEFT_OPEN_CHOICES,
      },
    ]);
    expect(JSON.stringify(cards)).not.toMatch(/[0-9a-f]{12}/);
  });

  it("(b) a crash after main was merged in: the head keeps the task's own change, so the record moves to it and the retry merges it", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    const before = await m.record(t.id);
    // Main moved; the merge step brought it in and pushed, then the daemon died before the
    // record moved.
    await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
    const git = new GitOps({
      cwd: join(m.worktreeRoot, t.id),
      identity,
      auth: { token: m.token },
    });
    await git.fetch();
    expect((await git.mergeFrom("origin/main", "Merge main into the branch")).ok).toBe(true);
    await git.push(pr.head.ref);
    const merged = await git.headSha();
    await m.check(merged, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "merged", reviewed_head_sha: merged });
    expect(record.own_change_id).toBe(before.own_change_id);
  });

  it("(b) a crash after main was merged in locally, before the push: that merge is set aside, main is brought in again, and nothing goes to the person", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    m.host.setBranchRules(FULL, "main", [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci/test" }],
        },
      },
    ]);
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const reviewed = (await m.record(t.id)).reviewed_head_sha;
    expect((await m.record(t.id)).state).toBe("waiting_checks");
    // Main moved; an earlier try merged it into the task folder and died before the push.
    await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
    const git = new GitOps({
      cwd: join(m.worktreeRoot, t.id),
      identity,
      auth: { token: m.token },
    });
    await git.fetch();
    expect((await git.mergeFrom("origin/main", "Merge main into the branch")).ok).toBe(true);
    expect(await git.headSha()).not.toBe(reviewed);
    await m.check(reviewed, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    // Brought up to date by a merge commit pushed now, not "changed after the review".
    const pr = await m.pr(t.id);
    expect(pr.merged).toBe(false);
    const parents = (await m.hostGit("rev-list", "--parents", "-n", "1", pr.head.sha)).split(" ");
    expect(parents.slice(1)).toEqual([reviewed, await m.hostGit("rev-parse", "main")]);
    expect(forcedPushes(m.host, pr.head.ref)).toEqual([]);
    expect(await m.record(t.id)).toMatchObject({
      state: "waiting_checks",
      reviewed_head_sha: pr.head.sha,
    });
    expect(await inboxCards(m, t.id)).toEqual([]);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
  });

  it("(e) a rule that needs an approving review: nothing merges, even on an admin token that GitHub would let around classic protection; one sentence and one card", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    m.host.setBranchProtection(FULL, "main", {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: false },
    });
    const t = await m.runTask("Add feature");
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record.state).toBe("left_to_you");
    expect(record.sentence).toBe(
      "This repository needs an approving review before merging, and GitHub does not let you approve your own pull request: merge it on GitHub once someone else approved it.",
    );
    // The one card says it.
    const pr = await m.pr(t.id);
    expect(await inboxCards(m, t.id)).toEqual([
      {
        title: `The critic accepted "Add feature", but pull request #${pr.number} was not merged`,
        body: record.sentence,
        choices: LEFT_OPEN_CHOICES,
      },
    ]);
    // A ruleset says the same, on the card and in the daemon log.
    m.host.setBranchProtection(FULL, "main", null);
    m.host.setBranchRules(FULL, "main", [
      { type: "pull_request", parameters: { required_approving_review_count: 2 } },
    ]);
    const logged = await mergeLogLines(async () => {
      const u = await m.runTask("Add footer");
      expect((await m.pr(u.id)).merged).toBe(false);
      const sentence = (await m.record(u.id)).sentence;
      expect(sentence).toMatch(/approving review/);
      expect((await inboxCards(m, u.id)).map((c) => c.body)).toEqual([sentence]);
    });
    expect(logged.at(-1)).toMatchObject({
      state: "left_to_you",
      status: "blocked_by_rules",
      sentence: expect.stringMatching(/approving review/),
    });
  });

  it("(f) a repository that does not allow merge commits is never merged by Forerunner: one sentence", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    m.host.setMergeSettings(FULL, { allowMergeCommit: false });
    const t = await m.runTask("Add feature");
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "left_to_you", last_outcome: "merge_commits_off" });
    const pr = await m.pr(t.id);
    expect(record.sentence).toBe(
      `This repository does not allow merge commits, and Forerunner merges only with one: merge #${pr.number} on GitHub, or allow merge commits in its settings.`,
    );
    expect((await inboxCards(m, t.id)).map((c) => c.body)).toEqual([record.sentence]);
  });

  it("(h) a merge left to the person always says why: the level's refusal and an unknown reviewed version", async () => {
    const m = await recordWorld({ level: 2 });
    const t = await m.runTask("Add feature");
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "left_to_you", last_outcome: "not_allowed" });
    expect(record.sentence).toMatch(/^#\d+ waits for you to merge it/);
    // No worktree: the reviewed version is unknown, nothing is merged, and the record says so.
    await m.setMode("after_review");
    await rm(join(m.worktreeRoot, t.id), { recursive: true, force: true });
    const outcome = await m.merge.mergeReviewed({
      task: await m.w.store.task.mustGet(t.id),
      session: { id: "s-x" } as never,
      token: m.w.tokens.issue({
        runId: "r",
        sessionId: "s-x",
        agentId: m.w.alice,
        ownerHumanId: m.w.human,
        projectId: m.w.project,
        allowedTools: [MERGE_PR_TOOL],
        allowedPaths: [m.worktreeRoot],
        allowedDomains: ["127.0.0.1"],
        grantedSecrets: [],
        budgetUsdMicro: 0,
        depth: 0,
        maxDepth: 2,
        autonomy: 3,
        planApproved: false,
        expiresAt: new Date(m.w.clock.now() + 3_600_000).toISOString(),
      }),
      budget: undefined as never,
      signal: new AbortController().signal,
      agentId: m.w.alice,
    });
    expect(outcome?.status).toBe("unverified");
    const unknown = await m.record(t.id);
    expect(unknown.state).toBe("left_to_you");
    expect(unknown.sentence).toMatch(/does not know which version/);
    expect((await m.pr(t.id)).merged).toBe(false);
  });
});

/**
 * leftovers7-merge (R-mergeretry): the watcher's retry pass made a full gated `merge_pr` call
 * for every waiting record at every poll (its own token, one audit row, about five GitHub
 * calls; up to 1440 tries a record), and a merge it or the start-up resume made told the
 * person nothing (design §3.8: what the app did by itself is an Update).
 */
describe("the retry pass reads the checks first and says what it merged (R-mergeretry)", {
  timeout: 180_000,
}, () => {
  const updates = async (m: Awaited<ReturnType<typeof recordWorld>>) =>
    (await m.w.store.message.inbox({ humanId: m.w.human }, { limit: 100 })).map((x) => x.body);

  it("checks still running: no token, no audit row, the attempt counted; once green one audit row, the merge, and one Update 'Merged #N'", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    expect(await m.record(t.id)).toMatchObject({ state: "waiting_checks", attempts: 1 });
    const before = await updates(m);
    const issued = vi.spyOn(m.w.tokens, "issue");
    const rows = mergeRows(m.audit).length;
    for (let i = 0; i < 3; i++) await m.merge.retryWaiting();
    expect(issued).not.toHaveBeenCalled();
    expect(mergeRows(m.audit)).toHaveLength(rows);
    expect(await m.record(t.id)).toMatchObject({
      state: "waiting_checks",
      attempts: 4,
      last_outcome: "checks_pending",
    });
    expect((await m.pr(t.id)).merged).toBe(false);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(issued).toHaveBeenCalledTimes(1);
    expect(mergeRows(m.audit)).toHaveLength(rows + 1);
    expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
    const added = (await updates(m)).filter((b) => !before.includes(b));
    expect(added).toEqual([`Merged #${pr.number}: "Add feature".`]);
    const message = (await m.w.store.message.inbox({ humanId: m.w.human }, { limit: 100 })).find(
      (x) => x.body === added[0],
    );
    expect(message).toMatchObject({ project_id: m.w.project, task_id: t.id, type: "info" });
    // A later pass has nothing to do and says nothing more.
    await m.merge.retryWaiting();
    expect((await updates(m)).filter((b) => !before.includes(b))).toHaveLength(1);
    issued.mockRestore();
  });

  it("a merge inside a session adds no Update: the session's result says it", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature");
    expect((await m.record(t.id)).state).toBe("merged");
    expect((await updates(m)).filter((b) => b.startsWith("Merged #"))).toEqual([]);
  });

  it("the start-up resume: a record a dead process left merging that GitHub merged meanwhile posts the Update once", async () => {
    const m = await recordWorld({ level: 2, mode: "after_review" });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    const record = await m.record(t.id);
    await m.w.store.mergeRecord.move(record.id, "merging");
    await m.github.mergePullRequest(REPO, pr.number, { method: "merge" });
    await m.merge.resumeAtStart();
    expect((await m.record(t.id)).state).toBe("merged");
    expect((await updates(m)).filter((b) => b.startsWith("Merged #"))).toEqual([
      `Merged #${pr.number}: "Add feature".`,
    ]);
  });
});
