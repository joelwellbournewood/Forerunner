import { formatChf, usdToChfMicro } from "@forerunner/billing";
import { isAbsolute } from "@forerunner/platform";
import type {
  HumanRequestRow,
  ProjectRow,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { requestWords } from "../daemon/request-words.ts";
import {
  loadTaskDisplayContext,
  plainReason,
  reviewSentence,
  runOrder,
  taskDisplay,
} from "../daemon/task-display.ts";
import { parseRepoRef } from "../loop/docs.ts";
import { mergeModeOf } from "../loop/merge-mode.ts";
import type { IntakeState } from "../session/intake.ts";
import { type LastSessionOutcome, stopWords } from "../session/result.ts";

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

/** The `en-GB` formatter of one zone, or null when the platform does not know the zone. */
function dayFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

/**
 * The person's own day and time for the chat's `# Now` (d1109-chat-guard, ADR 0114, D3-6):
 * "Monday 9 November 2026, 23:30 (Europe/Zurich)", from `human.timezone`, beside the UTC `now`
 * the facts already carry. "Yesterday", "last week" and "on Monday" are the person's days:
 * before, the facts gave only the UTC timestamp and the stored zone was unused. A zone the
 * platform does not know is read as UTC and named so. The line goes into the turn's volatile
 * part, so the cached prefix does not move.
 */
export function todayLine(timeZone: string, nowMs: number): string {
  const zone = timeZone.trim();
  const fmt = (zone && dayFormatter(zone)) || dayFormatter("UTC");
  const named = zone && dayFormatter(zone) ? zone : "UTC";
  const parts = Object.fromEntries(
    (fmt as Intl.DateTimeFormat).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${named})`;
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** One task's line: title, status in words, what it waits for, why it failed or stopped, the critic. */
async function taskLine(
  store: Pick<StateStore, "review" | "finding">,
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
    // What the critic still asks for, in its words: the "why" behind a send-back or a failure.
    if (t.status !== "done") {
      const open = review ? await store.finding.openFor(t.id) : [];
      const asked = open[0] ? plainReason(open[0].required_action || open[0].description, 200) : "";
      if (asked) parts.push(`still asked for: ${asked}`);
    }
  }
  return parts.join("; ");
}

/**
 * `# Tasks`: every task of the project in run order (at most `max` by name), each with its
 * status as the person sees it. A project with none says `empty` ("(no tasks yet)" by default;
 * `emptyTasksLine` while the plan from the brief is not approved).
 */
export async function tasksBlock(
  store: StateStore,
  projectId: string,
  opts: { sandboxReady?: boolean | null; max?: number; heading?: string; empty?: string } = {},
): Promise<string> {
  const rows = await store.task.forProject(projectId, {}, { limit: 10_000 });
  if (!rows.length) return `${opts.heading ?? "# Tasks"}\n${opts.empty ?? "(no tasks yet)"}`;
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
    // budget-resume: paused at a budget, its card offers Continue or Cancel.
    for (const p of out.paused ?? []) lines.push(`Paused: ${quote(p.title)} at ${p.limit}`);
    if (out.leftOver?.length) lines.push(`Not reached: ${names(out.leftOver).join(", ")}`);
    if (out.waitingForDocker?.length)
      lines.push(`Waiting for Docker: ${names(out.waitingForDocker).join(", ")}`);
    // In words (design §5.6; phase E: before, the raw reason, "Ended because: plan awaiting
    // approval"); a session that simply ran out of work says nothing more.
    const ended = out.stopReason ? stopWords(out.stopReason, out.stopCapChfMicro) : "";
    if (ended) lines.push(`How it ended: ${ended}`);
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

/**
 * A card in full for the model: project, task, the question, the specialist's reason and the
 * options the Inbox offers (W15-30: before, the stored options alone, "Cancel the task", while
 * the Inbox offered Send answers, Go ahead without and Cancel task, and no reason). A card of
 * another project (`otherProject`) says "this project" as the card's project: live, "for this
 * project" in a Static hosts card read as the project being talked about.
 */
export function cardLine(
  r: Pick<
    HumanRequestRow,
    "kind" | "why" | "options" | "steps" | "change_card" | "status" | "answer"
  >,
  projectName: string | null,
  taskTitle: string | null,
  opts: { otherProject?: boolean } = {},
): string {
  const where = [projectName, taskTitle ? quote(taskTitle) : null].filter(Boolean).join(", ");
  const card = (r.change_card ?? {}) as { key?: unknown; context?: unknown; ask?: unknown };
  // A change waiting for a yes says its question, as the Inbox titles it (W15-34: an undo's
  // `why` is the setting's name alone, "web pages research may read for Reading rules").
  const asked = typeof card.ask === "string" && card.ask.trim() ? card.ask : r.why;
  const said = plainReason(asked.replace(/\s*\n\s*/g, " "), 600);
  const why = /[.!?…"]$/.test(said) ? said : `${said}.`;
  const key = card.key;
  const steps =
    typeof key === "string" && key.startsWith("person_questions:") && r.steps.length
      ? ` Questions: ${r.steps.map((s) => plainReason(String(s), 200)).join(" | ")}.`
      : "";
  // Why the specialist asks, in its words, as the Inbox card's body quotes it (L-12).
  const context =
    typeof card.context === "string"
      ? plainReason(card.context.replace(/^[\s:;,.\-–—*]+/, "").replace(/"/g, "'"), 300)
      : "";
  const reason = context ? ` The specialist said: "${context}"` : "";
  const words = requestWords(r, { projectName, taskTitle });
  const labels = [
    ...(words.reply === "form" ? ["Send answers"] : []),
    ...words.choices.map((c) => c.label),
  ];
  const offered = labels.length ? labels : r.options.map(String);
  const options = offered.length ? ` Options: ${offered.join(" / ")}.` : "";
  const line = `${why}${steps}${reason}${options}`;
  const own =
    opts.otherProject && projectName
      ? line.replace(
          /\b(t)his project\b/gi,
          (_m, t: string) => `${t === "T" ? "The" : "the"} ${projectName} project`,
        )
      : line;
  return `${where ? `[${where}] ` : ""}${own}`;
}

/**
 * Whether a card's line (`cardLine`) quotes words Forerunner did not write (d1109-chat-guard,
 * ADR 0114): a specialist's questions, why it asks or what it said (`context`, `said`), the
 * critic's words, a proposed specialist's description, or any card a specialist or the critic
 * filed. A chat turn whose facts list such a card in full reads every change back first, since
 * those words may be what asks for it. A card in Forerunner's own words (a budget pause, the
 * Docker card, a merge left to the person) does not.
 */
export function quotesOthersWords(r: Pick<HumanRequestRow, "change_card" | "steps">): boolean {
  const card = (r.change_card ?? {}) as Record<string, unknown>;
  const said = (k: string) => typeof card[k] === "string" && (card[k] as string).trim() !== "";
  if (said("context") || said("said") || said("description")) return true;
  if (card.source === "specialist" || card.source === "critic") return true;
  return (
    typeof card.key === "string" && card.key.startsWith("person_questions:") && r.steps.length > 0
  );
}

/** Where the plan from the brief stands, as the chat is told it (`IntakeService.status`). */
export interface PlanState {
  state: IntakeState;
  /** Why planning failed, in words (`intakeFailureWords`), for `failed`. */
  error: string | null;
  /** What planning waits for, for `waiting` (U-078): the project page's sentence. */
  wait?: { text: string; reason: string } | null;
}

/**
 * `# Plan from the brief` (design §3.3, §3.9): the plan the intake drafts from the brief, while
 * it is drafted, waits in the Inbox, failed or was rejected; empty once it is approved (the
 * tasks speak for themselves) or when none was asked for. Before (the live run of 2026-11-01)
 * the chat got only "(no tasks yet)" and answered a person whose planning had failed "The
 * Quote page project has no tasks yet… I can add tasks…", with no word of the failure or of
 * Try again.
 */
export function planBlock(plan: PlanState): string {
  const line = planLine(plan);
  return line ? `# Plan from the brief\n${line}` : "";
}

function planLine({ state, error, wait }: PlanState): string {
  switch (state) {
    // U-078: no failure and nothing to press; the plan is drafted by itself once the
    // credential serves (a refused one, once the person saves a new one in Settings).
    case "waiting":
      return `${wait?.text ?? "Planning waits for a Claude credential."} There is no Try again: ${
        wait?.reason === "refused"
          ? "once the person saves a new one, the plan is drafted by itself."
          : "the plan is drafted by itself then."
      }`;
    case "drafting":
      return "The plan from your brief is being drafted.";
    case "pending":
      return "The plan from your brief waits for your approval in the Inbox.";
    case "failed": {
      const cause = (error ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.\s]+$/, "");
      // A cause that says Try again itself (a lost "Change the plan" draft, a usage limit) is
      // not followed by the same sentence: only where the button is.
      const where = /\btry again\b/i.test(cause)
        ? "The Try again button is on the project page."
        : "The person can press Try again on the project page.";
      return `Planning failed${cause ? `: ${cause}` : ""}. ${where}`;
    }
    case "rejected":
      return "The person rejected the plan; nothing was written. They can press Draft a new plan on the project page.";
    default:
      return "";
  }
}

/**
 * What an empty `# Tasks` list says while the plan from the brief is not approved: why it is
 * empty, in the plan's terms. Before, it said "(no tasks yet)" next to the plan block, and the
 * live run's reply echoed exactly that ("no tasks yet… I can add tasks…"); the reply rules
 * alone kept the model from it (the review of 2026-11-02).
 */
export function emptyTasksLine(plan: PlanState | null): string {
  switch (plan?.state) {
    case "drafting":
    case "pending":
      return "(none yet: the plan from the brief writes them once it is approved)";
    case "failed":
      return "(none yet: planning failed, so nothing was written)";
    case "waiting":
      return "(none yet: planning waits for a Claude credential, so nothing was written)";
    case "rejected":
      return "(none yet: the plan was rejected, so nothing was written)";
    default:
      return "(no tasks yet)";
  }
}

/** A done task's pull request, as the files block and files_list name it. */
export interface TaskPullRequest {
  title: string;
  url: string;
}

/** What `filesBlock` says about a repository project (`repositoryFacts`). */
export interface RepositoryFacts {
  fullName: string;
  /**
   * Done tasks whose merge waits for the person, each with its merge record's sentence (why it
   * waits and what to do: "#4 waits for you to merge it: press Merge on the Overview.").
   */
  waiting: (TaskPullRequest & { sentence: string })[];
  /** Done tasks whose merge goes on by itself (after a Merge, under way, waiting for checks). */
  merging: (TaskPullRequest & { sentence: string })[];
  /** Done tasks whose pull request was merged. */
  merged: TaskPullRequest[];
  /** Done tasks whose pull request was closed without merging. */
  closed: TaskPullRequest[];
  /** Done tasks with a pull request and no merge record (accepted before ADR 0111): no state. */
  unknown: TaskPullRequest[];
}

/** "#4" for a pull request in a sentence. */
const prName = (n: number) => `#${n}`;

/** The done tasks of a project that have a pull request, in run order. */
export async function donePullRequests(
  store: Pick<StateStore, "task">,
  projectId: string,
): Promise<(TaskPullRequest & { taskId: string })[]> {
  const tasks = await store.task.list({ project_id: projectId } as never, { limit: 2000 });
  return runOrder(tasks)
    .filter((t) => t.status === "done" && !!t.pr_url)
    .map((t) => ({ taskId: t.id, title: t.title, url: t.pr_url ?? "" }));
}

/** The repository a project is linked to ("owner/name"), or null for a folder project. */
export function repositoryNameOf(project: Pick<ProjectRow, "repos">): string | null {
  const first = project.repos[0]?.trim() ?? "";
  // A local folder (spec A.4) is an absolute path, not a repository on a host.
  if (!first || isAbsolute(first)) return null;
  const ref = parseRepoRef(first);
  return ref ? `${ref.owner}/${ref.name}` : null;
}

/**
 * A repository project's name and where each done task's merge stands, from the app's own merge
 * records (d1109-chat-guard, ADR 0114: Merge and the watcher keep them, within the watcher's
 * minute), never from GitHub, so a chat turn's first word waits on nothing. Before (7d6b34a)
 * every turn asked GitHub for the open pull requests first (L-17) and waited for its answer or
 * its timeout, whatever was asked. A done task without a record (one accepted before ADR 0111)
 * is listed without a state; files_list asks the host when it is called.
 */
export async function repositoryFacts(
  store: Pick<StateStore, "task" | "mergeRecord">,
  project: Pick<ProjectRow, "id" | "repos"> & Partial<Pick<ProjectRow, "settings">>,
): Promise<RepositoryFacts | null> {
  const fullName = repositoryNameOf(project);
  if (!fullName) return null;
  const facts: RepositoryFacts = {
    fullName,
    waiting: [],
    merging: [],
    merged: [],
    closed: [],
    unknown: [],
  };
  const mode = mergeModeOf(project.settings);
  for (const pr of await donePullRequests(store, project.id)) {
    const record = await store.mergeRecord.forTask(pr.taskId);
    const item = { title: pr.title, url: pr.url };
    if (!record || record.pr_url !== pr.url) {
      facts.unknown.push(item);
      continue;
    }
    const said = record.sentence.trim();
    const name = prName(record.pr_number);
    if (record.state === "merged") facts.merged.push(item);
    else if (record.state === "left_to_you" && record.last_outcome === "closed")
      facts.closed.push(item);
    else if (record.state === "left_to_you")
      facts.waiting.push({ ...item, sentence: said || `${name} waits for you to merge it.` });
    else if (record.state === "queued" && record.approval === "none" && mode === "you")
      // Accepted, and "You press Merge" leaves it for the click (the merge gate's sentence).
      facts.waiting.push({
        ...item,
        sentence: said || `${name} waits for you to merge it: press Merge on the Overview.`,
      });
    else
      facts.merging.push({
        ...item,
        sentence:
          said ||
          (record.state === "waiting_checks"
            ? `${name} merges when its checks pass.`
            : `${name} is being merged.`),
      });
  }
  return facts;
}

/** Up to ten '"Title" url' items, then "and N more" (design §5 rule 5). */
export function prList(prs: readonly TaskPullRequest[]): string {
  return `${prs
    .slice(0, 10)
    .map((p) => `"${p.title}" ${p.url}`)
    .join("; ")}${prs.length > 10 ? ` and ${prs.length - 10} more` : ""}`;
}

/**
 * `# Your files`: where the project's files are. A folder project: its folder. A repository
 * project (ADR 0106): the repository, this computer's copy of the default branch, then where
 * each done task's merge stands from the app's merge records (d1109-chat-guard): the merges that
 * wait for the person with the record's sentence, those going on by themselves, those merged or
 * closed, and the pull requests no record speaks for. Before (live, 2026-11-01) the chat said
 * "the files are in the project folder you already set up" with no folder named; until
 * d1109-chat-guard it told the model "the person merges it on GitHub", while Merge is in the
 * app (D3-8).
 */
export function filesBlock(folder: string | null, repository?: RepositoryFacts | null): string {
  if (!repository) return folder ? `# Your files\nThe project's folder: ${folder}` : "";
  const lines = [
    "# Your files",
    `The repository: ${repository.fullName}. Each task's work is a pull request there; it is on the default branch once it is merged.`,
  ];
  if (folder) lines.push(`This computer's copy of the default branch: ${folder}`);
  for (const p of repository.waiting.slice(0, 10))
    lines.push(`Waiting for your Merge: "${p.title}": ${p.sentence}`);
  if (repository.waiting.length > 10)
    lines.push(`And ${repository.waiting.length - 10} more waiting for your Merge.`);
  for (const p of repository.merging.slice(0, 10))
    lines.push(`Merging by itself: "${p.title}": ${p.sentence}`);
  if (repository.merging.length > 10)
    lines.push(`And ${repository.merging.length - 10} more merging by themselves.`);
  if (repository.merged.length) lines.push(`Merged: ${prList(repository.merged)}`);
  if (repository.closed.length) lines.push(`Closed without merging: ${prList(repository.closed)}`);
  if (repository.unknown.length)
    lines.push(`Pull requests of finished tasks: ${prList(repository.unknown)}`);
  return lines.join("\n");
}
