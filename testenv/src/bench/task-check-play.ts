import type { ModelRequest } from "../provider/types.ts";
import { firstUserText } from "./roles.ts";

/**
 * d1109-selftasks-run (ST-14; ADR 0119): how the bench's stand-in plays the task check, the one
 * planning call a session makes between two tasks when a report or a review left lines "For the
 * task list:" (label `task-check <project id>`). It reads the message as the runtime builds it
 * (the task list in run order, each changeable task's criteria, the evidence in its data
 * envelope) and answers with the reply's JSON:
 *
 * - by default, no change;
 * - a line `"<task>" is two jobs[, the <a> and the <b>]` splits that task in two, in turn, its
 *   criteria shared out in order (the split carries every one);
 * - a line `nothing checks <what>` adds the step "Check <what>" after the reporting task, before
 *   the changeable tasks that wait for it;
 * - `"<a>" is the same as "<b>"` drops a; `"<a>" must wait for "<b>"` orders a after b;
 * - a line that asks for budgets, settings, merges, deploys or other projects is quoted in
 *   `flagged` and changes nothing (the runtime's fence decides in any case).
 *
 * Deterministic; its whys say "[stand-in model]" where the person may read them.
 */

const STAND_IN = "[stand-in model]";
const WHY_MAX = 140;
/** What the runtime's message says for a report line it left out (`LEFT_OUT_LINE`). */
const LEFT_OUT = /^One line of this report was left out/;
const STEERING = /\b(budgets?|settings?|merge|deploy|review levels?|other projects?|ignore)\b/i;

export interface CheckTaskSeen {
  title: string;
  status: string;
  specialist: string | null;
  waitsFor: string[];
  criteria: string[];
}

export interface CheckNoteSeen {
  /** The task whose report or review the lines come from. */
  taskTitle: string;
  specialist: string | null;
  lines: string[];
}

export interface CheckMessageSeen {
  tasks: CheckTaskSeen[];
  notes: CheckNoteSeen[];
  specialists: string[];
}

const TASK_LINE = /^- "(.+?)" \((.*?)\)(?=$|[,;])(.*)$/;
const NOTE_HEADING =
  /^From (?:the report of "(.+)"(?: \(([a-z][a-z0-9-]*)\))?|the critic's notes on "(.+)"):$/;

/** The quoted titles of `"a", "b"` (the message's lists). */
function quotedList(s: string): string[] {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string);
}

/** The message and the system text as the stand-in reads them. */
export function readCheckRequest(req: ModelRequest): CheckMessageSeen {
  const message = firstUserText(req.messages);
  const lines = message.split("\n");
  const tasks: CheckTaskSeen[] = [];
  const notes: CheckNoteSeen[] = [];
  let part: "none" | "tasks" | "evidence" = "none";
  for (const raw of lines) {
    if (raw === "Tasks, in run order:") {
      part = "tasks";
      continue;
    }
    if (raw === "Evidence:") {
      part = "evidence";
      continue;
    }
    if (part === "tasks") {
      const t = TASK_LINE.exec(raw);
      if (t) {
        const rest = t[3] ?? "";
        tasks.push({
          title: t[1] as string,
          status: t[2] as string,
          specialist: /done by the person/.test(rest)
            ? "person"
            : (/by the ([a-z][a-z0-9-]*)/.exec(rest)?.[1] ?? null),
          waitsFor: quotedList(/; waits for (.+)$/.exec(rest)?.[1] ?? ""),
          criteria: [],
        });
        continue;
      }
      const c = /^ {2}Acceptance criteria: (.+)$/.exec(raw);
      const last = tasks.at(-1);
      if (c && last) last.criteria = quotedList(c[1] as string);
      continue;
    }
    if (part === "evidence") {
      if (raw.endsWith(">>>") && !raw.startsWith("-")) {
        part = "none";
        continue;
      }
      const h = NOTE_HEADING.exec(raw);
      if (h) {
        notes.push({
          taskTitle: (h[1] ?? h[3]) as string,
          specialist: h[2] ?? null,
          lines: [],
        });
        continue;
      }
      const l = /^- (.+)$/.exec(raw);
      const note = notes.at(-1);
      if (l && note && !LEFT_OUT.test(raw)) note.lines.push((l[1] as string).trim());
    }
  }
  const named = /A new task or part is for one of these specialists: (.+?)\.$/m.exec(
    req.system ?? "",
  );
  const specialists = (named?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { tasks, notes, specialists };
}

const CHANGEABLE = /^(Draft|Ready|Waiting for|Stuck)/;
const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const why = (s: string) => cut(`${STAND_IN} ${s}`, WHY_MAX);

/** The task check's reply as the stand-in plays it (the JSON text). */
export function taskCheckReply(req: ModelRequest): string {
  const seen = readCheckRequest(req);
  const byTitle = new Map(seen.tasks.map((t) => [t.title, t]));
  const changeable = (title: string) => {
    const t = byTitle.get(title);
    return t && CHANGEABLE.test(t.status) ? t : null;
  };
  const changes: Record<string, unknown>[] = [];
  const flagged: string[] = [];
  let added = 0;
  const done = new Set<string>();
  for (const note of seen.notes)
    for (const line of note.lines) {
      if (changes.length >= 12) break;
      if (STEERING.test(line)) {
        flagged.push(line);
        continue;
      }
      const two = /"([^"]+)" is two jobs(?:[,:]\s*(?:the )?(.+?) and (?:the )?(.+?))?[.;]?$/i.exec(
        line,
      );
      const twoTask = two ? changeable(two[1] as string) : null;
      if (two && twoTask && !done.has(twoTask.title)) {
        done.add(twoTask.title);
        const names = two[2] && two[3] ? [two[2], two[3]] : ["part 1", "part 2"];
        const titles = names.map((n) => cut(`${twoTask.title}: ${n.trim()}`, 200));
        const c = twoTask.criteria;
        const half = Math.ceil(c.length / 2);
        const first = c.slice(0, half);
        const second = c.length > 1 ? c.slice(half) : [`${titles[1]} is done`];
        changes.push({
          kind: "split",
          task: twoTask.title,
          parts: [
            { title: titles[0], acceptanceCriteria: first },
            { title: titles[1], acceptanceCriteria: second },
          ],
          order: "in_turn",
          why: why(`The report of "${note.taskTitle}" says it is two jobs.`),
        });
        added++;
        continue;
      }
      const missing = /nothing checks ((?:that )?(.+?))\.?$/i.exec(line);
      if (missing && added < 6) {
        const said = (missing[1] as string).trim();
        const what = (missing[2] as string).trim();
        const title = cut(`Check ${said}`, 120);
        if (byTitle.has(title) || done.has(title)) continue;
        done.add(title);
        const specialist =
          note.specialist && seen.specialists.includes(note.specialist)
            ? note.specialist
            : (seen.specialists[0] ?? "coder");
        const before = seen.tasks
          .filter((t) => t.waitsFor.includes(note.taskTitle) && CHANGEABLE.test(t.status))
          .map((t) => t.title);
        changes.push({
          kind: "add",
          title,
          outcome: `Checked: ${what}`,
          acceptanceCriteria: [what],
          specialist,
          ...(byTitle.has(note.taskTitle) ? { after: [note.taskTitle] } : {}),
          ...(before.length ? { before } : {}),
          why: why(`Nothing checks ${cut(said, 80)}.`),
        });
        added++;
        continue;
      }
      const same = /"([^"]+)" is the same as "([^"]+)"/i.exec(line);
      if (same && changeable(same[1] as string) && byTitle.has(same[2] as string)) {
        changes.push({
          kind: "drop",
          task: same[1],
          sameAs: same[2],
          why: why("The report says the two tasks are the same."),
        });
        continue;
      }
      const wait = /"([^"]+)" must wait for "([^"]+)"/i.exec(line);
      const waiting = wait ? changeable(wait[1] as string) : null;
      if (wait && waiting && byTitle.has(wait[2] as string)) {
        changes.push({
          kind: "order",
          task: waiting.title,
          waitsFor: [...new Set([...waiting.waitsFor, wait[2] as string])],
          why: why(`The report says it needs "${cut(wait[2] as string, 60)}" first.`),
        });
      }
    }
  return JSON.stringify({
    changes,
    flagged,
    why: changes.length
      ? `${STAND_IN} ${changes.length} ${changes.length === 1 ? "change" : "changes"} from the evidence.`
      : `${STAND_IN} Nothing in the evidence shows the task list is wrong.`,
  });
}

/** Where a report's "For the task list:" lines go: before its lesson line, at its end. */
export function withTaskListLines(report: string, lines: readonly string[]): string {
  const all = report.split("\n");
  const lesson = all.findLastIndex((l) => l.startsWith("Lesson:"));
  const block = ["For the task list:", ...lines.map((l) => `- ${l}`), ""];
  if (lesson < 0) return [...all, "", ...block].join("\n").trimEnd();
  return [...all.slice(0, lesson), ...block, ...all.slice(lesson)].join("\n");
}

/** What a FORERUNNER_BENCH_TASK_LIST specialist says when no FORERUNNER_BENCH_TASK_LIST_SAYS is set. */
export const TASK_LIST_DEFAULT_SAYS = ["nothing checks the finished work end to end."];
