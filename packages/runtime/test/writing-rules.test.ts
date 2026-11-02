import type { HumanRequestRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { eventAudience } from "../src/daemon/event-audience.ts";
import { requestWords } from "../src/daemon/request-words.ts";
import { describeEvent } from "../src/daemon/views.ts";
import * as producers from "../src/notifications/producers.ts";
import { sessionResultLines, sessionUpdateLine } from "../src/session/result.ts";

/*
 * The writing rules of core-experience design §5, checked mechanically on what the system writes
 * from fixtures: the session log's person lines, a session's result, the Inbox cards and the
 * notifications. Each earlier fix added a sentence of its own, which is how the walls of text
 * grew; this test is the one place that says what any text a person reads must not contain and
 * how long it may be. It fails on a planted violation (the last case), so a rule that stops
 * matching is seen.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RULES: [string, RegExp][] = [
  ["a UUID", UUID],
  ["a raw state name", /\b(?:needs_human|in_progress|in_review|claimed_by|retry_ladder)\b/],
  ["an event type name", /\b(?:session|task|critic|memory|queue|peers|docs|inbox)\.[a-z_]+\b/],
  [
    "a tier, a ladder, a verdict, a ceiling or a rung",
    /\btier \d|\bladder\b|\bverdict\b|\bceiling\b|\brung\b/i,
  ],
  ["USD or a dollar sign", /\bUSD\b|\$/],
  ['a "(s)" plural', /\(s\)/],
  ["markdown", /\*\*|^#+\s|`/m],
  ["JSON", /[{}]|"\w+"\s*:/],
  ["a stand-in tag", /\[stand-in model\]/],
  ["a notification channel", /telegram skipped|signal skipped|email skipped|desktop unavailable/i],
];

/** What a text breaks: each rule it matches, and its length over `max`. */
export function violations(text: string, max: number, opts: { lines?: number } = {}): string[] {
  const out = RULES.filter(([, re]) => re.test(text)).map(([name]) => `${name}: ${text}`);
  // A text cut inside a quoted name leaves its quote open ('Quote page: "Style the page in
  // styles.'): the cut a regex for "ends mid-word" cannot see when the cut falls after a dot.
  if ((text.match(/"/g) ?? []).length % 2 === 1) out.push(`a quote left open (cut short): ${text}`);
  // "…" after a space: the cut dropped what came before it instead of ending at a word.
  if (/\s…/.test(text)) out.push(`cut before "…": ${text}`);
  if (text.length > max) out.push(`longer than ${max} (${text.length}): ${text}`);
  const lines = text.split("\n").length;
  if (lines > (opts.lines ?? 1)) out.push(`${lines} lines: ${text}`);
  return out;
}

const ID = "01a196fe-2aa9-7114-a15e-2024baa5e65e";
const MARKDOWN_REPORT =
  "**Summary** [stand-in model] I could not complete this task. The work needs something I do not have here, so I stopped without changing any file.\n\n**Files changed**: none.\n\n**Criteria**\n- styles.css exists and styles the page";

/** Event payloads as the runner writes them, the awkward ones included. */
const EVENTS: [string, Record<string, unknown>][] = [
  ["session.started", { trigger: "manual", budgetCapUsdMicro: 5_000_000, stepCap: 200 }],
  ["session.started", { trigger: "message", budgetCapUsdMicro: 5_000_000, stepCap: 200 }],
  [
    "task.started",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "writer-marketing",
      estimateUsdMicro: 180_000,
    },
  ],
  ["task.files", { taskId: ID, files: ["index.html", "a.js", "b.js", "c.js", "d.css"] }],
  [
    "task.finished",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "designer",
      outcome: "done",
      costUsdMicro: 0,
      summary: MARKDOWN_REPORT,
    },
  ],
  [
    "task.finished",
    {
      taskId: ID,
      title: "Create the page skeleton in index.html",
      specialist: "coder",
      outcome: "done",
      costUsdMicro: 12_000,
      summary:
        "**Summary** [stand-in model] coder wrote index.html.\n\n**Files changed**\n- index.html",
    },
  ],
  [
    "task.finished",
    {
      taskId: ID,
      title: "Show a quote",
      outcome: "failed",
      summary: `Claude did not answer (model call failed) on run ${ID}.`,
    },
  ],
  [
    "critic.verdict",
    {
      taskId: ID,
      title: "Show a random quote on every load in script.js",
      verdict: "revise",
      decision: "revise",
      retry: "improve_brief",
      grade: 35,
      findings: 2,
      openFindings: 2,
      summary: "[stand-in model] Sent back for rework: 2 finding(s) remain.",
    },
  ],
  ["critic.verdict", { taskId: ID, title: "Add clamp", verdict: "accept", decision: "accepted" }],
  ["critic.verdict", { taskId: ID, title: "Add clamp", verdict: "human", decision: "human" }],
  // A run that could not do the work and the critic's verdict on it, in one line.
  [
    "critic.verdict",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "designer",
      couldNot:
        "The work needs something I do not have here, so I stopped without changing any file",
      verdict: "revise",
      decision: "revise",
      retry: "split_or_change_specialist",
      summary:
        "[stand-in model] Sent back for rework: the worker reports it could not do the work.",
    },
  ],
  [
    "critic.verdict",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "writer-marketing",
      couldNot: "",
      verdict: "revise",
      decision: "human",
    },
  ],
  [
    "critic.review_failed",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "designer",
      couldNot: "The work needs Docker",
      warning: `critic review failed: HTTP 500 on run ${ID}`,
    },
  ],
  [
    "task.started",
    {
      taskId: ID,
      title: "Style the page in styles.css",
      specialist: "writer-marketing",
      again: true,
      handedFrom: "designer",
      estimateUsdMicro: 180_000,
    },
  ],
  ["task.retrying", { taskId: ID, text: 'Claude did not answer. Trying "Add clamp" again.' }],
  ["session.stopped", { by: "you", text: 'Stopped by you during "Add clamp". It is ready again.' }],
  [
    "session.sandbox_waiting",
    { tasks: [{ taskId: ID, title: "Write the README: what the page does" }], state: "x" },
  ],
  [
    "task.moved_while_running",
    { taskId: ID, title: "Add clamp", status: "needs_human", byPerson: true },
  ],
  ["session.error", { code: "internal", message: `TypeError: x is undefined at run ${ID}` }],
  [
    "session.ended",
    {
      status: "killed",
      stopReason: "stop_all",
      spentUsdMicro: 0,
      completed: 0,
      failed: 0,
      needsHuman: 0,
      retried: 0,
      inReview: 0,
      skipped: 0,
    },
  ],
  [
    "session.ended",
    {
      status: "completed",
      stopReason: "completed",
      spentUsdMicro: 60_000,
      completed: 2,
      needsHuman: 1,
      retried: 2,
    },
  ],
  ["session.plan_filed", { items: 3, changed: true }],
  ["session.plan_approved", { items: 1 }],
];

function card(over: Partial<HumanRequestRow>): HumanRequestRow {
  return {
    id: "r-1",
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    author_agent: null,
    author_human: null,
    version: 1,
    human_id: "h-1",
    project_id: "p-1",
    task_id: ID,
    session_id: null,
    kind: "approval",
    why: "",
    steps: [],
    options: [],
    blocking: true,
    answer: null,
    answered_at: null,
    answered_by: null,
    status: "open",
    risk: "medium",
    change_card: null,
    ...over,
  } as HumanRequestRow;
}

/** The Inbox's cards from the producers' fields, the walks' worst texts in them. */
const CARDS: HumanRequestRow[] = [
  card({
    why: `Retry ladder exhausted for "Style the page in styles.css" after 4 failed attempt(s) (ceiling opus) on task ${ID}`,
    options: ["Try again", "Mark done anyway", "Cancel task"],
    change_card: {
      key: "critic:signoff",
      title: '"Style the page in styles.css" failed 4 times',
      said: "I could not complete this task. The work needs something I do not have here.",
      said_by: "designer",
      reason: "failed",
    },
  }),
  card({
    kind: "decision",
    why: '"Decide where the page is published" needs your answers. No specialist works on it: answer the questions below.',
    steps: [
      "Where should the page be published: GitHub Pages, Netlify, or only as a local file?",
      "Should the quotes be in English only?",
    ],
    options: ["Cancel the task"],
    change_card: { key: `person_questions:${ID}`, source: "planned" },
  }),
  card({
    task_id: null,
    why: "Docker is not running.",
    change_card: {
      key: "sandbox.not_ready",
      headline: "Docker is installed but not running.",
      task_titles: ["Check every file loads"],
    },
  }),
];

describe("writing rules (design §5)", () => {
  it("the session log's person lines: one line each, names, no ids, states, markdown, JSON or channels", () => {
    const person = EVENTS.filter(([type, p]) => eventAudience(type, p) === "person").map(
      ([type, p]) => describeEvent(type, p, 0.8),
    );
    expect(person.length).toBe(EVENTS.length);
    expect(person.flatMap((l) => violations(l, 220))).toEqual([]);
  });

  it("a session's result: at most three lines, what needs you first, no zero counts", () => {
    const lines = sessionResultLines({
      outcome: {
        done: [
          { id: "a", title: "Create the page skeleton in index.html" },
          { id: "b", title: "Show a random quote on every load in script.js" },
        ],
        failed: [{ id: "c", title: "Fail by error", reason: `Claude did not answer (run ${ID}).` }],
        needsYou: [{ id: "d", title: "Style the page in styles.css" }],
        leftOver: [],
        waiting: [{ id: "e", title: "Check every file loads", waitsOn: ['"Style the page"'] }],
        waitingForDocker: [],
        stopReason: "completed",
        spentChfMicro: 60_000,
      },
      inReview: [],
      leftOutForBudget: [],
      sessionCapChfMicro: 5_000_000,
      openTasks: 3,
    });
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/needs your decision/);
    for (const l of lines) {
      expect(violations(l, 400)).toEqual([]);
      expect(l).not.toMatch(/\b0 (done|failed|sent back|in review|not started)\b|: 0\./);
    }
    // The Inbox Update of the same session (design §3.8, rule 1: one line): the news, whole;
    // the decision is its card's to say.
    const update = sessionUpdateLine("Quote page", lines, ["Style the page in styles.css"]) ?? "";
    expect(violations(update, 220), update).toEqual([]);
    expect(update).toMatch(/^Quote page: /);
    expect(update).not.toMatch(/needs your decision/);
  });

  it("the Inbox's cards: a title, at most two sentences, buttons of at most three words, consequences within 100", () => {
    for (const r of CARDS) {
      const w = requestWords(r, {
        projectName: "Quote page",
        taskTitle: r.task_id ? "Style the page in styles.css" : null,
        waiting: ["Check every file loads"],
      });
      expect(violations(w.title, 80), w.title).toEqual([]);
      if (w.body) {
        expect(violations(w.body, 300), w.body).toEqual([]);
        const sentences = w.body.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [w.body];
        expect(sentences.length, w.body).toBeLessThanOrEqual(2);
      }
      for (const c of w.choices) {
        expect(c.label.split(/\s+/).length, c.label).toBeLessThanOrEqual(3);
        expect(violations(c.label, 40)).toEqual([]);
        if (c.explain) expect(violations(c.explain, 100), c.explain).toEqual([]);
      }
    }
  });

  it("notifications: a title of at most 60 that names the project, a body of at most 140", () => {
    const notes = [
      ...CARDS.map((r) =>
        producers.requestOpened(r, "h-1", {
          projectName: "Quote page",
          taskTitle: "Style the page in styles.css",
        }),
      ),
      producers.sessionEnded("h-1", {
        sessionId: "s-1",
        status: "completed",
        stopReason: "completed",
        summary:
          '"Style the page in styles.css" needs your decision (Inbox).\nDid 2 tasks: "Create the page skeleton in index.html" and "Show a random quote on every load in script.js".\n1 task waits on it. CHF 0.06.',
        spentUsdMicro: 75_000,
        completed: ["a", "b"],
        needsHuman: ["c"],
        projectName: "Quote page",
      }),
      producers.sessionEnded("h-1", {
        sessionId: "s-1",
        status: "stopped",
        stopReason: "budget_exceeded",
        summary: "The session's budget is used. CHF 0.90.",
        spentUsdMicro: 1_125_000,
        completed: [],
        needsHuman: [],
        projectName: "Quote page",
      }),
      producers.criticVerdict(
        "h-1",
        {
          id: ID,
          verdict: "revise",
          grade: 35,
          task_id: ID,
          session_id: null,
          summary: "[stand-in model] Sent back for rework: the worker reports it could not do it.",
        },
        "p-1",
        { projectName: "Quote page", taskTitle: "Style the page in styles.css" },
      ),
      producers.killSwitch(
        "h-1",
        { stoppedRuns: 2, killedProcesses: 1, revokedTokens: 2, durationMs: 9, scope: "all" },
        "kill switch from the app",
        "stop_all",
      ),
    ];
    for (const n of notes) {
      expect(violations(n.title, producers.NOTIFICATION_TITLE_MAX), n.title).toEqual([]);
      expect(violations(n.body, producers.NOTIFICATION_BODY_MAX), n.body).toEqual([]);
    }
    for (const n of notes.slice(0, -1)) expect(n.title).toMatch(/^Quote page: /);
  });

  it("the checker itself finds a planted violation of each kind", () => {
    expect(violations(`"Style the page" failed on run ${ID}.`, 200)).not.toEqual([]);
    expect(violations("Finished task: done. **Summary**", 200)).not.toEqual([]);
    expect(violations('unset → {"start":"12:00"}', 200)).not.toEqual([]);
    expect(violations("2 finding(s) open", 200)).not.toEqual([]);
    expect(violations("Spent USD 0.0085", 200)).not.toEqual([]);
    expect(violations("x".repeat(61), 60)).not.toEqual([]);
    expect(violations("Notified you: telegram skipped (no chat id)", 200)).not.toEqual([]);
    expect(violations("Waits for: needs_human", 200)).not.toEqual([]);
    expect(violations("Session started (manual): session.brief", 200)).not.toEqual([]);
    expect(violations('Quote page: "Style the page in styles.', 200)).not.toEqual([]);
    expect(violations("Fine words, cut at a …", 200)).not.toEqual([]);
    expect(violations("Fine words, cut at a word…", 200)).toEqual([]);
    expect(violations('Quote page: "Style the page in…" needs your decision', 60)).toEqual([]);
  });
});
