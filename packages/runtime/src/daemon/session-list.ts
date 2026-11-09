import { formatChf } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
import { moneyWords } from "../session/money-words.ts";
import { isIntakeSession, namesOf } from "../session/recovery.ts";
import {
  type LastSessionOutcome,
  type NamedTask,
  type PausedTask,
  RESULT_LINE_BUILDERS,
  type ResultFacts,
} from "../session/result.ts";
import {
  blockedOfHandoff,
  type EndedWaits,
  endedStatusText,
  planningStatusText,
  stopReasonOfHandoff,
} from "../session/stop-words.ts";
import type {
  Money,
  ProjectSessionRowView,
  ProjectSessionsView,
  SessionTasksView,
  SessionTaskView,
} from "./api-types.ts";
import { type ProjectWorking, projectStatusLine } from "./project-status.ts";
import { loadTaskDisplayContext, taskDisplay } from "./task-display.ts";
import { shortTitle, withoutIds } from "./task-words.ts";

/**
 * A project lists its sessions (the owner's decision D2 of 2026-11-09, d1109-sessions, ADR
 * 0116): "every project has a list of its sessions (what each did, spent, how it ended), each
 * opening the session's page". Every word of the Sessions tab, of a session page's "Tasks in
 * this session" and of the chat's recall of a session is written here, by the daemon (ADR 0102:
 * the screens and the phone show the daemon's words). Later areas change only the function
 * their spec names: d1109-chat-recall reads `sessionGist`, `spentWords` and
 * `projectSessionsView`; d1109-starts-engine adds the words for `hands_off` and `continuation`
 * in `startedByWords`; d1109-onerepo-join adds the joined project's line in
 * `projectSessionsView`; d1109-run-visible makes `workingWords` read its run view.
 *
 * Money: one figure per session, the cost ledger's CHF as booked, read when shown (ADR 0008,
 * U-074): the list row, the session page's "Spent of this session's budget" and the result's
 * cost sentence on the session page and the Overview all read `spentOf`, so a rate change, a
 * restart, a recovery or a stopped run's late booking never leaves two amounts for one session.
 * No stored text is rewritten (`resultTextNow` replaces the cost sentence when the text is
 * shown); an Update or a notification already sent keeps the amount it said.
 */

/** A sentence of the list at most this long (design §5 rule 1, a consequence line). */
export const GIST_MAX = 100;
/** Rows of a page unless asked otherwise, and the most one page holds. */
export const SESSIONS_PAGE = 20;
export const SESSIONS_PAGE_MAX = 50;

const WORKING = new Set(["planned", "running", "paused"]);

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** A text cut at a word with "…" when longer than `max` (never mid-word). */
function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * A sentence that names tasks, at most `GIST_MAX` characters: the titles are shortened at a
 * word before fewer of them are named ("and 2 more"); never cut mid-word.
 */
function fitted(titles: readonly string[], build: (names: string) => string): string {
  for (const max of [3, 2, 1])
    for (const len of [60, 40, 30, 22, 16]) {
      const s = build(
        namesOf(
          titles.map((t) => shortTitle(t, len)),
          max,
        ),
      );
      if (s.length <= GIST_MAX) return s;
    }
  return cut(
    build(
      namesOf(
        titles.map((t) => shortTitle(t, 12)),
        1,
      ),
    ),
    GIST_MAX,
  );
}

// --- What a session did --------------------------------------------------------------------

/**
 * What a session did, as its row records it (`handoff.outcome`, written at its end by the
 * runner and by the recovery since run C), or as an older row allows: its `handoff.done` ids
 * (named from the tasks) and its `handoff.blocked` as a count ("2 left for you").
 */
export interface SessionRecord {
  done: NamedTask[];
  failed: NamedTask[];
  paused: PausedTask[];
  needsYou: NamedTask[];
  cancelled: NamedTask[];
  /** An older row's tasks left waiting for the person, counted, never named by id. */
  leftForYou: number;
}

/** The named outcome a session row keeps (`handoff.outcome`), or null for an older row. */
export function outcomeOfHandoff(handoff: unknown): LastSessionOutcome | null {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const o = (handoff as { outcome?: unknown }).outcome;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const v = o as Partial<LastSessionOutcome>;
  if (!Array.isArray(v.done) || !Array.isArray(v.failed) || !Array.isArray(v.needsYou)) return null;
  return o as LastSessionOutcome;
}

const ids = (handoff: unknown, key: string): string[] => {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return [];
  const v = (handoff as Record<string, unknown>)[key];
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
};

const named = (l: unknown): NamedTask[] =>
  Array.isArray(l)
    ? (l as NamedTask[]).filter((t) => t && typeof t.title === "string" && typeof t.id === "string")
    : [];

/** The record of an outcome (`LastSessionOutcome`). */
export function recordOfOutcome(o: LastSessionOutcome): SessionRecord {
  return {
    done: named(o.done),
    failed: named(o.failed),
    paused: named(o.paused) as PausedTask[],
    needsYou: named(o.needsYou),
    cancelled: named(o.cancelled),
    leftForYou: 0,
  };
}

/**
 * What a session did: its row's outcome; for a row written before run C, the outcome the
 * project's cache kept for it when it was the last session (`cached`), else its done ids named
 * from the tasks and its blocked tasks counted.
 */
export async function sessionRecord(
  store: StateStore,
  row: Pick<SessionRow, "id" | "handoff">,
  cached?: LastSessionOutcome | null,
): Promise<SessionRecord> {
  const outcome = outcomeOfHandoff(row.handoff) ?? cached ?? null;
  if (outcome) return recordOfOutcome(outcome);
  const done: NamedTask[] = [];
  for (const id of ids(row.handoff, "done")) {
    const t = await store.task.get(id).catch(() => undefined);
    if (t) done.push({ id: t.id, title: t.title });
  }
  return {
    done,
    failed: [],
    paused: [],
    needsYou: [],
    cancelled: [],
    leftForYou: ids(row.handoff, "blocked").length,
  };
}

/** How many tasks of each kind a session ended, for the list row. */
export interface SessionTaskCounts {
  done: number;
  failed: number;
  paused: number;
  needsYou: number;
  cancelled: number;
  leftForYou: number;
}

export function countsOf(r: SessionRecord): SessionTaskCounts {
  return {
    done: r.done.length,
    failed: r.failed.length,
    paused: r.paused.length,
    needsYou: r.needsYou.length,
    cancelled: r.cancelled.length,
    leftForYou: r.leftForYou,
  };
}

/** "2 done", "1 done, 1 failed, 1 paused", "2 left for you"; "" when none (no zero counts). */
export function countsWords(c: SessionTaskCounts): string {
  return [
    c.done ? `${c.done} done` : null,
    c.failed ? `${c.failed} failed` : null,
    c.paused ? `${c.paused} paused` : null,
    c.needsYou ? `${c.needsYou} needed you` : null,
    c.cancelled ? `${c.cancelled} cancelled` : null,
    c.leftForYou ? `${c.leftForYou} left for you` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * What a session did, in one sentence of at most 100 characters (design §5): what it finished
 * first, else what paused, failed, needed the person or was cancelled; "Nothing finished." when
 * nothing did. The session page keeps the whole result (§5 rule 10).
 */
export function sessionGist(r: SessionRecord): string {
  const titles = (l: readonly NamedTask[]) => l.map((t) => t.title);
  if (r.done.length)
    return fitted(
      titles(r.done),
      (names) => `Did ${r.done.length} ${plural(r.done.length, "task")}: ${names}.`,
    );
  if (r.paused.length) {
    const limits = [...new Set(r.paused.map((t) => t.limit).filter(Boolean))];
    const at = limits.length === 1 && limits[0] ? limits[0] : "a budget";
    return fitted(titles(r.paused), (names) => `${names} paused at ${at}.`);
  }
  if (r.failed.length) return fitted(titles(r.failed), (names) => `${names} failed.`);
  if (r.needsYou.length)
    return fitted(titles(r.needsYou), (names) => `${names} needed your answer.`);
  if (r.cancelled.length)
    return fitted(titles(r.cancelled), (names) => `You cancelled ${names}; nothing else ran.`);
  return "Nothing finished.";
}

// --- A planning call -------------------------------------------------------------------------

/** What a planning call came to: drafting, a plan filed (its size and fate), or a failure. */
export interface PlanningFacts {
  state: "drafting" | "drafted" | "failed";
  /** The plan's tasks, when its card is known. */
  tasks?: number | null;
  /** What became of the plan's card. */
  fate?: "waits" | "approved" | "changed" | "rejected" | null;
  /** Why it failed, in the words the project page showed (`handoff.planning.failure`). */
  failure?: string | null;
}

/**
 * A planning call's row in words: "Drafting the plan…", "Drafted a plan of 5 tasks; you
 * approved it.", "Planning failed: Claude did not answer (network)." Never "intake: Quote page
 * (completed: 2 docs)", the row's stored text, which named the internal step (U-074).
 */
export function planningGist(p: PlanningFacts): string {
  if (p.state === "drafting") return "Drafting the plan…";
  if (p.state === "failed") {
    const why = (p.failure ?? "").trim();
    return why ? cut(`Planning failed: ${why}`, GIST_MAX) : "Planning failed.";
  }
  const size =
    typeof p.tasks === "number" && p.tasks > 0
      ? `Drafted a plan of ${p.tasks} ${plural(p.tasks, "task")}`
      : "Drafted a plan";
  switch (p.fate) {
    case "waits":
      return `${size}; it waits for your approval.`;
    case "approved":
      return `${size}; you approved it.`;
    case "changed":
      return `${size}; you asked for changes.`;
    case "rejected":
      return `${size}; you rejected it.`;
    default:
      return `${size}.`;
  }
}

/** The failure words a planning call's row keeps (`handoff.planning.failure`), or null. */
function planningFailureOf(handoff: unknown): string | null {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const p = (handoff as { planning?: { failure?: unknown } }).planning;
  return typeof p?.failure === "string" && p.failure.trim() ? p.failure : null;
}

/** The plan's card a planning call filed (`session_id` is the row's). */
async function planCardOf(store: StateStore, sessionId: string): Promise<HumanRequestRow | null> {
  const rows = await store.humanRequest
    .list({ session_id: sessionId } as never, { limit: 20 })
    .catch(() => [] as HumanRequestRow[]);
  return (
    rows.find((r) => {
      const card = (r.change_card ?? {}) as { proposal?: unknown };
      return r.kind === "approval" && !!card.proposal;
    }) ?? null
  );
}

/** The planning facts of a planning call's row: its plan card's size and fate, or its failure. */
export async function planningFactsOf(store: StateStore, row: SessionRow): Promise<PlanningFacts> {
  if (WORKING.has(row.status)) return { state: "drafting" };
  if (row.status !== "completed")
    return { state: "failed", failure: planningFailureOf(row.handoff) };
  const card = await planCardOf(store, row.id);
  if (!card) return { state: "drafted" };
  const cc = (card.change_card ?? {}) as {
    proposal?: { plan?: { milestones?: { tasks?: unknown[] }[]; tasks?: unknown[] } };
    outcome?: unknown;
  };
  const plan = cc.proposal?.plan;
  const tasks =
    (plan?.milestones ?? []).reduce(
      (n, m) => n + (Array.isArray(m?.tasks) ? m.tasks.length : 0),
      0,
    ) + (Array.isArray(plan?.tasks) ? plan.tasks.length : 0);
  const outcome = typeof cc.outcome === "string" ? cc.outcome : null;
  const fate: PlanningFacts["fate"] =
    card.status === "open"
      ? "waits"
      : outcome === "approved" || outcome === "apply_failed"
        ? "approved"
        : outcome === "changed"
          ? "changed"
          : outcome === "rejected"
            ? "rejected"
            : null;
  return { state: "drafted", tasks, fate };
}

// --- How it ended, how it started, what it cost ---------------------------------------------

/**
 * How a session ended, in the session page's own words (one map, `sessionStatusText`), or null
 * while it works. A planning call says how it ended only when it failed: its gist says the rest.
 * `waits`: the tasks it left waiting that still wait now ("Ended: 1 task needs you" stays true).
 */
export function sessionEndWords(
  row: Pick<SessionRow, "status" | "handoff" | "plan">,
  waits?: number | EndedWaits,
): string | null {
  if (WORKING.has(row.status)) return null;
  if (isIntakeSession(row))
    return row.status === "completed" ? null : planningStatusText(row.status);
  return endedStatusText(
    row.status,
    stopReasonOfHandoff(row.handoff),
    waits ?? blockedOfHandoff(row.handoff),
  );
}

/** Who asked for a session (`plan.startedBy`, written by d1109-starts-engine from run C3). */
export interface StartedBy {
  by: "person" | "schedule" | "hands_off" | "continuation";
  /** The session a continuation goes on with. */
  continues?: string;
}

function startedByOf(plan: unknown): StartedBy | null {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const s = (plan as { startedBy?: unknown }).startedBy;
  if (!s || typeof s !== "object") return null;
  const by = (s as { by?: unknown }).by;
  return by === "person" || by === "schedule" || by === "hands_off" || by === "continuation"
    ? (s as StartedBy)
    : null;
}

/**
 * Why a session started when the person did not press Start, or null for a plain start: who
 * asked first (`plan.startedBy`), then the trigger for older rows. A plain Start, an answer's,
 * Continue's or a limit change's start (trigger `message`) and the old credential wake
 * (`budget_reset`) say nothing: "started by itself" would be untrue for them. The words for
 * `hands_off` and `continuation` ("goes on with your session of 14:05") are d1109-starts-engine's
 * (run C3), in this function.
 */
export function startedByWords(row: Pick<SessionRow, "plan" | "trigger">): string | null {
  const who = startedByOf(row.plan);
  if (who) {
    switch (who.by) {
      case "schedule":
        return "started on its schedule";
      case "person":
        return row.trigger === "remote" ? "started from your phone" : null;
      default:
        // `hands_off` and `continuation`: d1109-starts-engine's words (run C3).
        return null;
    }
  }
  switch (row.trigger) {
    case "schedule":
      return "started on its schedule";
    case "remote":
      return "started from your phone";
    // Rows made before run C (d1109-starts-engine's S-4 stops these starts).
    case "pr_comment":
      return "started by a pull request comment";
    case "ci":
      return "started by CI";
    default:
      return null;
  }
}

/** One session's spend, as the ledger booked it, and the kinds of credential that paid. */
export interface SessionSpend {
  usdMicro: number;
  chfMicro: number;
  entries: number;
  /** Billing-source kinds with spend (`api_key`, `subscription`, `plan_credits`, `fake`). */
  kinds: string[];
}

/** The ledger's sums per session (`sumsBySessionAndSource`), by session id. */
export async function sessionSpends(
  store: StateStore,
  sessionIds: readonly string[],
): Promise<Map<string, SessionSpend>> {
  const out = new Map<string, SessionSpend>();
  if (!sessionIds.length) return out;
  for (const s of await store.costLedger.sumsBySessionAndSource(sessionIds)) {
    const cur = out.get(s.sessionId) ?? { usdMicro: 0, chfMicro: 0, entries: 0, kinds: [] };
    cur.usdMicro += s.usd_micro;
    cur.chfMicro += s.chf_micro;
    cur.entries += s.entries;
    if (s.sourceKind && s.usd_micro > 0 && !cur.kinds.includes(s.sourceKind))
      cur.kinds.push(s.sourceKind);
    out.set(s.sessionId, cur);
  }
  return out;
}

/**
 * The one figure of a session: the ledger's sum as booked (its CHF at each booking's rate);
 * a row with no ledger row at all reads its own counter at today's rate.
 */
export function spentOf(
  spend: Pick<SessionSpend, "usdMicro" | "chfMicro" | "entries"> | undefined,
  row: Pick<SessionRow, "spent_usd_micro">,
  chfPerUsd: number,
): Money {
  if (spend && spend.entries > 0) return { usdMicro: spend.usdMicro, chfMicro: spend.chfMicro };
  return { usdMicro: row.spent_usd_micro, chfMicro: Math.round(row.spent_usd_micro * chfPerUsd) };
}

const CREDENTIAL_ORDER = ["api_key", "subscription", "plan_credits"] as const;
const CREDENTIAL_NAME: Record<(typeof CREDENTIAL_ORDER)[number], string> = {
  api_key: "your API key",
  subscription: "your Claude subscription",
  plan_credits: "your plan credits",
};

/**
 * "CHF 0.80 on your API key", "CHF 0.80 of your Claude subscription's allowance" (a subscription
 * is measured against its allowance, never charged), "CHF 0.80 of your plan credits", "CHF 0.80
 * on your API key and your Claude subscription" when both paid, "less than CHF 0.01 on your API
 * key"; no credential words on the stand-in. `working`: "CHF 0.40 so far on your API key".
 */
export function spentWords(
  spend: { chfMicro: number; kinds?: readonly string[] },
  opts: { working?: boolean } = {},
): string {
  const amount = `${moneyWords(formatChf(spend.chfMicro), spend.chfMicro)}${opts.working ? " so far" : ""}`;
  const kinds = CREDENTIAL_ORDER.filter((k) => (spend.kinds ?? []).includes(k));
  if (kinds.length === 0) return amount;
  if (kinds.length === 1) {
    const only = kinds[0] as (typeof CREDENTIAL_ORDER)[number];
    if (only === "api_key") return `${amount} on your API key`;
    if (only === "subscription") return `${amount} of your Claude subscription's allowance`;
    return `${amount} of your plan credits`;
  }
  const names = kinds.map((k) => CREDENTIAL_NAME[k]);
  return `${amount} on ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The result's cost sentence for an amount, as the result's own builder writes it. */
function costSentence(chfMicro: number): string {
  const builder = RESULT_LINE_BUILDERS.find((b) => b.name === "cost");
  const [s] =
    builder?.build(
      {} as ResultFacts,
      { spentChfMicro: chfMicro } as LastSessionOutcome,
      undefined,
    ) ?? [];
  return s ?? "";
}

/**
 * A stored session result as it reads now (design §5 rule 4; ADR 0116): its cost sentence,
 * rebuilt from the stored outcome's `spentChfMicro` with the result's own builder, is replaced
 * by the one for the ledger's sum. A text without that exact sentence at its end (a row from
 * before run C, a row without a stored outcome) is shown as stored: the screen shows the
 * ledger's figure beside it. Nothing stored is rewritten.
 */
export function resultTextNow(
  text: string,
  outcome: Pick<LastSessionOutcome, "spentChfMicro"> | null | undefined,
  chfMicroNow: number,
): string {
  if (!outcome || typeof outcome.spentChfMicro !== "number") return text;
  const stored = costSentence(outcome.spentChfMicro);
  const now = costSentence(chfMicroNow);
  if (!stored || stored === now) return text;
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last === stored) lines[lines.length - 1] = now;
  else if (last.endsWith(` ${stored}`))
    lines[lines.length - 1] = `${last.slice(0, last.length - stored.length)}${now}`;
  else return text;
  return lines.join("\n");
}

/**
 * How long a session worked: from its start to its end, or, for a session a dead process left
 * (ended by the recovery or a later Stop), to the last thing it logged (`handoff.last_worked_at`):
 * the time Forerunner was closed is not the session's length. Null while it works.
 */
export function durationOf(
  row: Pick<SessionRow, "status" | "started_at" | "created_at" | "ended_at" | "handoff">,
): number | null {
  if (WORKING.has(row.status)) return null;
  const start = Date.parse(row.started_at ?? row.created_at);
  const lastWorked =
    row.handoff && typeof row.handoff === "object" && !Array.isArray(row.handoff)
      ? (row.handoff as { last_worked_at?: unknown }).last_worked_at
      : undefined;
  const end = Date.parse(
    typeof lastWorked === "string"
      ? lastWorked
      : (row.ended_at ?? row.started_at ?? row.created_at),
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// --- Working now ---------------------------------------------------------------------------------

/** The task a working session runs now, from its log (as `workingOn` reads it). */
async function workingOf(store: StateStore, row: SessionRow): Promise<ProjectWorking> {
  const agentName = (await store.agent.get(row.agent_id).catch(() => undefined))?.name ?? null;
  const last = (await store.event.list(row.id, 0, 10_000))
    .filter((e) => e.type === "task.started" || e.type === "task.finished")
    .at(-1);
  const payload = (last?.payload ?? {}) as { title?: unknown; taskId?: unknown };
  const running = last?.type === "task.started";
  return {
    sessionId: row.id,
    agentName,
    taskId: running && typeof payload.taskId === "string" ? payload.taskId : null,
    taskTitle: running && typeof payload.title === "string" ? payload.title : null,
    since: row.started_at ?? row.created_at,
  };
}

/**
 * What a working session does now, in the project status's own working sentence ('Working on
 * "Style the page" (3 of 7 done)', design §2), never a wording of its own; a planning call reads
 * "Drafting the plan…". d1109-run-visible (run C5) re-points this at its run view, so the
 * header, Home, the Overview and this list say what runs now in the same words.
 */
export async function workingWords(
  store: StateStore,
  row: SessionRow,
  tasks?: readonly TaskRow[],
): Promise<string> {
  if (isIntakeSession(row)) return planningGist({ state: "drafting" });
  const all =
    tasks ??
    (row.project_id
      ? await store.task.list({ project_id: row.project_id } as never, { limit: 2000 })
      : []);
  return projectStatusLine({
    projectId: row.project_id ?? "",
    tasks: all,
    displays: new Map(),
    cards: [],
    plan: "none",
    working: await workingOf(store, row),
    folder: null,
  }).text;
}

// --- The list --------------------------------------------------------------------------------

/** An opaque cursor: the last row's start and id, so a page goes on after a restart too. */
export function sessionsCursor(row: Pick<SessionRow, "created_at" | "id">): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}

const BAD_CURSOR = "This list cannot go on from there. Open Sessions again.";

export function decodeSessionsCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      typeof v[1] === "string" &&
      Number.isFinite(Date.parse(v[0])) &&
      /^[0-9A-Za-z_-]{1,64}$/.test(v[1])
    )
      return { createdAt: v[0], id: v[1] };
  } catch {
    // falls through to the refusal
  }
  throw new ForerunnerError("validation", BAD_CURSOR, { details: { reason: "bad_query" } });
}

export interface ProjectSessionsOptions {
  limit?: number;
  /** The `next` of the page before. */
  before?: string | null;
  chfPerUsd: number;
  /** The tasks a session left waiting that still wait now (the daemon's `stillBlocked`). */
  blockedNow?: (handoff: unknown) => Promise<EndedWaits>;
}

/** One row of the list (also the chat's recall of a session, d1109-chat-recall). */
export async function sessionRowView(
  store: StateStore,
  row: SessionRow,
  ctx: {
    spend?: SessionSpend;
    chfPerUsd: number;
    tasks?: readonly TaskRow[];
    cachedOutcome?: LastSessionOutcome | null;
    blockedNow?: (handoff: unknown) => Promise<EndedWaits>;
  },
): Promise<ProjectSessionRowView> {
  const working = WORKING.has(row.status);
  const planning = isIntakeSession(row);
  const spent = spentOf(ctx.spend, row, ctx.chfPerUsd);
  const record = planning || working ? null : await sessionRecord(store, row, ctx.cachedOutcome);
  const counts = record
    ? countsOf(record)
    : { done: 0, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 };
  const gist = working
    ? await workingWords(store, row, ctx.tasks)
    : planning
      ? planningGist(await planningFactsOf(store, row))
      : sessionGist(record as SessionRecord);
  const waits =
    !working && !planning && ctx.blockedNow ? await ctx.blockedNow(row.handoff) : undefined;
  return {
    id: row.id,
    startedAt: row.started_at ?? row.created_at,
    endedAt: working ? null : row.ended_at,
    durationMs: durationOf(row),
    working,
    planning,
    gist: withoutIds(gist),
    tasks: counts,
    countsWords: countsWords(counts),
    endedWords: sessionEndWords(row, waits),
    spent,
    spentWords: spentWords(
      { chfMicro: spent.chfMicro, kinds: ctx.spend?.kinds ?? [] },
      { working },
    ),
    startedBy: startedByWords(row),
  };
}

/**
 * `GET /projects/:id/sessions`: the project's sessions, the working ones on top (first page
 * only), then the ended ones newest first by start, `limit` a page (20, at most 50), `next` the
 * cursor of the page after it (null on the last). `count` is how many the list holds in all; the
 * view carries no total of money (the Costs tab is the one place for totals). Chat about the
 * project is one line of its own, when it cost anything.
 */
export async function projectSessionsView(
  store: StateStore,
  projectId: string,
  opts: ProjectSessionsOptions,
): Promise<ProjectSessionsView> {
  const project = await store.project.get(projectId);
  if (!project) throw new ForerunnerError("not_found", "No such project.");
  const limit = Math.max(1, Math.min(SESSIONS_PAGE_MAX, Math.floor(opts.limit ?? SESSIONS_PAGE)));
  const before = opts.before ? decodeSessionsCursor(opts.before) : undefined;
  const count = await store.session.listedCountForProject(projectId);
  const workingRows = before
    ? []
    : (
        await store.session.list(
          { project_id: projectId, status: ["planned", "running", "paused"] } as never,
          {
            orderBy: [
              { column: "created_at", direction: "desc" },
              { column: "id", direction: "desc" },
            ],
            limit: 20,
          },
        )
      ).filter((r) => r.summary !== "conversation");
  const page = await store.session.pageForProject(projectId, {
    limit: limit + 1,
    ended: true,
    ...(before ? { before } : {}),
  });
  const rows = page.slice(0, limit);
  const last = rows[rows.length - 1];
  const next = page.length > limit && last ? sessionsCursor(last) : null;
  const spends = await sessionSpends(
    store,
    [...workingRows, ...rows].map((r) => r.id),
  );
  const tasks = workingRows.length
    ? await store.task.list({ project_id: projectId } as never, { limit: 2000 })
    : undefined;
  const cache = (project.summary_cache ?? {}) as {
    last_session?: { id?: unknown; outcome?: LastSessionOutcome };
  };
  const cachedFor = (id: string) =>
    cache.last_session?.id === id ? (cache.last_session.outcome ?? null) : null;
  const view = (row: SessionRow) =>
    sessionRowView(store, row, {
      ...(spends.get(row.id) ? { spend: spends.get(row.id) as SessionSpend } : {}),
      chfPerUsd: opts.chfPerUsd,
      ...(tasks ? { tasks } : {}),
      cachedOutcome: cachedFor(row.id),
      ...(opts.blockedNow ? { blockedNow: opts.blockedNow } : {}),
    });
  const working: ProjectSessionRowView[] = [];
  for (const r of workingRows) working.push(await view(r));
  const ended: ProjectSessionRowView[] = [];
  for (const r of rows) ended.push(await view(r));
  const chatSpend = before ? null : await store.costLedger.chatSpendForProject(projectId);
  const chat =
    chatSpend && chatSpend.entries > 0 && chatSpend.chf_micro > 0
      ? {
          spent: { usdMicro: chatSpend.usd_micro, chfMicro: chatSpend.chf_micro },
          words: `Chat about this project: ${moneyWords(formatChf(chatSpend.chf_micro), chatSpend.chf_micro)}.`,
        }
      : null;
  return { projectId, count, working, rows: ended, next, chat };
}

// --- Tasks in this session -------------------------------------------------------------------

/** What happened to a task in this session, in words, and the display key that says the same. */
function hereOf(
  record: SessionRecord | null,
  taskId: string,
  runningId: string | null,
): { words: string; key: string | null } {
  if (runningId === taskId) return { words: "Running", key: "running" };
  if (!record) return { words: "Worked on", key: null };
  const has = (l: readonly NamedTask[]) => l.some((t) => t.id === taskId);
  if (has(record.done)) return { words: "Done", key: "done" };
  if (has(record.failed)) return { words: "Failed", key: "failed" };
  const paused = record.paused.find((t) => t.id === taskId);
  if (paused) return { words: `Paused at ${paused.limit}`, key: "answer" };
  if (has(record.needsYou)) return { words: "Needed your answer", key: "answer" };
  if (has(record.cancelled)) return { words: "Cancelled", key: "cancelled" };
  return { words: "Worked on", key: null };
}

/**
 * `GET /sessions/:id/tasks`: the tasks a session worked on, in the order it first ran them,
 * each with what happened to it here, what it is now when that differs ("now: Done"), and what
 * this session spent on it (the ledger's rows for the session and the task, reviews included).
 * A planning call worked on no task.
 */
export async function sessionTasksView(
  store: StateStore,
  sessionId: string,
): Promise<SessionTasksView> {
  const row = await store.session.mustGet(sessionId);
  if (isIntakeSession(row) || row.summary === "conversation")
    return { sessionId, projectId: row.project_id, tasks: [] };
  const runs = (await store.run.forSession(sessionId, { limit: 5000 })).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const order: string[] = [];
  for (const r of runs) if (r.task_id && !order.includes(r.task_id)) order.push(r.task_id);
  const working = WORKING.has(row.status);
  const outcome = outcomeOfHandoff(row.handoff);
  const record = working ? null : await sessionRecord(store, row, null);
  if (outcome)
    for (const t of [
      ...outcome.done,
      ...outcome.failed,
      ...(outcome.paused ?? []),
      ...outcome.needsYou,
      ...(outcome.cancelled ?? []),
    ])
      if (!order.includes(t.id)) order.push(t.id);
  const runningId = working ? (await workingOf(store, row)).taskId : null;
  const spendByTask = new Map(
    (await store.costLedger.breakdown("task_id", { sessionId })).map((b) => [b.key, b]),
  );
  const rows: TaskRow[] = [];
  for (const id of order) {
    const t = await store.task.get(id).catch(() => undefined);
    if (t) rows.push(t);
  }
  const projectTasks = row.project_id
    ? await store.task.list({ project_id: row.project_id } as never, { limit: 2000 })
    : rows;
  const ctx = await loadTaskDisplayContext(store, projectTasks, null);
  const tasks: SessionTaskView[] = rows.map((t) => {
    const here = hereOf(record, t.id, runningId);
    const display = taskDisplay(t, ctx);
    const b = spendByTask.get(t.id);
    const spent: Money = b
      ? { usdMicro: b.usd_micro, chfMicro: b.chf_micro }
      : { usdMicro: 0, chfMicro: 0 };
    return {
      id: t.id,
      title: t.title,
      projectId: t.project_id,
      here: here.words,
      now: here.key !== null && display.key === here.key ? null : display.label,
      spent,
      spentWords: moneyWords(formatChf(spent.chfMicro), spent.chfMicro),
    };
  });
  return { sessionId, projectId: row.project_id, tasks };
}
