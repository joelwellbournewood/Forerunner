import { withoutIds } from "../daemon/task-words.ts";

/**
 * What chat says it is doing while the person waits (d1109-chat-recall, ADR 0114; the owner's
 * words of 2026-11-09: "There should be something indicating what the chat is doing when
 * waiting"): one line per tool call, from the tool and its input, never from the model's own
 * text. Record names come from the store (quoted, cut at 40 characters); the search words are
 * quoted only when every one of them is in the person's own line of this turn, so a record's
 * words cannot reach the screen through the model's search words (a search for a card's words
 * "x.example" is named without them). At most 80 characters, no id (design §5 rules 1 and 3).
 * The tools announce their line through `onStep`; d1109-chat-depth (run C3) shows it.
 */

/** The kinds `recall` searches (its definition's words). */
export const RECALL_KINDS = [
  "conversation",
  "sessions",
  "tasks",
  "cards",
  "decisions",
  "lessons",
  "documents",
  "changes",
  "spending",
] as const;
export type RecallKind = (typeof RECALL_KINDS)[number];

/** A step line at most (design §5 rule 1: a status sentence is at most 80 characters). */
export const STEP_MAX_CHARS = 80;
/** A record's name or the search words in a step line at most. */
export const STEP_NAME_MAX_CHARS = 40;

export interface StepRecord {
  kind: RecallKind;
  /** The record's local date in words ("3 Nov"). */
  date: string;
  /** Its title as the store has it (a task's title, a document's path). */
  title: string;
  /** Who said a conversation line: the person or chat. */
  who?: "you" | "chat";
  /** A card that was answered (its step reads "your answer"). */
  answered?: boolean;
}

export interface StepContext {
  /** The person's own line of this turn. */
  line: string;
  /** Today in the person's time zone (YYYY-MM-DD). */
  today: string;
  /** recall_open: the record the reference names, read from the store. */
  record?: StepRecord | null;
  /** task_get: the task's title as the store has it. */
  taskTitle?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date's day number (days since 1970-01-01), or null for a malformed one. */
export function dayNumber(date: string): number | null {
  const m = ISO_DAY.exec(date.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms);
  if (back.getUTCMonth() !== Number(m[2]) - 1) return null;
  return Math.round(ms / 86_400_000);
}

/** The calendar date of a day number (YYYY-MM-DD). */
export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** "3 Nov"; with the year when it is not today's year ("3 Nov 2025"). */
export function dayWords(date: string, today: string): string {
  const m = ISO_DAY.exec(date);
  if (!m) return date;
  const words = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return m[1] === today.slice(0, 4) ? words : `${words} ${m[1]}`;
}

/** "2 to 8 Nov", "28 Oct to 3 Nov", "28 Dec 2025 to 3 Jan". */
function spanWords(from: string, to: string, today: string): string {
  const a = ISO_DAY.exec(from);
  const b = ISO_DAY.exec(to);
  if (!a || !b) return `${from} to ${to}`;
  if (a[1] === b[1] && a[2] === b[2]) return `${Number(a[3])} to ${dayWords(to, today)}`;
  if (a[1] === b[1] && a[1] === today.slice(0, 4))
    return `${dayWords(from, today)} to ${dayWords(to, today)}`;
  return `${dayWords(from, a[1] === b[1] ? `${a[1]}-01-01` : today)} to ${dayWords(to, today)}`;
}

/** Monday of the week a day number lies in (weeks start on Monday). */
function mondayOf(day: number): number {
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counted from Monday.
  const weekday = (((day + 3) % 7) + 7) % 7;
  return day - weekday;
}

/**
 * A period in words, both as a possessive ("last week's") and as it follows a noun ("last
 * week", "from 2 to 8 Nov", "since 2 Nov", "until 8 Nov", "on 3 Nov"): today's, yesterday's,
 * this week's and last week's are said so; any other span by its dates. Null for no period.
 */
export function periodWords(
  from: string | undefined,
  to: string | undefined,
  today: string,
): { possessive: string | null; after: string } | null {
  const f = from ? dayNumber(from) : null;
  const t = to ? dayNumber(to) : null;
  const now = dayNumber(today);
  if (f === null && t === null) return null;
  if (now !== null && f !== null) {
    const monday = mondayOf(now);
    if (f === now && (t === null || t === now)) return { possessive: "today's", after: "today" };
    if (f === now - 1 && t === now - 1) return { possessive: "yesterday's", after: "yesterday" };
    if (f === monday && (t === null || t === now || t === monday + 6))
      return { possessive: "this week's", after: "this week" };
    if (f === monday - 7 && t === monday - 1)
      return { possessive: "last week's", after: "last week" };
  }
  if (f !== null && t !== null)
    return f === t
      ? { possessive: null, after: `on ${dayWords(dateOfDay(f), today)}` }
      : { possessive: null, after: `from ${spanWords(dateOfDay(f), dateOfDay(t), today)}` };
  if (f !== null) return { possessive: null, after: `since ${dayWords(dateOfDay(f), today)}` };
  return { possessive: null, after: `until ${dayWords(dateOfDay(t as number), today)}` };
}

/** A name cut at `max` characters with "…", without ids, on one line. */
export function cutName(name: string, max: number = STEP_NAME_MAX_CHARS): string {
  const one = withoutIds(name).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const quoted = (name: string) => `"${cutName(name)}"`;

/** The search words, when every one of them is in the person's own line of this turn. */
function personsWords(words: unknown, line: string): string | null {
  if (typeof words !== "string" || !words.trim()) return null;
  const said = new Set((line.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[]);
  const asked = (words.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
  if (!asked.length || !asked.every((w) => said.has(w))) return null;
  return words.trim();
}

/** The noun of a kind in a step line, and whether it takes "your". */
const NOUNS: Record<Exclude<RecallKind, "conversation" | "spending">, string> = {
  sessions: "sessions",
  tasks: "tasks",
  cards: "answered cards",
  decisions: "decisions",
  lessons: "lessons",
  documents: "documents",
  changes: "changes",
};

function kindsOf(input: unknown): RecallKind[] {
  const raw = (input as { kinds?: unknown } | null)?.kinds;
  const asked = Array.isArray(raw)
    ? raw.filter((k): k is RecallKind => RECALL_KINDS.includes(k as RecallKind))
    : [];
  return asked.length ? [...new Set(asked)] : [...RECALL_KINDS];
}

/** "Looking through last week's sessions…" and the other lines of a search. */
function searchLine(input: unknown, ctx: StepContext): { head: string; tail: string } {
  const i = (input ?? {}) as { from?: unknown; to?: unknown; words?: unknown };
  const period = periodWords(
    typeof i.from === "string" ? i.from : undefined,
    typeof i.to === "string" ? i.to : undefined,
    ctx.today,
  );
  const kinds = kindsOf(input);
  const words = personsWords(i.words, ctx.line);
  const tail = words ? ` for "${cutName(words)}"` : "";
  if (kinds.length === 1 && kinds[0] === "conversation")
    return {
      head: period
        ? `Looking back through what was said ${period.after}`
        : "Looking back through this conversation",
      tail,
    };
  if (kinds.length === 1 && kinds[0] === "spending")
    return { head: `Adding up what it cost${period ? ` ${period.after}` : ""}`, tail: "" };
  const named = kinds.filter(
    (k): k is Exclude<RecallKind, "conversation" | "spending"> =>
      k !== "conversation" && k !== "spending",
  );
  if (kinds.length > 2 || named.length !== kinds.length)
    return {
      head: `Looking through everything recorded${period ? ` ${period.after}` : ""}`,
      tail,
    };
  const nouns = named.map((k) => NOUNS[k]).join(" and ");
  if (period?.possessive) return { head: `Looking through ${period.possessive} ${nouns}`, tail };
  const det = named[0] === "cards" ? "your" : "the";
  return {
    head: `Looking through ${det} ${nouns}${period ? ` ${period.after}` : ""}`,
    tail,
  };
}

/** What `recall_open` reads, by the record its reference names. */
function openLine(ctx: StepContext): string {
  const r = ctx.record;
  if (!r) return "Reading what it found";
  switch (r.kind) {
    case "sessions":
      return `Reading the session of ${r.date}`;
    case "cards":
      return r.answered ? `Reading your answer of ${r.date}` : `Reading the card of ${r.date}`;
    case "decisions":
      return `Reading the decision of ${r.date}`;
    case "documents":
      return `Reading ${quoted(r.title)}`;
    case "conversation":
      return r.who === "chat"
        ? `Reading my reply of ${r.date}`
        : `Reading what you said on ${r.date}`;
    case "tasks":
      return `Reading ${quoted(r.title)} and its runs`;
    case "lessons":
      return `Reading the lesson of ${r.date}`;
    case "changes":
      return `Reading the change of ${r.date}`;
    case "spending":
      return "Adding up what it cost";
  }
}

/** One line ending with "…", at most `STEP_MAX_CHARS`: the quoted search words go first. */
function fit(head: string, tail = ""): string {
  const whole = `${head}${tail}…`;
  if (whole.length <= STEP_MAX_CHARS) return whole;
  const bare = `${head}…`;
  return bare.length <= STEP_MAX_CHARS ? bare : `${head.slice(0, STEP_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The step line of one tool call: the read tools, recall and recall_open, and the command
 * tools (a change is prepared; a lesson is kept for later).
 */
export function stepLine(tool: string, input: unknown, ctx: StepContext): string {
  switch (tool) {
    case "recall": {
      const { head, tail } = searchLine(input, ctx);
      return fit(head, tail);
    }
    case "recall_open":
      return fit(openLine(ctx));
    case "tasks_list":
      return fit("Going through the tasks");
    case "task_get":
      return fit(
        ctx.taskTitle ? `Reading ${quoted(ctx.taskTitle)} and its runs` : "Going through the tasks",
      );
    case "session_last":
      return fit("Reading the last session");
    case "files_list":
      return fit("Listing the project's files");
    case "memory_record":
      return fit("Keeping that for later");
    default:
      return fit("Preparing the change");
  }
}
