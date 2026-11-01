import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type {
  HumanRequestRow,
  ProjectRow,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import {
  loadTaskDisplayContext,
  plainReason,
  reviewSentence,
  runOrder,
  taskDisplay,
} from "../daemon/task-display.ts";
import type { LastSessionOutcome } from "../session/result.ts";

/**
 * What the chat knows about a project on every turn (design §3.9, core-experience.md): the
 * project's tasks with their status in the person's words (§2), what each waits for and why it
 * failed; the last session's result by name; the open cards in full; what runs now; where the
 * files are. Before (the 2026-11-01 walks), the chat got the first 160 characters of a stale
 * summary, open requests cut at 80 characters and no task list, so "what failed and why?" and
 * "what is left?" could not be answered. These blocks go into the turn's volatile part (they
 * change with the work), never into the cached system prefix.
 *
 * The texts are for the model: task titles in quotes, statuses in words, no internal ids except
 * a card's short reference, which the `request_answer` tool needs and the person never sees.
 */

/** Tasks listed by name in a turn's context at most; the rest are counted. */
export const CONTEXT_TASKS_MAX = 40;

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** One task's line: title, status in words, what it waits for, why it failed or stopped, the critic. */
async function taskLine(
  store: Pick<StateStore, "review">,
  t: TaskRow,
  label: string,
  titleOf: (id: string) => string | undefined,
): Promise<string> {
  const parts = [`- ${quote(t.title)}: ${label}`];
  const waits = t.depends_on
    .map((id) => titleOf(id))
    .filter((x): x is string => !!x)
    .map(quote);
  if (waits.length && t.status !== "done" && t.status !== "cancelled")
    parts.push(`waits for ${waits.join(", ")}`);
  if (["failed", "needs_human"].includes(t.status) && t.reason.trim()) {
    const why = plainReason(t.reason, 300);
    if (why && !label.includes(why)) parts.push(`reason: ${why}`);
  }
  if (t.specialist)
    parts.push(t.specialist === "person" ? "done by you" : `by the ${t.specialist}`);
  if (t.attempt > 0 && !["draft", "ready"].includes(t.status)) {
    const review = await store.review.latestForTask(t.id);
    if (review) parts.push(`critic: ${reviewSentence(review.verdict).replace(/\.$/, "")}`);
  }
  return parts.join("; ");
}

/**
 * `# Tasks`: every task of the project in run order (at most `max` by name), each with its
 * status as the person sees it. Empty when the project has none.
 */
export async function tasksBlock(
  store: StateStore,
  projectId: string,
  opts: { sandboxReady?: boolean | null; max?: number; heading?: string } = {},
): Promise<string> {
  const rows = await store.task.forProject(projectId, {}, { limit: 10_000 });
  if (!rows.length) return `${opts.heading ?? "# Tasks"}\n(no tasks yet)`;
  const ctx = await loadTaskDisplayContext(store, rows, opts.sandboxReady ?? null);
  const ordered = runOrder(rows);
  const titles = new Map(rows.map((t) => [t.id, t.title]));
  const max = opts.max ?? CONTEXT_TASKS_MAX;
  const lines: string[] = [];
  for (const t of ordered.slice(0, max))
    lines.push(await taskLine(store, t, taskDisplay(t, ctx).label, (id) => titles.get(id)));
  const counts = new Map<string, number>();
  for (const t of rows) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const done = counts.get("done") ?? 0;
  const open = rows.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  const head = `${opts.heading ?? "# Tasks"} (run order; ${done} of ${rows.length - (counts.get("cancelled") ?? 0)} done, ${open} open)`;
  const more = ordered.length > max ? [`(and ${ordered.length - max} more not listed)`] : [];
  return [head, ...lines, ...more].join("\n");
}

function outcomeOf(project: ProjectRow): {
  summary?: string;
  endedAt?: string;
  outcome?: LastSessionOutcome;
  nextSteps: string[];
} {
  const cache = (project.summary_cache ?? {}) as {
    last_session?: { summary?: unknown; ended_at?: unknown; outcome?: unknown };
    next_steps?: unknown;
  };
  const last = cache.last_session;
  const outcome =
    last?.outcome && typeof last.outcome === "object"
      ? (last.outcome as LastSessionOutcome)
      : undefined;
  return {
    ...(typeof last?.summary === "string" ? { summary: last.summary } : {}),
    ...(typeof last?.ended_at === "string" ? { endedAt: last.ended_at } : {}),
    ...(outcome ? { outcome } : {}),
    nextSteps: Array.isArray(cache.next_steps)
      ? cache.next_steps.filter((s): s is string => typeof s === "string")
      : [],
  };
}

const names = (l: readonly { title: string }[] | undefined) => (l ?? []).map((t) => quote(t.title));

/**
 * `# Last session`: the result the person saw (at most three lines, written by the engine) and
 * its lists by name: what was done, what failed and why, what needs the person, what is left.
 * Empty before the project's first session.
 */
export function lastSessionBlock(project: ProjectRow, chfPerUsd = 1): string {
  const o = outcomeOf(project);
  // Before the first session: what is planned next (the intake writes it), if anything.
  if (!o.summary && !o.outcome)
    return o.nextSteps.length ? `# Next\nNext: ${o.nextSteps.map(quote).join(", ")}` : "";
  const lines = [`# Last session${o.endedAt ? ` (ended ${o.endedAt})` : ""}`];
  if (o.summary) lines.push(`Result: ${o.summary.replace(/\s*\n\s*/g, " ").trim()}`);
  const out = o.outcome;
  if (out) {
    if (out.done?.length) lines.push(`Done: ${names(out.done).join(", ")}`);
    for (const f of out.failed ?? [])
      lines.push(`Failed: ${quote(f.title)}${f.reason ? `: ${plainReason(f.reason, 300)}` : ""}`);
    if (out.needsYou?.length) lines.push(`Needs the person: ${names(out.needsYou).join(", ")}`);
    if (out.leftOver?.length) lines.push(`Not reached: ${names(out.leftOver).join(", ")}`);
    if (out.waitingForDocker?.length)
      lines.push(`Waiting for Docker: ${names(out.waitingForDocker).join(", ")}`);
    if (out.stopReason) lines.push(`Ended because: ${out.stopReason.replace(/_/g, " ")}`);
    if (typeof out.spentChfMicro === "number" && out.spentChfMicro > 0)
      lines.push(`Spent: ${formatChf(out.spentChfMicro)}`);
  }
  if (o.nextSteps.length) lines.push(`Next: ${o.nextSteps.map(quote).join(", ")}`);
  void chfPerUsd;
  return lines.join("\n");
}

/**
 * `# Working now`: the agent's running session on this project (or any, when no project is
 * given): its task in flight with the specialist, since when, and how far the plan is.
 */
export async function workingNowBlock(
  store: StateStore,
  agentId: string,
  projectId: string | null,
  now: number,
  chfPerUsd = 1,
): Promise<string> {
  const running = (await store.session.active(agentId)).filter(
    (s: SessionRow) =>
      s.summary !== "conversation" &&
      (s.status === "running" || s.status === "paused") &&
      (!projectId || s.project_id === projectId),
  );
  if (!running.length) return "";
  const lines = ["# Working now"];
  for (const s of running.slice(0, 3)) {
    const project = s.project_id ? await store.project.get(s.project_id) : undefined;
    const events = await store.event.list(
      s.id,
      Math.max(0, (await store.event.latestSeq(s.id)) - 400),
      400,
    );
    const last = events
      .filter((e) => e.type === "task.started" || e.type === "task.finished")
      .at(-1);
    const p = (last?.payload ?? {}) as { title?: unknown; specialist?: unknown };
    const started = Date.parse(s.started_at ?? s.created_at);
    const minutes = Number.isFinite(started)
      ? Math.max(0, Math.round((now - started) / 60_000))
      : null;
    const where = project ? ` on ${project.name}` : "";
    const task =
      last?.type === "task.started" && typeof p.title === "string"
        ? `: ${quote(p.title)}${typeof p.specialist === "string" ? ` (the ${p.specialist})` : ""}`
        : ": between tasks";
    const spent = formatChf(usdToChfMicro(s.spent_usd_micro, chfPerUsd));
    lines.push(
      `- A session${where} is ${s.status === "paused" ? "finishing its task, then it stops" : "running"}${task}; started ${minutes === null ? "recently" : `${minutes} min ago`}, ${s.steps} steps, ${spent} spent.`,
    );
  }
  return lines.join("\n");
}

/**
 * A card's names a reply can mention it by: its task's title and the subject of its question
 * (the words before the first colon or full stop, a quoted title left out).
 */
export function cardNames(r: Pick<HumanRequestRow, "why">, taskTitle: string | null): string[] {
  const why = plainReason(r.why.split(/\r?\n/)[0] ?? r.why, 200);
  const out: string[] = [];
  if (taskTitle && taskTitle.trim().length >= 4) out.push(taskTitle.trim());
  const head = (why.replace(/^"[^"]*"\s*/, "").split(/[:.]\s/)[0] ?? "").slice(0, 60).trim();
  if (head.length >= 6) out.push(head);
  return out;
}

/** Words that say nothing about which card is meant. */
const COMMON_WORDS = new Set(
  "about after again answer answers before cancel decide decision decisions failed needs other please should their there these those times waits which while would without".split(
    " ",
  ),
);

/** The words of a name that tell it apart (five letters or more, not common). */
function telling(name: string): string[] {
  return [
    ...new Set(
      name
        .toLowerCase()
        .split(/[^a-z0-9äöüéèàß]+/i)
        .filter((w) => w.length >= 5 && !COMMON_WORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ];
}

/**
 * Whether a reply names the card: one of its names whole, or two of a name's telling words
 * ("the model watch report" names "Model watch 2026-10-26: 10 new models").
 */
export function replyNames(reply: string, names: readonly string[]): boolean {
  const r = reply.toLowerCase();
  const words = new Set(r.split(/[^a-z0-9äöüéèàß]+/i));
  return names.some((n) => {
    if (!n) return false;
    if (r.includes(n.toLowerCase())) return true;
    const t = telling(n);
    return t.length >= 2 && t.filter((w) => words.has(w)).length >= 2;
  });
}

/** A card in full for the model: project, task, the question and its options. */
export function cardLine(
  r: Pick<HumanRequestRow, "why" | "options" | "steps" | "change_card">,
  projectName: string | null,
  taskTitle: string | null,
): string {
  const where = [projectName, taskTitle ? quote(taskTitle) : null].filter(Boolean).join(", ");
  const said = plainReason(r.why.replace(/\s*\n\s*/g, " "), 600);
  const why = /[.!?…"]$/.test(said) ? said : `${said}.`;
  const key = (r.change_card as { key?: unknown } | null)?.key;
  const steps =
    typeof key === "string" && key.startsWith("person_questions:") && r.steps.length
      ? ` Questions: ${r.steps.map((s) => plainReason(String(s), 200)).join(" | ")}.`
      : "";
  const options = r.options.length ? ` Options: ${r.options.map(String).join(" / ")}.` : "";
  return `${where ? `[${where}] ` : ""}${why}${steps}${options}`;
}

/** `# Your files`: where the project's files are (its folder or checkout). */
export function filesBlock(folder: string | null): string {
  return folder ? `# Your files\nThe project's folder: ${folder}` : "";
}
