import type { HumanRequestRow, TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { requestWords } from "../src/daemon/request-words.ts";
import { type TaskDisplayContext, taskDisplay } from "../src/daemon/task-words.ts";

/**
 * w15-words (wave 15 run B): each sentence a person reads, at the function that writes it
 * (design §5). The screens' and routes' cases are in apps/ui/test (real-daemon.test.ts and the
 * UI suites), each in a block of the same name.
 */
describe("w15-words, wave 15 run B", () => {
  describe("W15-56: a task paused before it wrote anything", () => {
    const paused = (): TaskRow =>
      ({
        id: "t1",
        title: "Write the guide for members",
        status: "needs_human",
        reason: '"Write the guide for members" paused at its budget of CHF 0.01.',
        depends_on: [],
        pr_url: null,
        author_agent: "agent_1",
        author_human: null,
      }) as unknown as TaskRow;
    const budgetCard = (extra: Record<string, unknown> = {}) =>
      ({
        id: "req_1",
        kind: "approval",
        why: '"Write the guide for members" paused at its budget of CHF 0.01.',
        steps: [],
        options: ["Continue (CHF 0.01 more)", "Cancel task"],
        status: "open",
        answer: null,
        change_card: {
          key: "task:budget_stop",
          task_id: "t1",
          title: '"Write the guide for members" paused at its budget of CHF 0.01',
          source: "task_budget",
          continue_usd_micro: 12_500,
          chf_per_usd: 0.8,
          done: "",
          left: [],
          ...extra,
        },
      }) as unknown as HumanRequestRow;
    const ctx = (heldWork?: Set<string>): TaskDisplayContext =>
      ({
        tasks: new Map([["t1", paused()]]),
        cards: new Map([["t1", budgetCard()]]),
        sandboxReady: true,
        runs: new Map(),
        agentNames: new Map(),
        ...(heldWork ? { heldWork } : {}),
      }) as unknown as TaskDisplayContext;

    it("the row says nothing is set aside unless its run wrote something", () => {
      const none = taskDisplay(paused(), ctx());
      expect(none.label).toBe("Paused at its budget");
      expect(none.cancelWork).toBeUndefined();
      const held = taskDisplay(paused(), ctx(new Set(["t1"])));
      expect(held.cancelWork).toBe(
        "Its work so far is set aside unless a later task built on it; Undo brings it back.",
      );
    });

    it("the card says it stopped before it wrote anything and Cancel only drops it", () => {
      const cancel = (w: ReturnType<typeof requestWords>) =>
        w.choices.find((c) => c.label === "Cancel task")?.explain;
      const empty = requestWords(budgetCard(), { heldWork: false });
      expect(empty.body).toBe("It stopped before it wrote anything.");
      expect(cancel(empty)).toBe("Drops it.");
      const waits = requestWords(budgetCard(), {
        heldWork: false,
        waiting: ["Check the guide reads well"],
      });
      expect(waits.body).toBe(
        'It stopped before it wrote anything. "Check the guide reads well" waits on it.',
      );
      expect(cancel(waits)).toBe('Drops it; "Check the guide reads well" will be stuck.');
      expect(cancel(requestWords(budgetCard(), { heldWork: false, waiting: ["A", "B"] }))).toBe(
        "Drops it; the 2 tasks after it will be stuck.",
      );
      // A run that wrote something keeps the set-aside line (and the kept work).
      const wrote = requestWords(budgetCard(), { heldWork: true });
      expect(wrote.body).toBe(
        "It stopped before it could say where it stood; its work so far is kept.",
      );
      expect(cancel(wrote)).toBe(
        "Drops it; its work is set aside unless a later task built on it.",
      );
      // Its own note is data and stays, whatever it wrote.
      expect(
        requestWords(budgetCard({ done: "members.md has an outline" }), { heldWork: false }).body,
      ).toBe("Done: members.md has an outline.");
    });
  });
});
