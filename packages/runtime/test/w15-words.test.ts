import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { HumanRequestRow, TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { requestWords } from "../src/daemon/request-words.ts";
import { startBlocked } from "../src/daemon/start-blocked.ts";
import {
  LEFT_TO_YOU_LABELS,
  type TaskDisplayContext,
  taskDisplay,
  WAITING_FOR_YOUR_MERGE,
} from "../src/daemon/task-words.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { OWED_FOLDER_LABEL } from "../src/loop/merge-mode.ts";
import { budgetStopTitle, continueLabel } from "../src/session/budget-card.ts";
import { wrapUpSentWords } from "../src/session/budget-pause.ts";
import { aboutWords } from "../src/session/money-words.ts";
import { sessionResultLines, stopWords } from "../src/session/result.ts";

/** USD micro to CHF text at the test's rate, as the executor's chfText (before moneyWords). */
const chf = (usdMicro: number) => formatChf(usdToChfMicro(usdMicro, 0.8));

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

  describe("W15-74: an amount under a centime never reads CHF 0.00", () => {
    // USD 0.004 is CHF 0.0032 at the test's rate: above zero, under a centime.
    const tiny = 4_000;

    it("aboutWords: an estimate says 'about' only where it adds something", () => {
      expect(aboutWords("CHF 0.40", 400_000)).toBe("about CHF 0.40");
      expect(aboutWords("CHF 0.00", 3_200)).toBe("less than CHF 0.01");
      expect(aboutWords("CHF 0.00", 0)).toBe("about CHF 0.00");
    });

    it("the budget card's title, button and reasons", () => {
      const stop = { capUsdMicro: tiny, source: "task_budget" as const, specialist: "coder" };
      expect(budgetStopTitle({ title: "Write the note" }, stop, 0.8)).toBe(
        '"Write the note" paused at its budget of less than CHF 0.01',
      );
      expect(budgetStopTitle({ title: "Write the note" }, { ...stop, capUsdMicro: 0 }, 0.8)).toBe(
        '"Write the note" paused at its budget of CHF 0.00',
      );
      expect(continueLabel(tiny, 0.8)).toBe("Continue (less than CHF 0.01 more)");
      expect(continueLabel(12_500, 0.8)).toBe("Continue (CHF 0.01 more)");
      // The card's Continue line reads the same rule.
      const words = requestWords(
        {
          id: "r",
          kind: "approval",
          why: "",
          steps: [],
          options: ["Continue (less than CHF 0.01 more)", "Cancel task"],
          status: "open",
          answer: null,
          change_card: {
            key: "task:budget_stop",
            source: "task_budget",
            continue_usd_micro: tiny,
            chf_per_usd: 0.8,
            done: "",
            left: [],
          },
        } as unknown as HumanRequestRow,
        {},
      );
      expect(words.choices[0]?.explain).toBe(
        "Adds less than CHF 0.01 to its budget and starts a session that goes on from where it stopped.",
      );
    });

    it("the session log's start and plan lines, and the session's result", () => {
      const started = describeEvent(
        "task.started",
        { taskId: "t1", title: "Write the note", specialist: "coder", estimateUsdMicro: tiny },
        0.8,
      );
      expect(started).toContain("(less than CHF 0.01)");
      expect(started).not.toMatch(/CHF 0\.00|about less/);
      const planned = describeEvent("session.planned", { items: 1, estimateUsdMicro: tiny }, 0.8);
      expect(planned).toContain("less than CHF 0.01");
      expect(planned).not.toMatch(/CHF 0\.00|about less/);
      const base = {
        outcome: {
          done: [{ id: "t0", title: "Write the intro" }],
          failed: [],
          needsYou: [],
          leftOver: [],
          waiting: [],
          waitingForDocker: [],
          stopReason: "budget_exceeded",
          spentChfMicro: 3_000,
        },
        inReview: [],
        leftOutForBudget: [{ id: "t1", title: "Write the note", estimateChfMicro: 3_200 }],
        sessionCapChfMicro: 4_000,
        openTasks: 1,
      };
      const left = sessionResultLines(base as never).join(" ");
      expect(left).toContain(
        'Left for next time: "Write the note" (less than CHF 0.01); this session\'s less than CHF 0.01 was used.',
      );
      expect(left).not.toContain("CHF 0.00");
      const nothing = sessionResultLines({
        ...base,
        outcome: { ...base.outcome, done: [], stopReason: "nothing_runnable", spentChfMicro: 0 },
        workBudgetChfMicro: 3_000,
      } as never).join(" ");
      expect(nothing).toContain(
        'Nothing could run: "Write the note" needs less than CHF 0.01, more than this session\'s work budget of less than CHF 0.01.',
      );
      expect(stopWords("budget_project", 3_000)).toBe(
        "Stopped at the project's budget of less than CHF 0.01.",
      );
    });

    it("the Start check's refusal of a task larger than the budget", () => {
      const blocked = startBlocked(
        {
          runnable: [],
          ready: 1,
          waiting: [],
          overBudget: [{ taskId: "t1", title: "Write the note", estimateUsdMicro: tiny }],
        } as never,
        { stopped: false, hasModel: true, projectId: "p1", chfPerUsd: 0.8 } as never,
      );
      expect(blocked?.sentence).toBe(
        'Nothing can run within this budget: "Write the note" needs less than CHF 0.01.',
      );
    });

    it("the wrap-up note says 'less than CHF 0.01' at most once (W15B-77)", () => {
      const line = { capUsdMicro: 6_000, lineUsdMicro: 4_000, reserveUsdMicro: 2_000 } as never;
      const tinyAll = wrapUpSentWords("coder", 3_000, 6_000, line, chf);
      expect(tinyAll).toBe(
        "Told the coder to wrap up: it may spend less than CHF 0.01, and its next step could leave too little to finish.",
      );
      expect(tinyAll.match(/less than CHF 0\.01/g)).toHaveLength(1);
      expect(wrapUpSentWords("coder", 3_000, 6_000, undefined, chf)).toBe(
        "Told the coder to wrap up: it may spend less than CHF 0.01.",
      );
      // One amount under a centime: each amount said, that one once.
      expect(
        wrapUpSentWords(
          "coder",
          3_000,
          500_000,
          { capUsdMicro: 500_000, lineUsdMicro: 400_000, reserveUsdMicro: 100_000 } as never,
          chf,
        ),
      ).toBe(
        "Told the coder to wrap up: it spent less than CHF 0.01 of CHF 0.40, and its next step could take it past CHF 0.32.",
      );
    });
  });

  describe("W15B-12: the Done line counts every task whose accepted work needs the person", () => {
    const line = (...labels: string[]) => {
      const tasks = labels.map((_, i) => ({
        id: `t${i}`,
        title: `Task ${i}`,
        status: "done" as const,
        depends_on: [],
      }));
      return projectStatusLine({
        projectId: "p1",
        tasks,
        displays: new Map(
          labels.map((label, i) => [`t${i}`, { key: "done", label, tone: "good" } as never]),
        ),
        cards: [],
        plan: null,
        working: null,
        folder: "/work/p1",
      });
    };
    const overview = { kind: "link", label: "Open Overview", to: "/projects/p1" };

    it("plain waits keep their words; every other wait is said as needing the person", () => {
      expect(line(WAITING_FOR_YOUR_MERGE, WAITING_FOR_YOUR_MERGE)).toMatchObject({
        text: "Done: all 2 tasks. 2 pull requests wait for you to merge.",
        action: overview,
      });
      expect(
        line(WAITING_FOR_YOUR_MERGE, OWED_FOLDER_LABEL, "Accepted · pull request closed"),
      ).toMatchObject({
        text: "Done: all 3 tasks. 1 pull request waits for you to merge, and 2 need you on the Overview.",
        action: overview,
      });
    });

    it("one case per counted label: never 'waits to be merged' for a closed or unbuilt one", () => {
      const counted = [
        OWED_FOLDER_LABEL,
        "Accepted · conflicts with main",
        ...new Set(Object.values(LEFT_TO_YOU_LABELS)),
      ];
      for (const label of counted) {
        const said = line("Merged", label);
        expect(said.text, label).toBe("Done: all 2 tasks. 1 task needs you on the Overview.");
        expect(said.action, label).toEqual(overview);
        expect(said.text, label).not.toMatch(/merge\./);
      }
      expect(line("Merged", OWED_FOLDER_LABEL, "Accepted · a check failed").text).toBe(
        "Done: all 3 tasks. 2 tasks need you on the Overview.",
      );
    });

    it("work that merges by itself is not counted; W15-108's taken-out form stays", () => {
      expect(
        line("Merged", "Accepted · merging", "Accepted · merges when its checks pass"),
      ).toEqual({
        kind: "done",
        text: "Done: all 3 tasks.",
        action: { kind: "link", label: "Open your files", to: "/projects/p1/files" },
      });
      expect(line("Taken out in #4", "Merged").text).toBe("Done: all 2 tasks; 1 taken out.");
    });
  });
});
