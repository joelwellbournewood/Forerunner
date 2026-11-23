import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { requestWords } from "../src/daemon/request-words.ts";
import {
  type PreparedContext,
  preparedContextOf,
  preparedExplain,
} from "../src/session/prepared-work.ts";

/**
 * d1109-starts-engine S-12 (ADR 0118): no screen, card, log line or chat sentence promises a
 * start that does not happen. Before run C these phrases were true (answers and waits started
 * sessions); now only the person starts one, so none may be said anywhere a person reads. The
 * check reads every source file of the runtime, the commands and the app (code, not comments).
 */
const ROOT = process.cwd();
const DIRS = ["packages/runtime/src", "packages/commands/src", "apps/ui/src"];
// "Planning waits until 15:40 (...) and starts by itself." stays: the plan the person asked for is
// drafted again at the reset (a planning call, no session).
const RETIRED = [
  "limit) and starts by itself",
  "a task whose first credential runs out waits for its reset and starts by itself",
  "start by themselves, or go on at once",
  "the tasks start by themselves",
  "it starts by itself then",
  "A session will pick it up",
  "a session will pick it up",
  "the next session can run it",
  "the next session works on it again",
  "a session starts for it.",
  "Starts a session that tries again",
  "waiting work starts by itself",
  "and a session runs it",
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The file's code: line and block comments dropped (what a person can be shown). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

describe("d1109-starts-engine S-12: no word promises a start that does not happen", () => {
  it("the retired start promises are said nowhere a person reads", () => {
    const found: string[] = [];
    for (const dir of DIRS)
      for (const f of files(join(ROOT, dir))) {
        const c = code(readFileSync(f, "utf8"));
        for (const phrase of RETIRED) if (c.includes(phrase)) found.push(`${f}: ${phrase}`);
      }
    expect(found).toEqual([]);
  });
});

/**
 * Fix-up of the review (S-9, design §5 rules 4 and 9): an Inbox option that prepares work says
 * what pressing it does when the card is shown, by the same steps `prepareWork` takes, in the same
 * order: the project's running session, the person's session waiting to go on, then the hands-off
 * setting (stopped, quiet hours, another session first), else the person's next Start.
 */
describe("d1109-starts-engine S-9: the explain of an option that prepares work", () => {
  const tryAgain = (ctx: PreparedContext) =>
    `Tries again with your note, if any; ${preparedExplain(ctx)}.`;
  it.each<[string, PreparedContext, string]>([
    ["nothing runs", {}, "it runs at your next Start"],
    ["another project's session runs", { running: "other" }, "it runs at your next Start"],
    [
      "the project's session runs",
      { running: "this_project", startsByItself: true },
      "it joins the running session if it fits",
    ],
    [
      "the person's session waits to go on",
      { continuationWaits: true, startsByItself: true },
      "it joins your session when it goes on, if it fits",
    ],
    ["the hands-off setting on", { startsByItself: true }, "a session starts for it by itself"],
    [
      "the hands-off setting on, another session runs",
      { startsByItself: true, running: "other" },
      "a session starts for it after the current one",
    ],
    [
      "the hands-off setting on, quiet hours now",
      { startsByItself: true, quiet: true, running: "other" },
      "a session starts for it after your quiet hours",
    ],
    [
      "the hands-off setting on, Stop all",
      { startsByItself: true, stopped: true, quiet: true },
      "it runs at your next Start once you allow sessions again",
    ],
  ])("%s", (_what, ctx, clause) => {
    expect(preparedExplain(ctx)).toBe(clause);
    expect(tryAgain(ctx).length).toBeLessThanOrEqual(100);
    expect(tryAgain(ctx)).not.toMatch(/CHF|USD|\$|[0-9a-f]{8}-/);
  });

  it("the facts are read as prepareWork meets them, read-only", async () => {
    const store = {
      project: {
        get: async (id: string) => ({
          id,
          settings: id === "p-hands-off" ? { start_by_itself: true } : {},
        }),
      },
    } as never;
    const live = { forProject: (id: string) => (id === "p-running" ? ({} as never) : undefined) };
    const deps = {
      store,
      live,
      startedFor: () => false,
      continuationWaits: async (id: string) => id === "p-waits",
      frozen: () => false,
      runningOther: (_a: string, id: string) => id !== "p-running",
      quietNow: async () => false,
    };
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-running" })).toEqual({
      running: "this_project",
    });
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-waits" })).toEqual({
      running: "other",
      continuationWaits: true,
    });
    expect(await preparedContextOf(deps, { agentId: "a", projectId: "p-hands-off" })).toEqual({
      running: "other",
      startsByItself: true,
    });
  });
});

/**
 * l4-starts-sessions, run L4 (L4-money-202): live check 4 (LC-C18, LC-C19) showed the questions
 * card's Send answers with no line and Go ahead without with a fixed one, with a session running
 * and with the hands-off setting on alike, although both prepare the work as Try again does.
 */
describe("l4-starts-sessions, run L4: the questions card's options say what pressing them does now", () => {
  const card = (source: "specialist" | "critic" | "planned") => ({
    kind: "decision" as never,
    why: "The specialist asks you.",
    steps: [],
    options: ["Send answers", "Go ahead without", "Cancel task"],
    status: "open" as never,
    answer: null,
    change_card: {
      key: "person_questions:t1",
      source,
      task_title: "Add the club's phone number to contact.html",
      questions: ["What is the club's phone number?"],
    } as never,
  });
  it.each<[string, PreparedContext, string]>([
    ["nothing runs", {}, "it runs at your next Start"],
    [
      "the project's session runs",
      { running: "this_project" },
      "it joins the running session if it fits",
    ],
    ["the hands-off setting on", { startsByItself: true }, "a session starts for it by itself"],
    [
      "the hands-off setting on, another session runs",
      { startsByItself: true, running: "other" },
      "a session starts for it after the current one",
    ],
    [
      "the person's session waits to go on",
      { continuationWaits: true },
      "it joins your session when it goes on, if it fits",
    ],
    [
      "the hands-off setting on, quiet hours now",
      { startsByItself: true, quiet: true },
      "a session starts for it after your quiet hours",
    ],
  ])("%s", (_what, ctx, clause) => {
    const words = requestWords(card("specialist"), { ...ctx, taskTitle: "Add the phone" });
    const without = words.choices.find((c) => c.label === "Go ahead without");
    expect(without?.explain).toBe(`The specialist decides and says what it assumed; ${clause}.`);
    expect(words.submit).toEqual({
      label: "Send answers",
      explain: `The task goes on with your answers; ${clause}.`,
    });
    for (const line of [without?.explain ?? "", words.submit?.explain ?? ""]) {
      expect(line.length).toBeLessThanOrEqual(100);
      expect(line).not.toMatch(/CHF|USD|\$|[0-9a-f]{8}-/);
    }
    // The critic's questions read the same.
    expect(requestWords(card("critic"), ctx).submit?.explain).toBe(
      `The task goes on with your answers; ${clause}.`,
    );
  });
  it("the person's own task: Send answers closes it, and there is no Go ahead without", () => {
    const words = requestWords(card("planned"), { startsByItself: true });
    expect(words.choices.map((c) => c.label)).toEqual(["Cancel task"]);
    expect(words.submit).toEqual({
      label: "Send answers",
      explain: "Saves your answers in the decision record and closes the task.",
    });
  });
});

/**
 * l4-starts-sessions, run L4 (L4-money-205): live check 4's Answered lines once the task was
 * done: '... is done; what waits on it joins the session that is running.' with nothing waiting
 * and nothing running (LC-C18), and '... is done; a session started for it (this project starts
 * by itself when work is ready).' under the hands-off setting (LC-C19).
 */
describe("l4-starts-sessions, run L4: Answered lines stay true once the task is done", () => {
  const questions = (over: Record<string, unknown>) => ({
    kind: "decision" as never,
    why: "asks",
    steps: [],
    options: ["Go ahead without", "Cancel task"],
    status: "answered" as never,
    answer: null,
    change_card: {
      key: "person_questions:t1",
      task_title: "Add the club's phone number to contact.html",
      questions: ["Which number?"],
      ...over,
    } as never,
  });
  const title = { taskTitle: "Add the club's phone number to contact.html" };
  it.each<[string, Record<string, unknown>]>([
    ["joined the session that ran", { outcome: "answered", start: "joined" }],
    ["waits for the next Start", { outcome: "answered", start: "waits_start" }],
    [
      "the hands-off setting started one",
      { outcome: "answered", start: "started", start_by: "hands_off" },
    ],
  ])("a specialist's card, %s: only that it is done", (_what, card) => {
    const words = requestWords(questions({ source: "specialist", on_answer: "ready", ...card }), {
      ...title,
      taskStatus: "done",
      waiting: [],
    });
    expect(words.outcome).toBe(
      'Answers saved in the decision record; "Add the club\'s phone number to contact.html" is done.',
    );
  });
  it("a specialist's card answered without answers: only that it is done", () => {
    const words = requestWords(
      questions({ source: "specialist", outcome: "without", start: "joined" }),
      { ...title, taskStatus: "done", waiting: ["Publish the page"] },
    );
    expect(words.outcome).toBe(
      '"Add the club\'s phone number to contact.html" is done without your answers.',
    );
  });
  it("the person's own card: what waits on it, only while something does, as true now", () => {
    const own = (start: Record<string, unknown>, ctx: Record<string, unknown>) =>
      requestWords(
        questions({ source: "planned", on_answer: "done", outcome: "answered", ...start }),
        {
          ...title,
          taskStatus: "done",
          ...ctx,
        },
      ).outcome;
    const done =
      'Answers saved in the decision record; "Add the club\'s phone number to contact.html" is done';
    expect(own({ start: "waits_start" }, { waiting: [] })).toBe(`${done}.`);
    expect(own({ start: "waits_start" }, { waiting: ["Publish the page"] })).toBe(
      `${done}; what waits on it runs at your next Start.`,
    );
    // It joined a session that has ended since: read later, it is the next Start.
    expect(own({ start: "joined" }, { waiting: ["Publish the page"], running: null })).toBe(
      `${done}; what waits on it runs at your next Start.`,
    );
    expect(
      own({ start: "joined" }, { waiting: ["Publish the page"], running: "this_project" }),
    ).toBe(`${done}; what waits on it joins the session that is running.`);
    expect(
      own({ start: "started", start_by: "hands_off" }, { waiting: ["Publish the page"] }),
    ).toBe(
      `${done}; a session started for what waits on it (this project starts by itself when work is ready).`,
    );
  });
  it("a sign-off accepted under the hands-off setting never reads 'what comes after it a session started'", () => {
    const signoff = (ctx: Record<string, unknown>) =>
      requestWords(
        {
          kind: "approval" as never,
          why: "signoff",
          steps: [],
          options: ["Accept the work", "Send it back", "Cancel task"],
          status: "answered" as never,
          answer: null,
          change_card: {
            key: "critic:signoff",
            reason: "verdict",
            outcome: "accept",
            start: "started",
            start_by: "hands_off",
          } as never,
        },
        { taskTitle: "Write the README", ...ctx },
      ).outcome;
    expect(signoff({ waiting: ["Publish the page"] })).toBe(
      '"Write the README" is done; a session started for what comes after it (this project starts by itself when work is ready).',
    );
    expect(signoff({ waiting: [] })).toBe('"Write the README" is done.');
    expect(signoff({ waiting: ["Publish the page"] })).not.toMatch(/what comes after it a session/);
  });
});
