import { createHash } from "node:crypto";
import { saidByName } from "@forerunner/critic";
import { type Clock, errorMessage, isForerunnerError, log } from "@forerunner/platform";
import type {
  ChangeLogRow,
  HumanRequestRow,
  JsonObject,
  JsonValue,
  ProjectRow,
  StateStore,
} from "@forerunner/state";
import {
  proposalOutcome,
  TASK_PROPOSAL_KEY,
  TASK_PROPOSAL_OPTIONS,
} from "../daemon/task-proposal-words.ts";
import { PRIORITY_LABELS } from "../priority.ts";
import type { CheckQuote, CommandCallLike, FencedChange, FenceResult } from "./task-check.ts";
import { quoteFor, quoteOf, type TaskListNote } from "./task-list-notes.ts";

/**
 * d1109-selftasks-run (ADR 0119 point 7; the owner, 2026-11-09: the agent changes its own tasks,
 * "the autonomy level deciding when it asks first"; at Advisor and Assisted it asks first on one
 * card): the agent's suggested changes to its task list as ONE Inbox card per project, filed
 * without stopping the session. "Make these changes" applies the set as the person (the answer is
 * the confirmation) as one change log row with one Undo, each change checked again on the state
 * now; "Keep the tasks" changes nothing and the same suggestion is not filed again that session.
 * A newer suggestion replaces an older unanswered one. No answer starts a session: the approved
 * tasks join the running session by the admit rule, else they wait for the person's next Start.
 */

const logger = log("task-proposal");

export { proposalOutcome, TASK_PROPOSAL_KEY, TASK_PROPOSAL_OPTIONS };

/** One suggested change as the card lists it and as it is applied. */
export interface ProposedChange {
  /** The change in the person's words ('Split "Style the page" into "A" and "B".'). */
  line: string;
  calls: CommandCallLike[];
}

/** The longest new outcome or criteria an edit's line quotes. */
const EDIT_QUOTE_MAX = 120;

/** A suggested change in the person's words (the card's list; the same words the commands say). */
export function proposalLine(f: FencedChange): string {
  const c = f.change;
  const q = (t: string) => `"${t.trim()}"`;
  const list = (ts: readonly string[]) => {
    const qs = ts.map(q);
    return qs.length <= 1 ? qs.join("") : `${qs.slice(0, -1).join(", ")} and ${qs.at(-1)}`;
  };
  switch (c.kind) {
    case "split":
      return `Split ${q(c.task)} into ${list(c.parts.map((p) => p.title))}.`;
    case "add":
      return c.before.length ? `Add ${q(c.title)} before ${list(c.before)}.` : `Add ${q(c.title)}.`;
    case "drop":
      return `Drop ${q(c.task)}: same as ${q(c.sameAs)}.`;
    case "order":
      return c.waitsFor.length
        ? `Make ${q(c.task)} wait for ${list(c.waitsFor)}.`
        : `Let ${q(c.task)} run without waiting for another task.`;
    case "edit": {
      // What the edit changes, as task.update's own read-back says it ('priority to High'); a new
      // title alone is a rename. Before, any edit without a new title read 'Reword "X".', so a Yes
      // to a "reword" changed a priority (review of d1109-selftasks-chat; design section 3.9 and
      // section 5 rules 4 and 9). Chat's read-back and the suggestion card both list these words.
      // l4-selftasks-112 (d): to what, cut at a word (before, 'what done looks like and the
      // criteria.', and the person said yes without seeing the new words).
      const said = (t: string, max: number) => `"${quoteOf(t, max)}"`;
      const parts: string[] = [];
      if (c.title) parts.push(`the title to ${q(c.title)}`);
      if (c.outcome) parts.push(`what done looks like to ${said(c.outcome, EDIT_QUOTE_MAX)}`);
      if (c.acceptanceCriteria)
        parts.push(`the criteria to ${said(c.acceptanceCriteria.join("; "), EDIT_QUOTE_MAX)}`);
      if (c.priority) parts.push(`priority to ${PRIORITY_LABELS[c.priority]}`);
      if (c.title && parts.length === 1) return `Rename ${q(c.task)} to ${q(c.title)}.`;
      if (!parts.length) return `Change ${q(c.task)}.`;
      const what =
        parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
      return `Change ${q(c.task)}: ${what}.`;
    }
  }
}

/** The card's fingerprint: the same set of changes asked twice is the same suggestion. */
function fingerprintOf(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * What showed the agent the changes, as the card's first sentence (data, quoted). A quote is
 * named by who wrote it (l4-selftasks-112 (d)): a line of a report, a note of the critic's, or
 * the agent's check's own entry, never "a line of the coder's report" for the model's words; it
 * shows the line's request (`requestPart`), cut at a word.
 * fixup-l4-selftasks-chat (L4-selftasks-129): why the set asks first ("Asks you first: ...") is
 * said here, before "Nothing changes until you say yes."; before, it was a bullet of the card's
 * change list, read as one more change.
 */
export function proposalBody(
  notes: readonly TaskListNote[],
  quotes: readonly CheckQuote[],
  reasons: readonly string[] = [],
): string {
  const cut = (s: string) => (s.length > 100 ? `${s.slice(0, 99).replace(/\s+\S*$/, "")}…` : s);
  // Quoted once: the line's own double quotes become single ones and its end mark goes, so the
  // card reads 'says: "'Style the page' is two jobs".' and never '""Style…".".'.
  const quoted = (s: string) =>
    `"${cut(
      s
        .trim()
        .replace(/"/g, "'")
        .replace(/[.;:,!]+$/, ""),
    )}"`;
  const first = notes[0];
  // l4-selftasks-111: a specialist as a person names it ("the writer's report"), and the
  // critic's notes "say" (before: 'The critic's notes on "X" says:').
  const by = (s: string | null | undefined) => saidByName(s) ?? "specialist";
  const whose = first
    ? first.source === "review"
      ? `the critic's notes on "${first.taskTitle}"`
      : `the ${by(first.specialist)}'s report on "${first.taskTitle}"`
    : "the agent's check";
  const says = first?.source === "review" ? "say" : "says";
  const said = quotes[0];
  const why = said
    ? said.by === "agent"
      ? `The agent's check noted: "${quoteFor(said)}".`
      : said.source === "review"
        ? `A note of the critic's on "${said.taskTitle ?? first?.taskTitle ?? ""}" names an instruction: "${quoteFor(said)}".`
        : `A line of the ${by(said.specialist ?? first?.specialist)}'s report on "${said.taskTitle ?? first?.taskTitle ?? ""}" reads like an instruction: "${quoteFor(said)}".`
    : (() => {
        const line = first?.lines.find((l) => !l.flagged)?.text;
        return line
          ? `${whose.charAt(0).toUpperCase()}${whose.slice(1)} ${says}: ${quoted(line)}.`
          : `${whose.charAt(0).toUpperCase()}${whose.slice(1)} found the task list needs changes.`;
      })();
  const asks = reasons.map((r) => ` Asks you first: ${r.trim().replace(/[.\s]+$/, "")}.`).join("");
  return `${why}${asks} Nothing changes until you say yes.`;
}

export interface FileProposalInput {
  project: ProjectRow;
  sessionId: string | null;
  agentId: string;
  humanId: string;
  fence: FenceResult;
  notes: readonly TaskListNote[];
  /** Each fenced change as its registry calls (`callsOf`). */
  callsOf(f: FencedChange): Promise<CommandCallLike[]>;
}

/** The project's open suggestion cards (one at most, unless an older one is being replaced). */
async function openProposals(store: StateStore, projectId: string): Promise<HumanRequestRow[]> {
  const open = await store.humanRequest.list({ status: "open", project_id: projectId } as never, {
    limit: 200,
  });
  return open.filter((r) => (r.change_card as { key?: unknown } | null)?.key === TASK_PROPOSAL_KEY);
}

/**
 * File the set as one suggestion card (ADR 0119 point 7): its title names the project and the
 * count, its body what showed it, its steps the changes (and why it asks first), its options
 * "Make these changes" and "Keep the tasks". Null when the person kept the same suggestion
 * earlier in this session, or when there is nothing to suggest.
 */
export async function fileTaskProposal(
  store: StateStore,
  input: FileProposalInput,
): Promise<string | null> {
  const { project, fence } = input;
  if (!fence.changes.length) return null;
  const changes: ProposedChange[] = [];
  for (const f of fence.changes) {
    const calls = await input.callsOf(f);
    // l4-selftasks-105: a change with no call (an edit that changes nothing) is not listed.
    if (calls.length) changes.push({ line: proposalLine(f), calls });
  }
  if (!changes.length) return null;
  const fingerprint = fingerprintOf(changes.map((c) => c.line));
  if (input.sessionId) {
    const answered = await store.humanRequest.list(
      { status: "answered", project_id: project.id, session_id: input.sessionId } as never,
      { limit: 200 },
    );
    const kept = answered.some((r) => {
      const card = r.change_card as { key?: unknown; fingerprint?: unknown } | null;
      return (
        card?.key === TASK_PROPOSAL_KEY &&
        card.fingerprint === fingerprint &&
        answerOf(r) === TASK_PROPOSAL_OPTIONS[1]
      );
    });
    if (kept) return null;
  }
  // One open suggestion per project: a newer one replaces an older unanswered one.
  let replaced = 0;
  for (const old of await openProposals(store, project.id)) {
    try {
      const marked = await store.humanRequest.patch(old.id, {
        change_card: { ...(old.change_card as JsonObject), replaced: true },
      });
      await store.humanRequest.withdraw(marked.id, marked.version);
      replaced++;
    } catch (e) {
      logger.warn("an older suggestion was not withdrawn", { id: old.id, error: errorMessage(e) });
    }
  }
  // l4-selftasks-112 (d): the quotes as the fence names them (who wrote each), not the ask-first
  // reasons' bare strings; the card keeps their words (`change_card.quotes`).
  const quotes = fence.quotes.map((q) => q.text);
  const reasons = fence.askFirst.filter((a) => !a.quote).map((a) => a.reason);
  const row = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: project.id,
    session_id: input.sessionId,
    kind: "decision",
    why: proposalBody(input.notes, fence.quotes, reasons),
    steps: changes.map((c) => c.line),
    options: [...TASK_PROPOSAL_OPTIONS],
    blocking: false,
    risk: "low",
    change_card: {
      key: TASK_PROPOSAL_KEY,
      project_id: project.id,
      session_id: input.sessionId,
      fingerprint,
      changes: changes as unknown as JsonValue,
      quotes,
      reasons,
      ...(replaced ? { replaces: replaced } : {}),
    },
    author_agent: input.agentId,
  });
  return row.id;
}

/** The answer of a card as its option. */
function answerOf(r: Pick<HumanRequestRow, "answer">): string | null {
  const a = r.answer as unknown;
  if (typeof a === "string") return a;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    for (const k of ["option", "choice", "answer", "text"])
      if (typeof o[k] === "string") return o[k] as string;
  }
  return null;
}

/** How a card's approved set is applied (compose wires the command executor and the admit rule). */
export interface ProposalSyncDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** Whether one change still applies on the state now (the commands' own plan); why not. */
  check(calls: readonly CommandCallLike[]): Promise<string | null>;
  /**
   * The approved changes as ONE composed change as the person (the answer is the confirmation):
   * one change log row, one Undo. Answers its id, or the refusal in words.
   */
  apply(
    calls: readonly CommandCallLike[],
    ctx: { projectId: string; requestId: string },
  ): Promise<{ changeLogId: string } | { refused: string }>;
  /**
   * The approved new tasks join the project's running session by the admit rule (the person's
   * preparation, ADR 0119 point 8); true when a session of the project runs. Nothing starts.
   */
  admit(projectId: string, taskIds: readonly string[]): Promise<boolean>;
}

/** The cards this process is applying now (ids are unique across stores). */
const applyingNow = new Set<string>();

/** Whether a stored command is the card's call: the same command, and every param it gave. */
function sameCall(stored: JsonValue, call: CommandCallLike): boolean {
  const s = (stored ?? {}) as { name?: unknown; params?: unknown };
  if (s.name !== call.name) return false;
  const have = (s.params ?? {}) as Record<string, unknown>;
  const want = (call.params ?? {}) as Record<string, unknown>;
  return Object.keys(want).every(
    (k) => !(k in have) || JSON.stringify(have[k]) === JSON.stringify(want[k]),
  );
}

/** The tasks a change log row made (task.create's task, task.split's new parts). */
function madeBy(row: ChangeLogRow): string[] {
  const afters = Array.isArray(row.after) ? row.after : [row.after];
  const out: string[] = [];
  for (const [i, cmd] of row.commands.entries()) {
    const name = (cmd as { name?: unknown } | null)?.name;
    const after = (afters[i] ?? {}) as { task_id?: unknown; parts?: unknown };
    if (name === "task.create" && typeof after.task_id === "string") out.push(after.task_id);
    if (name === "task.split" && Array.isArray(after.parts))
      for (const p of after.parts) {
        const id = (p as { task_id?: unknown } | null)?.task_id;
        if (typeof id === "string") out.push(id);
      }
  }
  return out;
}

/**
 * l4-chat-carried (C4-left-7, ADR 0119 dated note 2026-11-23): the change log row a card left at
 * 'applying' already made, when the crash came after the apply and before the outcome was
 * written: the person's row in the card's project, made since the card was marked, whose commands
 * are the card's calls in their order. Undefined when the apply never ran.
 */
async function changeOfCard(
  store: StateStore,
  row: HumanRequestRow,
  card: JsonObject,
  projectId: string,
): Promise<ChangeLogRow | undefined> {
  const since =
    typeof card.applying_at === "string" ? card.applying_at : (row.answered_at ?? row.updated_at);
  const calls = (Array.isArray(card.changes) ? (card.changes as unknown as ProposedChange[]) : [])
    .flatMap((c) => c.calls ?? [])
    .filter((c) => c && typeof c.name === "string");
  if (!calls.length) return undefined;
  const rows = await store.changeLog.forProject(projectId, { limit: 200 });
  return rows.find((r) => {
    if (r.created_at < since || r.human_id !== row.human_id || r.source !== "ui") return false;
    if (!r.commands.length) return false;
    // The stored commands are a part of the card's calls, in order (a change that no longer
    // applied was left out of the apply).
    let at = 0;
    for (const cmd of r.commands) {
      while (at < calls.length && !sameCall(cmd, calls[at] as CommandCallLike)) at++;
      if (at >= calls.length) return false;
      at++;
    }
    return true;
  });
}

/**
 * The answered suggestion cards, applied once (marked first, then applied): "Make these changes"
 * re-checks each change on the state now, leaves out and names what no longer applies, and
 * applies the rest as one change; "Keep the tasks" changes nothing. Survives a restart: the
 * calls are on the card. A card a crash left at 'applying' (l4-chat-carried, C4-left-7) is
 * settled at the next sync: its change, when the apply had run, is found and named; otherwise
 * it is applied now, once. It never stays at "Making the changes…".
 */
export async function syncTaskProposals(
  deps: ProposalSyncDeps,
): Promise<{ applied: number; kept: number; failed: number }> {
  const { store } = deps;
  const out = { applied: 0, kept: 0, failed: 0 };
  const answered = await store.humanRequest.list(
    { status: "answered", human_id: deps.humanId } as never,
    {
      limit: 500,
    },
  );
  for (const row of answered) {
    const stored = (row.change_card ?? {}) as JsonObject;
    if (stored.key !== TASK_PROPOSAL_KEY) continue;
    const leftApplying = stored.outcome === "applying";
    if (stored.outcome !== undefined && !leftApplying) continue;
    // A card this process applies right now is no leftover of a crash.
    if (applyingNow.has(row.id)) continue;
    applyingNow.add(row.id);
    try {
      const settled = await settleProposal(deps, row, stored, leftApplying);
      if (settled !== "skipped") out[settled]++;
    } catch (e) {
      logger.warn("a suggestion card was not settled", { id: row.id, error: errorMessage(e) });
    } finally {
      applyingNow.delete(row.id);
    }
  }
  return out;
}

/** One answered card, marked and then applied (or found applied, after a crash). */
async function settleProposal(
  deps: ProposalSyncDeps,
  row: HumanRequestRow,
  stored: JsonObject,
  leftApplying: boolean,
): Promise<"applied" | "kept" | "failed" | "skipped"> {
  const { store } = deps;
  const { outcome: _left, applying_at: _at, ...card } = stored;
  const projectId = typeof card.project_id === "string" ? card.project_id : row.project_id;
  // Marked first, so a second sync never applies the set twice; the mark's time tells a later
  // start which change the apply made, when a crash comes between the two. l4-chat-final
  // (L4h-left-5): the mark is a compare-and-set on the card as this sync read it (its version); a
  // card a crash left at 'applying' is marked again unchanged, the same way. A card another sync
  // settled or marked since is left to it. Before, a second sync that read the card as 'applying'
  // while the first applied it took it for a crash's leftover and settled it again: a set the
  // first could not make was tried a second time.
  let marked: HumanRequestRow;
  try {
    marked = await store.humanRequest.update(row.id, row.version, {
      change_card: leftApplying
        ? stored
        : { ...card, outcome: "applying", applying_at: deps.clock.nowIso() },
    });
  } catch (e) {
    if (isForerunnerError(e, "version_conflict")) return "skipped";
    throw e;
  }
  const answer = answerOf(row);
  if (leftApplying && answer === TASK_PROPOSAL_OPTIONS[0] && projectId) {
    const made = await changeOfCard(store, row, stored, projectId);
    if (made) {
      const changes = Array.isArray(card.changes)
        ? (card.changes as unknown as ProposedChange[])
        : [];
      const madeIt = (c: ProposedChange) =>
        (c.calls ?? []).every((call) => made.commands.some((cmd) => sameCall(cmd, call)));
      const applies = changes.filter(madeIt);
      // l4-chat-final (L4h-left-5): the changes the apply left out are named as the first apply
      // names them, with why they do not apply now; and the tasks the made changes touched join
      // a running session by the admit rule, as after the first apply (before: only the tasks
      // the change made, and the left-out changes went unsaid).
      const leftOut: string[] = [];
      for (const c of changes.filter((x) => !madeIt(x))) {
        const why = await deps.check(c.calls).catch((e: unknown) => errorMessage(e));
        leftOut.push(`${c.line.replace(/\.$/, "")}: ${why ?? "it was left out of the changes"}`);
      }
      const ids = madeBy(made);
      const touched = applies
        .flatMap((c) => c.calls)
        .map((c) => (c.params as { task?: unknown } | null)?.task)
        .filter((t): t is string => typeof t === "string");
      const running = await deps.admit(projectId, [...ids, ...touched]).catch(() => false);
      await store.humanRequest.patch(marked.id, {
        change_card: {
          ...card,
          outcome: "applied",
          changed: applies.length,
          change_log_id: made.id,
          approved_task_ids: ids,
          running,
          ...(leftOut.length ? { left_out: leftOut } : {}),
        },
      });
      return "applied";
    }
  }
  return applyMarked(deps, row, marked, card, projectId);
}

/** The marked card applied: each change checked on the state now, the rest as one change. */
async function applyMarked(
  deps: ProposalSyncDeps,
  row: HumanRequestRow,
  marked: HumanRequestRow,
  card: JsonObject,
  projectId: string | null,
): Promise<"applied" | "kept" | "failed"> {
  const { store } = deps;
  if (answerOf(row) !== TASK_PROPOSAL_OPTIONS[0]) {
    await store.humanRequest.patch(marked.id, {
      change_card: { ...card, outcome: "kept" },
    });
    return "kept";
  }
  const changes = Array.isArray(card.changes) ? (card.changes as unknown as ProposedChange[]) : [];
  const calls: CommandCallLike[] = [];
  const leftOut: string[] = [];
  let applies = 0;
  for (const c of changes) {
    const why = await deps.check(c.calls).catch((e: unknown) => errorMessage(e));
    if (why) {
      leftOut.push(`${c.line.replace(/\.$/, "")}: ${why}`);
      continue;
    }
    calls.push(...c.calls);
    applies++;
  }
  const before = projectId
    ? new Set((await store.task.forProject(projectId, {}, { limit: 10_000 })).map((t) => t.id))
    : new Set<string>();
  let result: { changeLogId: string } | { refused: string } = { refused: "nothing to change" };
  if (calls.length && projectId)
    result = await deps.apply(calls, { projectId, requestId: row.id }).catch((e: unknown) => ({
      refused: errorMessage(e),
    }));
  if ("refused" in result) {
    await store.humanRequest.patch(marked.id, {
      change_card: {
        ...card,
        outcome: "not_applied",
        left_out: [...leftOut, ...(calls.length ? [result.refused] : [])],
      },
    });
    return "failed";
  }
  const made = projectId
    ? (await store.task.forProject(projectId, {}, { limit: 10_000 }))
        .filter((t) => !before.has(t.id))
        .map((t) => t.id)
    : [];
  const touched = changes
    .flatMap((c) => c.calls)
    .map((c) => (c.params as { task?: unknown } | null)?.task)
    .filter((t): t is string => typeof t === "string");
  const running = projectId
    ? await deps.admit(projectId, [...made, ...touched]).catch(() => false)
    : false;
  await store.humanRequest.patch(marked.id, {
    change_card: {
      ...card,
      outcome: "applied",
      changed: applies,
      change_log_id: result.changeLogId,
      approved_task_ids: made,
      running,
      ...(leftOut.length ? { left_out: leftOut } : {}),
    },
  });
  return "applied";
}
