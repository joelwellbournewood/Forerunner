import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { proposalOutcome } from "../src/daemon/task-proposal-words.ts";
import {
  type ProposalSyncDeps,
  syncTaskProposals,
  TASK_PROPOSAL_KEY,
  TASK_PROPOSAL_OPTIONS,
} from "../src/session/task-proposal.ts";
import { seedWorld } from "./context-helpers.ts";
import { harness } from "./helpers.ts";

/**
 * l4-chat-final, run L4 (L4h-left-5; the review of l4-chat-carried's C4-left-7): an answered
 * suggestion card is applied once. A second sync in the same process that read the card as
 * 'applying' before the first one settled it took it for a crash's leftover and settled it again:
 * a set the first sync could not make was tried a second time. The mark is now a compare-and-set
 * on the card's version. A card a crash left at 'applying' whose change had been made also names
 * the changes the apply left out, and admits the tasks it touched, as the first apply does.
 */

interface Gate {
  wait: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open = () => {};
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

async function card(
  store: StateStore,
  seeded: { human: string; project: string },
  lines: { line: string; task: string }[],
) {
  return store.humanRequest.insert({
    human_id: seeded.human,
    project_id: seeded.project,
    session_id: null,
    kind: "decision",
    why: "The agent suggests changes.",
    steps: lines.map((l) => l.line),
    options: [...TASK_PROPOSAL_OPTIONS],
    blocking: false,
    risk: "low",
    change_card: {
      key: TASK_PROPOSAL_KEY,
      project_id: seeded.project,
      session_id: null,
      fingerprint: lines.map((l) => l.line).join("|"),
      changes: lines.map((l) => ({
        line: l.line,
        calls: [{ name: "task.update", params: { task: l.task, priority: "high" } }],
      })),
      quotes: [],
      reasons: [],
    },
  });
}

async function answer(store: StateStore, id: string, human: string) {
  const row = await store.humanRequest.mustGet(id);
  await store.humanRequest.answer(id, row.version, TASK_PROPOSAL_OPTIONS[0] as never, human);
}

describe("l4-chat-final, run L4: a suggestion card is settled once (L4h-left-5)", () => {
  it("a second sync that read the card as 'applying' while the first applied it does not apply it again", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const seeded = await seedWorld(store, {}, { session: false });
    // Y is filed first (listed first) and answered second; R is answered first.
    const y = await card(store, seeded, [
      { line: 'Change "Write the FAQ".', task: "Write the FAQ" },
    ]);
    const r = await card(store, seeded, [
      { line: 'Change "Publish the page".', task: "Publish the page" },
    ]);
    const applied: string[] = [];
    const gates = new Map<string, Gate>([
      [r.id, gate()],
      [y.id, gate()],
    ]);
    const deps: ProposalSyncDeps = {
      store,
      clock: h.clock,
      humanId: seeded.human,
      check: async () => null,
      apply: async (_calls, ctx) => {
        applied.push(ctx.requestId);
        await gates.get(ctx.requestId)?.wait;
        // R's set cannot be made (the commands refuse it): it must not be tried again.
        return ctx.requestId === r.id
          ? { refused: '"Publish the page" changed since' }
          : { changeLogId: "change-y" };
      },
      admit: async () => false,
    };
    await answer(store, r.id, seeded.human);
    // The first sync marks R 'applying' and waits in its apply.
    const first = syncTaskProposals(deps);
    while (!applied.includes(r.id)) await new Promise((t) => setTimeout(t, 1));
    // The second sync lists Y (new) and R as 'applying', and waits in Y's apply.
    await answer(store, y.id, seeded.human);
    const second = syncTaskProposals(deps);
    while (!applied.includes(y.id)) await new Promise((t) => setTimeout(t, 1));
    // The first sync settles R (not made), then the second reaches its stale view of R.
    gates.get(r.id)?.open();
    expect(await first).toEqual({ applied: 0, kept: 0, failed: 1 });
    gates.get(y.id)?.open();
    expect(await second).toEqual({ applied: 1, kept: 0, failed: 0 });
    expect(applied).toEqual([r.id, y.id]);
    const settled = (await store.humanRequest.mustGet(r.id)).change_card as Record<string, unknown>;
    expect(settled.outcome).toBe("not_applied");
    expect(settled.left_out).toEqual(['"Publish the page" changed since']);
    expect(proposalOutcome(settled)).toBe(
      'Nothing changed: none of the changes applies now. Left out: "Publish the page" changed since.',
    );
    await store.close();
  });

  it("a card a crash left at 'applying' after its change was made names the change the apply left out and admits the task it changed", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const seeded = await seedWorld(store, {}, { session: false });
    const faq = await store.task.insert({
      project_id: seeded.project,
      title: "Write the FAQ",
      outcome: "An FAQ.",
      status: "ready",
    } as never);
    const c = await card(store, seeded, [
      { line: 'Change "Write the FAQ".', task: faq.id },
      { line: 'Change "Publish the page".', task: "Publish the page" },
    ]);
    await answer(store, c.id, seeded.human);
    // What a crash leaves: the card marked, the first change made as one row, no outcome.
    const marked = await store.humanRequest.mustGet(c.id);
    const at = h.clock.nowIso();
    await store.humanRequest.patch(c.id, {
      change_card: {
        ...(marked.change_card as Record<string, unknown>),
        outcome: "applying",
        applying_at: at,
      },
    });
    h.clock.advance(1000);
    await store.changeLog.record({
      human_id: seeded.human,
      agent_id: seeded.agent,
      words_used: "Make these changes",
      commands: [{ name: "task.update", params: { task: faq.id, priority: "high" } }],
      before: {},
      after: { task_id: faq.id },
      scope: "project",
      project_id: seeded.project,
      expires_at: null,
      undo_state: "undoable",
      source: "ui",
      sentence: 'Changed "Write the FAQ": priority to High.',
      author_human: seeded.human,
      author_agent: null,
    } as never);
    const admitted: string[][] = [];
    const out = await syncTaskProposals({
      store,
      clock: h.clock,
      humanId: seeded.human,
      // Why the second change does not apply now (the commands' own check).
      check: async (calls) =>
        (calls[0]?.params as { task?: string }).task === "Publish the page"
          ? 'no task "Publish the page"'
          : null,
      apply: async () => {
        throw new Error("the change was made already: nothing is applied twice");
      },
      admit: async (_p, ids) => {
        admitted.push([...ids]);
        return false;
      },
    });
    expect(out).toEqual({ applied: 1, kept: 0, failed: 0 });
    const settled = (await store.humanRequest.mustGet(c.id)).change_card as Record<string, unknown>;
    expect(settled.outcome).toBe("applied");
    expect(settled.changed).toBe(1);
    expect(settled.left_out).toEqual(['Change "Publish the page": no task "Publish the page"']);
    expect(proposalOutcome(settled)).toBe(
      'Changed 1 task; your next Start runs it. Left out: Change "Publish the page": no task "Publish the page".',
    );
    expect(admitted).toEqual([[faq.id]]);
    await store.close();
  });
});
