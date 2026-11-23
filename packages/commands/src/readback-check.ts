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

/** Run C decision 53: the Yes of a fix of the task list whose tasks changed since its check. */
export const TASKS_CHANGED_REPLY =
  'The tasks changed since I checked them; say "fix the tasks" to check again.';

/**
 * The task list as the check judged it: every task's id, status, title, outcome, criteria,
 * priority, what it waits for and who does it (not its spend or claims, which move while a
 * session runs), as a short hash (FNV-1a, no dependency).
 */
export async function taskListFingerprint(
  store: Pick<StateStore, "task">,
  projectId: string,
): Promise<string> {
  const tasks = await store.task.forProject(projectId, {}, { limit: 1000 });
  const text = [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => JSON.stringify(taskSubject(t).fields))
    .join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${tasks.length}:${h.toString(16)}`;
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
