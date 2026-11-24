import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { requestWords } from "../src/daemon/request-words.ts";
import { MERGE_LEFT_OPEN_KEY } from "../src/loop/merge.ts";
import { syncPrAnswers } from "../src/session/pr-answers.ts";
import { seedWorld } from "./context-helpers.ts";
import { harness } from "./helpers.ts";

/**
 * l4-chat-final, run L4 (L4h-left-5; the review of l4-chat-carried, C4-left-7's sibling): the
 * merged-through card's Take this work out is marked 'taken_out' before the take-out runs, so a
 * second sync opens no second pull request. A crash between the mark and the take-out's answer
 * left the card at "Taking the work out: the answer comes in a moment." for good: nothing at the
 * next start looked at it again. The next sync finishes it, once.
 */
describe("l4-chat-final, run L4: a Take this work out cut short by a crash is finished at the next start (L4h-left-5)", () => {
  it("the next sync asks the take-out again and the Answered line says what came of it; a later sync asks nothing", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const seeded = await seedWorld(store, {}, { session: false });
    const task = await store.task.insert({
      project_id: seeded.project,
      title: "Add page",
      outcome: "page.html",
      status: "done",
      pr_url: "https://github.example/acme/site/pull/12",
    } as never);
    const card = await store.humanRequest.insert({
      human_id: seeded.human,
      project_id: seeded.project,
      task_id: task.id,
      kind: "decision",
      why: '"Add page" reached main through #13.',
      steps: [],
      options: ["Take this work out", "Keep it"],
      blocking: false,
      risk: "low",
      change_card: { key: MERGE_LEFT_OPEN_KEY, pr_url: task.pr_url },
    } as never);
    const open = await store.humanRequest.mustGet(card.id);
    await store.humanRequest.answer(
      card.id,
      open.version,
      "Take this work out" as never,
      seeded.human,
    );
    // What a crash between the mark and the take-out's answer leaves: marked, no answer.
    const answered = await store.humanRequest.mustGet(card.id);
    await store.humanRequest.patch(card.id, {
      change_card: {
        ...(answered.change_card as Record<string, unknown>),
        applied_at: h.clock.nowIso(),
        outcome: "taken_out",
      },
    });
    const cut = await store.humanRequest.mustGet(card.id);
    expect(requestWords(cut).outcome).toBe("Taking the work out: the answer comes in a moment.");
    const asked: string[] = [];
    const deps = {
      store,
      clock: h.clock,
      humanId: seeded.human,
      agentId: seeded.agent,
      takeOut: {
        takeOut: async (id: string) => {
          asked.push(id);
          return {
            state: "opened" as const,
            sentence: 'Opened #14 to take "Add page" out of main: merge it to finish.',
            number: 14,
            url: "https://github.example/acme/site/pull/14",
            builtOn: [],
          };
        },
      },
    };
    // The daemon started again: its first sync.
    await syncPrAnswers(deps as never);
    expect(asked).toEqual([task.id]);
    const done = await store.humanRequest.mustGet(card.id);
    expect(requestWords(done).outcome).toBe(
      'Opened #14 to take "Add page" out of main: merge it to finish.',
    );
    // Nothing is asked twice.
    await syncPrAnswers(deps as never);
    expect(asked).toEqual([task.id]);
    await store.close();
  });
});
