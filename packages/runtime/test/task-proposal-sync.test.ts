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
        (calls[0]?.params as { task?: string } | undefined)?.task === "Publish the page"
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

/**
 * l4-chat-final, run L4 (L4h-left-4; the review of l4-chat-carried, C4-left-5's words): the Done
 * line read the card's proposed changes, not the applied ones, so a set whose split was left out
 * and whose drop applied still said "your next Start runs it"; and it said so when what changed
 * waits for a task only the person can do, which no Start runs (design section 5 rules 4 and 9).
 */
describe("l4-chat-final, run L4: the suggestion card's Done line follows what was applied (L4h-left-4)", () => {
  const split = {
    line: 'Split "Style the page" into "Style the page: layout" and "Style the page: colours".',
    calls: [{ name: "task.split", params: { task: "t1" } }],
  };
  const drop = {
    line: 'Drop "Style the page (copy)": same as "Style the page".',
    calls: [
      { name: "task.transition", params: { task: "t2", to: "cancelled", duplicate_of: "t1" } },
    ],
  };

  it("a set whose split was left out and whose drop applied promises no Start", () => {
    expect(
      proposalOutcome({
        outcome: "applied",
        changed: 1,
        running: false,
        changes: [split, drop],
        left_out: [
          'Split "Style the page" into "Style the page: layout" and "Style the page: colours": "Style the page" is running now',
        ],
      }),
    ).toBe(
      'Changed 1 task. Left out: Split "Style the page" into "Style the page: layout" and "Style the page: colours": "Style the page" is running now.',
    );
  });

  // fixup-l4-chat-final (the review's prefix item): a left-out line is the change's own line and
  // then ": why"; a change whose line only starts the left-out one's was applied.
  it("a change whose line starts a left-out change's line still counts as applied", () => {
    const change = {
      line: 'Change "Style the page".',
      calls: [{ name: "task.update", params: { task: "t1" } }],
    };
    const both = {
      line: 'Change "Style the page" and "Write the FAQ".',
      calls: [{ name: "task.update", params: { task: "t3" } }],
    };
    expect(
      proposalOutcome({
        outcome: "applied",
        changed: 2,
        running: false,
        changes: [change, both, drop],
        left_out: ['Change "Style the page" and "Write the FAQ": "Write the FAQ" is running now'],
      }),
    ).toBe(
      'Changed 2 tasks; your next Start runs them. Left out: Change "Style the page" and "Write the FAQ": "Write the FAQ" is running now.',
    );
  });

  it("what changed waits for a task only the person can do: the line names it and promises no Start", async () => {
    expect(
      proposalOutcome({
        outcome: "applied",
        changed: 1,
        running: false,
        changes: [split],
        waits_for_you: "Send the logo",
      }),
    ).toBe('Changed 1 task; it waits for "Send the logo", which is yours to do.');
    expect(
      proposalOutcome({
        outcome: "applied",
        changed: 2,
        running: false,
        changes: [split, split],
        waits_for_you: "Send the logo",
      }),
    ).toBe('Changed 2 tasks; they wait for "Send the logo", which is yours to do.');
    // At the apply: the card records the person's task the changed tasks wait for.
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const seeded = await seedWorld(store, {}, { session: false });
    const logo = await store.task.insert({
      project_id: seeded.project,
      title: "Send the logo",
      outcome: "The logo is here.",
      status: "needs_human",
      specialist: "person",
    } as never);
    const style = await store.task.insert({
      project_id: seeded.project,
      title: "Style the page",
      outcome: "Styled.",
      status: "ready",
      depends_on: [logo.id],
    } as never);
    const c = await card(store, seeded, [{ line: 'Change "Style the page".', task: style.id }]);
    await answer(store, c.id, seeded.human);
    await syncTaskProposals({
      store,
      clock: h.clock,
      humanId: seeded.human,
      check: async () => null,
      apply: async () => ({ changeLogId: "change-1" }),
      admit: async () => false,
    });
    const settled = (await store.humanRequest.mustGet(c.id)).change_card as Record<string, unknown>;
    expect(settled.waits_for_you).toBe("Send the logo");
    expect(proposalOutcome(settled)).toBe(
      'Changed 1 task; it waits for "Send the logo", which is yours to do.',
    );
    await store.close();
  });
});
