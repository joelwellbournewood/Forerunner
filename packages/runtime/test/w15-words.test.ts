import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { HumanRequestRow, TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { personLine } from "../src/daemon/event-lines.ts";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { leftOpenCardTitle, requestWords } from "../src/daemon/request-words.ts";
import { startBlocked } from "../src/daemon/start-blocked.ts";
import { runOutcomeWords } from "../src/daemon/task-display.ts";
import {
  LEFT_TO_YOU_LABELS,
  type TaskDisplayContext,
  taskDisplay,
  WAITING_FOR_YOUR_MERGE,
} from "../src/daemon/task-words.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { headMovedSentence, leftOpenSteps } from "../src/loop/merge.ts";
import { OWED_FOLDER_LABEL } from "../src/loop/merge-mode.ts";
import { budgetStopTitle, continueLabel } from "../src/session/budget-card.ts";
import { wrapUpSentWords } from "../src/session/budget-pause.ts";
import {
  nothingRunsYetSentence,
  startKeepsWaitSentence,
  waitSentence,
  waitThenStartSentence,
} from "../src/session/credential-wait.ts";
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

  describe("W15-66, W15-65, W15-78, W15-67: a credential wait promises only what is kept", () => {
    const words = { timezone: "Europe/Zurich", nowMs: Date.parse("2026-11-09T08:00:00Z") };
    const resting = {
      reason: "limit" as const,
      sourceId: "s1",
      kind: "api_key" as const,
      until: "2026-11-09T08:30:00Z",
    };
    const refused = {
      reason: "refused" as const,
      sourceId: "s1",
      kind: "api_key" as const,
      until: null,
    };

    it("W15-66: the runs-on line where no wait is recorded never says it starts by itself", () => {
      expect(waitThenStartSentence(resting, words)).toBe(
        "Waits until 09:30 (your API key's limit). Press Start and the work starts then.",
      );
      expect(waitThenStartSentence(refused, words)).toBe(
        "Waits for a new API key: save one in Settings.",
      );
      // Where a wait is recorded (a session met it), the old sentence is true and stays.
      expect(waitSentence(resting, words)).toBe(
        "Waits until 09:30 (your API key's limit) and starts by itself.",
      );
    });

    it("W15-65: the Start check's sentence names what starts", () => {
      expect(startKeepsWaitSentence(resting, words)).toBe(
        "Nothing can run until 09:30 (your API key's limit). Press Start and the work starts then.",
      );
    });

    it("W15-78: the Start check's refusal has a subject; the run label names what was refused", () => {
      expect(nothingRunsYetSentence(waitSentence(resting, words))).toBe(
        "Nothing can run until 09:30 (your API key's limit); it starts by itself then.",
      );
      expect(nothingRunsYetSentence(waitSentence(refused, words))).toBe(
        "Nothing can run until you save a new API key in Settings.",
      );
      expect(
        nothingRunsYetSentence(waitSentence({ ...refused, kind: "subscription" }, words)),
      ).toBe("Nothing can run until you save a new Claude sign-in in Settings.");
      const blocked = startBlocked(
        { runnable: [{ taskId: "t1" }], ready: 1, waiting: [], overBudget: [] } as never,
        {
          stopped: false,
          hasModel: true,
          projectId: "p1",
          chfPerUsd: 0.8,
          credentialWait: { text: waitSentence(resting, words), save: null },
        } as never,
      );
      expect(blocked?.sentence).toBe(
        "Nothing can run until 09:30 (your API key's limit); it starts by itself then.",
      );
      expect(runOutcomeWords("credential_refused", "api_key")).toBe(
        "Stopped: Anthropic refused your API key",
      );
      expect(runOutcomeWords("credential_refused", "subscription")).toBe(
        "Stopped: Anthropic refused your subscription sign-in",
      );
      expect(runOutcomeWords("credential_refused", null)).toBe(
        "Stopped: Anthropic refused your key or sign-in",
      );
    });

    it("W15-67: the project's ready line names the wait and its time", () => {
      const ready = (
        credentialWaitNow: Parameters<typeof projectStatusLine>[0]["credentialWaitNow"],
      ) =>
        projectStatusLine({
          projectId: "p1",
          tasks: [{ id: "t1", title: "Write the note", status: "ready", depends_on: [] }],
          displays: new Map([["t1", { key: "ready", label: "Ready", tone: "neutral" } as never]]),
          cards: [],
          plan: null,
          working: null,
          folder: null,
          hasModel: true,
          credentialWaitNow,
        });
      expect(ready(null)).toMatchObject({ text: "Ready to continue: 1 task ready" });
      expect(
        ready({ text: startKeepsWaitSentence(resting, words), save: null, startable: true }),
      ).toEqual({
        kind: "ready",
        text: "Ready: 1 task; nothing runs until 09:30 (your API key's limit)",
        action: { kind: "start", label: "Continue", to: null },
      });
      expect(ready({ text: waitSentence(resting, words), save: null })).toEqual({
        kind: "ready",
        text: "Ready: 1 task; it starts by itself at 09:30 (your API key's limit)",
        action: null,
      });
      expect(
        ready({
          text: waitSentence(refused, words),
          save: { label: "Save a new key", to: "/setup" },
        }),
      ).toEqual({
        kind: "ready",
        text: "Ready: 1 task; nothing runs until you save a new API key",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });
    });
  });

  describe("W15B-11: the head-moved card", () => {
    it("is titled by what happened and its sentence names where each way out is", () => {
      const card = {
        key: "merge:left_open",
        status: "head_moved",
        pr_url: "https://github.example/o/r/pull/3",
        sentence: headMovedSentence(3),
      };
      expect(leftOpenCardTitle(card, "Write the page")).toBe(
        '"Write the page" changed after the review',
      );
      expect(headMovedSentence(3)).toBe(
        "#3 changed after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.",
      );
      expect(leftOpenSteps("head_moved")).toEqual([
        "Look at the commits pushed after the review",
        "Merge it yourself on GitHub, or redo the task from its row in Tasks",
      ]);
      // Other left-open cards keep their titles.
      expect(leftOpenCardTitle({ ...card, status: "checks_failed" }, "Write the page")).toBe(
        'The critic accepted "Write the page", but pull request #3 was not merged',
      );
      expect(
        leftOpenCardTitle({ ...card, notice: "conflict", base: "main" }, "Write the page"),
      ).toBe('"Write the page" conflicts with main');
    });
  });

  describe("W15B-14 (+W15B-79): the session log's lines name the right card", () => {
    const verdict = (card: string | undefined, couldNot?: string) =>
      personLine(
        "critic.verdict",
        {
          taskId: "t1",
          title: "Write the page",
          specialist: "writer-marketing",
          decision: "human",
          verdict: "revise",
          ...(card ? { card } : {}),
          ...(couldNot !== undefined ? { couldNot } : {}),
        },
        0.8,
      );

    it("a questions card reads as its card does; a sign-off as one; a decision as a decision", () => {
      expect(verdict("questions")).toBe('"Write the page": the specialist asks you (Inbox).');
      expect(verdict("signoff")).toBe('"Write the page" needs your sign-off (Inbox).');
      expect(verdict("retry")).toBe('"Write the page" needs your decision (Inbox).');
      // An event written before the card kind was carried reads as before.
      expect(verdict(undefined)).toBe('"Write the page" needs your decision (Inbox).');
      const q = verdict("questions", "The work needs the club's prices.");
      expect(q).toMatch(/The specialist asks you \(Inbox\)\.$/);
      expect(q).not.toContain("needs your decision");
      expect(verdict("retry", "The work needs the club's prices.")).toMatch(
        /It needs your decision \(Inbox\)\.$/,
      );
    });

    it("the review-only pass has one line of its own", () => {
      expect(
        personLine(
          "task.started",
          { taskId: "t1", title: "Notes page", specialist: "critic", reviewOnly: true },
          0.8,
        ),
      ).toBe('The critic reviews "Notes page": its work was done in an earlier session.');
      expect(describeEvent("task.started", { title: "Notes page", reviewOnly: true }, 0.8)).toBe(
        'The critic reviews "Notes page": its work was done in an earlier session.',
      );
    });

    it("a run that ended waiting says 'has questions for you' only when it asked", () => {
      const finished = (summary: string) =>
        personLine(
          "task.finished",
          {
            taskId: "t1",
            title: "Write the footer",
            specialist: "coder",
            outcome: "needs_human",
            summary,
          },
          0.8,
        );
      expect(
        finished("The coder asked you 2 questions; the task waits for your answers in the Inbox."),
      ).toBe('The coder has questions for you about "Write the footer" (Inbox).');
      // A dependency base that could not be built (pr-executor's dependencyConflictWords).
      expect(
        finished(
          'The work it builds on, "Write the page" (pull request #2), conflicts with main in page.html. Resolve that pull request on GitHub, then press Try again.',
        ),
      ).toBe(
        '"Write the footer" could not run: the work it builds on, "Write the page" (pull request #2), conflicts with main in page.html (Inbox).',
      );
      // A hold of the kind w15-tail's W15B-01 adds (a commit in the task's folder).
      const hold = finished(
        "Its folder holds a commit that is not on GitHub: push it or undo it, then press Try again.",
      );
      expect(hold).toBe(
        '"Write the footer" could not run: its folder holds a commit that is not on GitHub: push it or undo it, then press Try again (Inbox).',
      );
      expect(hold).not.toContain("questions");
      expect(finished("")).toBe('"Write the footer" could not run; its card is in the Inbox.');
    });
  });
});
