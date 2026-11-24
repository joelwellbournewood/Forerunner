import { PRIORITY_LABELS, priorityLevel } from "@forerunner/runtime/priority";
import type { StateStore, TaskRow } from "@forerunner/state";
import type { CardSubject, ChangeCard } from "./change-card.ts";

/**
 * l4-selftasks-chat (L4-selftasks-117, run C decision 53, D-L4-12; the owner, 2026-11-17: every
 * chat read-back "stays open in chat and the Inbox until the person presses Yes or No"): a
 * read-back that waits for days is decided again at the Yes on the state as it is then (ADR 0030
 * point 3), and applies only what it read back. What it named is kept on its card when it is read
 * back (`ChangeCard.subjects`: the task's fields the person saw; a setting's value is the card's
 * own `oldValue`); at the Yes the same request is planned again and compared. A fix of the task
 * list (fix_tasks' set) keeps the fingerprint of the whole list its check judged instead.
 */

/** The fields of a task a read-back names, in the order the comparison says them. */
const SUBJECT_FIELDS = [
  "status",
  "title",
  "outcome",
  "criteria",
  "priority",
  "waits_for",
  "specialist",
  "budget",
] as const;

/** A task as a read-back names it: its id, its title then, and the fields compared at the Yes. */
export function taskSubject(task: TaskRow): CardSubject {
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    fields: {
      status: task.status,
      title: task.title,
      outcome: task.outcome,
      criteria: JSON.stringify(task.acceptance_criteria ?? []),
      priority: String(task.priority),
      waits_for: JSON.stringify([...(task.depends_on ?? [])].sort()),
      specialist: task.specialist ?? "",
      budget: String(task.budget_usd_micro ?? 0),
    },
  };
}

/** The commands whose card's `oldValue` is the value of what they name, as it is now. */
const VALUE_COMMANDS: ReadonlySet<string> = new Set([
  "settings.set",
  "budget.set",
  "autonomy.set",
  "model.settings.set",
  "capability.grant",
  "email.mode.set",
]);

const STATUS_NOW: Record<string, string> = {
  draft: "a draft",
  ready: "ready",
  claimed: "running",
  in_progress: "running",
  in_review: "being reviewed",
  needs_human: "paused",
  blocked: "waiting",
  failed: "failed",
  done: "done",
  cancelled: "cancelled",
};

function statusNow(status: string): string {
  return STATUS_NOW[status] ?? status.replace(/_/g, " ");
}

function priorityNow(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? PRIORITY_LABELS[priorityLevel(n)].toLowerCase() : value;
}

/** What changed of one task, as clauses after its quoted title ("it is paused now"). */
function subjectClauses(was: CardSubject, now: CardSubject | undefined): string[] {
  if (!now) return ["it is no longer there"];
  const out: string[] = [];
  for (const f of SUBJECT_FIELDS) {
    const a = was.fields[f] ?? "";
    const b = now.fields[f] ?? "";
    if (a === b) continue;
    if (f === "status") out.push(`it is ${statusNow(b)} now`);
    else if (f === "title") out.push(`it is called "${b}" now`);
    else if (f === "outcome") out.push("what done looks like changed");
    else if (f === "criteria") out.push("its criteria changed");
    else if (f === "priority") out.push(`its priority is ${priorityNow(b)} now`);
    else if (f === "waits_for") out.push("what it waits for changed");
    else if (f === "specialist") out.push(b ? `it is for the ${b} now` : "who does it changed");
    else out.push("its budget changed");
  }
  return out;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

function partsOf(card: ChangeCard): ChangeCard[] {
  return card.parts?.length ? card.parts : [card];
}

function capitalised(s: string): string {
  return /^[a-z]/.test(s) ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

/** The end of every "changed since" line: nothing was applied, and how to have it after all. */
export const ASK_AGAIN = "Nothing was changed; ask again if you still want it.";

/**
 * What changed of what a read-back named, between the card as it was read back and the same
 * request planned on the state now, in one line ('"Write the README" changed since I asked: its
 * priority is low now. Nothing was changed; ask again if you still want it.'), or null when what
 * it named is as it was. A task it named is compared field by field (`subjects`); a setting, a
 * budget or another value by the card's `oldValue` (the value in force when it was read back).
 */
export function changedSince(shown: ChangeCard, fresh: ChangeCard): string | null {
  const was = partsOf(shown);
  const now = partsOf(fresh);
  const lines: string[] = [];
  const named = new Set<string>();
  const nowSubjects = new Map<string, CardSubject>();
  for (const p of now) for (const s of p.subjects ?? []) nowSubjects.set(s.id, s);
  for (const [i, p] of was.entries()) {
    for (const s of p.subjects ?? []) {
      if (named.has(s.id)) continue;
      named.add(s.id);
      const clauses = subjectClauses(s, nowSubjects.get(s.id));
      if (clauses.length) lines.push(`"${s.title}" changed since I asked: ${joinClauses(clauses)}`);
    }
    const f = now[i];
    if (!p.subjects?.length && f && VALUE_COMMANDS.has(p.command) && p.oldValue !== f.oldValue)
      lines.push(
        `${capitalised(p.what)} is ${f.oldValue} now, not ${p.oldValue} as I read it back`,
      );
  }
  if (!lines.length) return null;
  return `${lines.slice(0, 2).join("; ")}. ${ASK_AGAIN}`;
}

/**
 * fixup-l4-selftasks-chat (review of L4-selftasks-117): what the read-back named, read from the
 * store as it is now, as a card `changedSince` compares with the one shown. Used when the same
 * request can no longer be planned (the task it named was cancelled, finished or removed since,
 * so its command refuses): the Yes still says what changed in one line, and not only the
 * command's own refusal. Before, such a card was not armed again after a restart and the orphan
 * sweep told the person it was lost.
 */
export async function subjectsNow(
  store: Pick<StateStore, "task">,
  shown: ChangeCard,
): Promise<ChangeCard> {
  const parts = await Promise.all(
    partsOf(shown).map(async (p) => {
      const subjects: CardSubject[] = [];
      for (const s of p.subjects ?? []) {
        const task = await store.task.get(s.id).catch(() => undefined);
        if (task) subjects.push(taskSubject(task));
      }
      return { ...p, subjects };
    }),
  );
  return shown.parts?.length ? { ...shown, parts } : (parts[0] ?? shown);
}

/** Run C decision 53: the Yes of a fix of the task list whose tasks changed since its check. */
export const TASKS_CHANGED_REPLY =
  'The tasks changed since I checked them; say "fix the tasks" to check again.';

/** A short hash of a text (FNV-1a, no dependency). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** The mark of a fingerprint that keeps each task apart (l4-selftasks-carried, L4f-left-2). */
const FINGERPRINT_V2 = "v2|";

/**
 * The task list as the check judged it (run C decision 53), task by task: each task's id with a
 * short hash of what a fix of the list reads and changes of it (status, title, outcome and what
 * it waits for; not its spend or claims, which move while a session runs). At the Yes,
 * `fixListMoved` compares which tasks the list holds and the tasks the set names.
 *
 * l4-selftasks-carried (L4f-left-2; session lead decision 2026-11-23): before, one hash of every
 * task's fields, so a session finishing a task the set did not name made almost every Yes
 * answered while a session ran say "The tasks changed since I checked them".
 */
export async function taskListFingerprint(
  store: Pick<StateStore, "task">,
  projectId: string,
): Promise<string> {
  const tasks = await store.task.forProject(projectId, {}, { limit: 1000 });
  return `${FINGERPRINT_V2}${[...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => `${t.id}=${fnv1a(JSON.stringify(fixFields(t)))}`)
    .join(",")}`;
}

/** What a fix of the task list reads and changes of one task (L4f-left-2). */
function fixFields(task: TaskRow): Record<string, string> {
  const f = taskSubject(task).fields;
  return {
    status: f.status ?? "",
    title: f.title ?? "",
    outcome: f.outcome ?? "",
    waits_for: f.waits_for ?? "",
  };
}

/** The fingerprint before L4f-left-2 (one hash of every task), for a card stored with it. */
async function wholeListFingerprint(
  store: Pick<StateStore, "task">,
  projectId: string,
): Promise<string> {
  const tasks = await store.task.forProject(projectId, {}, { limit: 1000 });
  const text = [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => JSON.stringify(taskSubject(t).fields))
    .join("\n");
  return `${tasks.length}:${fnv1a(text)}`;
}

function entriesOf(print: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of print.slice(FINGERPRINT_V2.length).split(",")) {
    const at = e.lastIndexOf("=");
    if (at > 0) out.set(e.slice(0, at), e.slice(at + 1));
  }
  return out;
}

/**
 * l4-selftasks-carried (L4f-left-2): whether the task list moved, since `was` was taken, in a
 * way that voids a fix of it: a task added or removed, or one of the tasks the set names
 * (`named`, task ids) changed its status, title, outcome or what it waits for. A status move of
 * a task the set does not name (a session finishing other work) leaves its Yes valid. A card
 * stored before tasks were kept apart is judged as it was then, on the whole list.
 */
export async function fixListMoved(
  store: Pick<StateStore, "task">,
  projectId: string,
  was: string,
  named: readonly string[],
): Promise<boolean> {
  if (!was.startsWith(FINGERPRINT_V2))
    return (await wholeListFingerprint(store, projectId)) !== was;
  const then = entriesOf(was);
  const now = entriesOf(await taskListFingerprint(store, projectId));
  if (then.size !== now.size) return true;
  for (const id of then.keys()) if (!now.has(id)) return true;
  return named.some((id) => then.get(id) !== now.get(id));
}

/** The parameters of a fix's calls that name a task of the list (ADR 0119's five commands). */
const NAMING_PARAMS = ["task", "depends_on", "before", "duplicate_of"] as const;

/**
 * l4-selftasks-carried (L4f-left-2): the tasks a fix set names, as ids: each call's task and the
 * tasks it waits for, comes before or is the same as, and every task the card names
 * (`subjects`). A name that is no id names no task of the list here.
 */
export function namedTaskIds(
  calls: readonly { params?: unknown }[],
  card?: ChangeCard | null,
): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
    else if (Array.isArray(v)) for (const x of v) add(x);
  };
  for (const c of calls) {
    const p = (c.params ?? {}) as Record<string, unknown>;
    for (const k of NAMING_PARAMS) add(p[k]);
  }
  for (const part of card ? partsOf(card) : []) for (const s of part.subjects ?? []) out.add(s.id);
  return [...out];
}

/**
 * L4-selftasks-105 (b): the Yes of a set of changes, one of which was refused when it was made,
 * so none was made (the set is all or nothing): that none was, why, and what to do. Before, the
 * reply was the refused part's own sentence alone ('Nothing to change on "Write the home page
 * index.html".'), which hid that the other changes were not made either.
 */
export function composedRefusal(count: number, reason: string, fixOfTasks: boolean): string {
  const why = reason.trim().replace(/[.\s]+$/, "");
  const said = /^[A-Z][a-z]/.test(why) ? `${why.charAt(0).toLowerCase()}${why.slice(1)}` : why;
  return `None of the ${count} changes was made: one could not be made (${said}). ${
    fixOfTasks ? 'Say "fix the tasks" to check again.' : "Ask again if you still want them."
  }`;
}
