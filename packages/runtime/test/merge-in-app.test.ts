import { describe, expect, it } from "vitest";
import { MERGE_PR_TOOL } from "../src/loop/merge.ts";
import { forcedPushes, inboxCards, mergeRows, recordWorld } from "./merge-world.ts";

/**
 * merge-in-app (the owner's decision of 2026-11-02): who merges is the project's merge mode, not
 * the autonomy level; in the default mode ("You press Merge") the person's Merge in the app
 * merges a pull request and the ones it builds on, in order, each with a merge commit, through
 * the one gated merge entry (ADR 0111). Real git against the fake git host.
 */
describe("the merge mode and the person's Merge in the app (merge-in-app)", {
  timeout: 180_000,
}, () => {
  it("'You press Merge' leaves the accepted PR open at Autopilot too, with one sentence and no card; the audit row says the mode refused", async () => {
    const m = await recordWorld({ level: 4 });
    const t = await m.runTask("Add feature");
    const pr = await m.pr(t.id);
    expect(pr.merged).toBe(false);
    expect(await m.record(t.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "not_allowed",
      sentence: `#${pr.number} waits for you to merge it: press Merge on the Overview.`,
    });
    expect(await inboxCards(m, t.id)).toEqual([]);
    expect(mergeRows(m.audit).at(-1)?.deniedReason).toBe(
      'autonomy_insufficient: the project\'s merge mode is "You press Merge"',
    );
  });

  it("the person's Merge on the dependent merges what it builds on first, each a merge commit, in order, nothing forced", async () => {
    const m = await recordWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const [prA, prB] = [await m.pr(a.id), await m.pr(b.id)];
    const records = await m.merge.approveInOrder(
      [await m.w.store.task.mustGet(a.id), await m.w.store.task.mustGet(b.id)],
      m.w.human,
    );
    expect(records.map((r) => [r.task_id, r.state, r.approval, r.approved_by])).toEqual([
      [a.id, "queued", "person", m.w.human],
      [b.id, "queued", "person", m.w.human],
    ]);
    const outcomes = await m.merge.mergeApproved(records, m.w.human);
    expect(outcomes.map((o) => o.status)).toEqual(["merged", "merged"]);
    const [ra, rb] = [await m.record(a.id), await m.record(b.id)];
    const parents = async (sha: string | null) =>
      (await m.hostGit("rev-list", "--parents", "-n", "1", sha ?? "")).split(" ").slice(1);
    expect(await parents(ra.merge_sha)).toEqual([expect.any(String), prA.head.sha]);
    // B merges after A: A's merge commit is B's merge's first parent.
    expect(await parents(rb.merge_sha)).toEqual([ra.merge_sha, prB.head.sha]);
    expect(forcedPushes(m.host, prA.head.ref)).toEqual([]);
    expect(forcedPushes(m.host, prB.head.ref)).toEqual([]);
    // The audit rows say whose click approved each merge.
    const allowed = mergeRows(m.audit).filter((r) => r.allowed);
    expect(allowed.length).toBeGreaterThanOrEqual(2);
    for (const r of allowed.slice(-2)) expect(r.inputSummary).toContain(`the person ${m.w.human}`);
  });

  it("a Merge whose first PR waits for its checks keeps the order: the retry merges nothing out of turn, then both once the checks pass", async () => {
    const m = await recordWorld({ level: 2 });
    const a = await m.runTask("Add page", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prA = await m.pr(a.id);
    const records = await m.merge.approveInOrder(
      [await m.w.store.task.mustGet(a.id), await m.w.store.task.mustGet(b.id)],
      m.w.human,
    );
    const first = await m.merge.mergeApproved(records, m.w.human);
    expect(first.map((o) => o.status)).toEqual(["checks_pending"]);
    expect((await m.record(a.id)).state).toBe("waiting_checks");
    expect(await m.record(b.id)).toMatchObject({ state: "queued", approval: "person" });
    // The watcher's retry while A's checks run: A waits, B waits its turn (not merged, no row).
    const rowsBefore = mergeRows(m.audit).length;
    await m.merge.retryWaiting();
    expect((await m.pr(b.id)).merged).toBe(false);
    expect((await m.record(b.id)).state).toBe("queued");
    expect(mergeRows(m.audit).length).toBe(rowsBefore + 1);
    await m.check(prA.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    const [ra, rb] = [await m.record(a.id), await m.record(b.id)];
    expect([ra.state, rb.state]).toEqual(["merged", "merged"]);
    const parents = (await m.hostGit("rev-list", "--parents", "-n", "1", rb.merge_sha ?? ""))
      .split(" ")
      .slice(1);
    expect(parents[0]).toBe(ra.merge_sha);
    expect(mergeRows(m.audit).at(-1)?.tool).toBe(MERGE_PR_TOOL);
  });

  it("a Merge whose first PR goes to the person (a check failed) leaves the rest to the person too, each with one sentence", async () => {
    const m = await recordWorld({ level: 2 });
    const a = await m.runTask("Add page", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "completed", "failure"),
    });
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const [prA, prB] = [await m.pr(a.id), await m.pr(b.id)];
    const records = await m.merge.approveInOrder(
      [await m.w.store.task.mustGet(a.id), await m.w.store.task.mustGet(b.id)],
      m.w.human,
    );
    await m.merge.mergeApproved(records, m.w.human);
    expect((await m.record(a.id)).last_outcome).toBe("checks_failed");
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      approval: "none",
      sentence: `#${prB.number} builds on #${prA.number}, which was not merged: merge #${prA.number} first.`,
    });
    // Nothing later merges B unattended in this mode.
    await m.merge.retryWaiting();
    expect((await m.pr(b.id)).merged).toBe(false);
  });
});
