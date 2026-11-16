import { createHash } from "node:crypto";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  JsonValue,
  ProjectRow,
  StateStore,
} from "@forerunner/state";
import type { CommandCallLike, FencedChange, FenceResult } from "./task-check.ts";
import type { TaskListNote } from "./task-list-notes.ts";

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

export const TASK_PROPOSAL_KEY = "task_proposal";
export const TASK_PROPOSAL_OPTIONS = ["Make these changes", "Keep the tasks"] as const;

/** One suggested change as the card lists it and as it is applied. */
export interface ProposedChange {
  /** The change in the person's words ('Split "Style the page" into "A" and "B".'). */
  line: string;
  calls: CommandCallLike[];
}

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
    case "edit":
      return c.title ? `Rename ${q(c.task)} to ${q(c.title)}.` : `Reword ${q(c.task)}.`;
  }
}

/** The card's fingerprint: the same set of changes asked twice is the same suggestion. */
function fingerprintOf(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** What showed the agent the changes, as the card's first sentence (data, quoted). */
export function proposalBody(notes: readonly TaskListNote[], quotes: readonly string[]): string {
  const cut = (s: string) => (s.length > 100 ? `${s.slice(0, 99).replace(/\s+\S*$/, "")}…` : s);
  const first = notes[0];
  const whose = first
    ? first.source === "review"
      ? `the critic's notes on "${first.taskTitle}"`
      : `the ${first.specialist ?? "specialist"}'s report on "${first.taskTitle}"`
    : "the agent's check";
  const why = quotes[0]
    ? `A line of ${whose} reads like an instruction: "${cut(quotes[0])}".`
    : (() => {
        const line = first?.lines.find((l) => !l.flagged)?.text;
        return line
          ? `${whose.charAt(0).toUpperCase()}${whose.slice(1)} says: "${cut(line)}".`
          : `${whose.charAt(0).toUpperCase()}${whose.slice(1)} found the task list needs changes.`;
      })();
  return `${why} Nothing changes until you say yes.`;
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
  for (const f of fence.changes)
    changes.push({ line: proposalLine(f), calls: await input.callsOf(f) });
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
  const quotes = fence.askFirst.map((a) => a.quote).filter((q): q is string => !!q);
  const reasons = fence.askFirst.filter((a) => !a.quote).map((a) => a.reason);
  const row = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: project.id,
    session_id: input.sessionId,
    kind: "decision",
    why: proposalBody(input.notes, quotes),
    steps: [...changes.map((c) => c.line), ...reasons.map((r) => `Asks you first: ${r}.`)],
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

/**
 * The answered suggestion cards, applied once (marked first, then applied): "Make these changes"
 * re-checks each change on the state now, leaves out and names what no longer applies, and
 * applies the rest as one change; "Keep the tasks" changes nothing. Survives a restart: the
 * calls are on the card.
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
    const card = (row.change_card ?? {}) as JsonObject;
    if (card.key !== TASK_PROPOSAL_KEY || card.outcome !== undefined) continue;
    // Marked first, so a second sync never applies the set twice.
    let marked: HumanRequestRow;
    try {
      marked = await store.humanRequest.patch(row.id, {
        change_card: { ...card, outcome: "applying" },
      });
    } catch {
      continue;
    }
    const answer = answerOf(row);
    if (answer !== TASK_PROPOSAL_OPTIONS[0]) {
      await store.humanRequest.patch(marked.id, {
        change_card: { ...card, outcome: "kept" },
      });
      out.kept++;
      continue;
    }
    const projectId = typeof card.project_id === "string" ? card.project_id : row.project_id;
    const changes = Array.isArray(card.changes)
      ? (card.changes as unknown as ProposedChange[])
      : [];
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
      out.failed++;
      continue;
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
    out.applied++;
  }
  return out;
}

/**
 * The card's Done line (design §3.8: what happens next): 'Changed 3 tasks; the session takes them
 * if they fit.' while a session runs, 'Changed 3 tasks; your next Start runs them.' with none; a
 * change that no longer applied is named; Keep says nothing changed; a replaced card says so.
 */
export function proposalOutcome(card: JsonObject): string | null {
  if (card.replaced === true) return "A newer suggestion of the agent replaced this one.";
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const left = Array.isArray(card.left_out)
    ? card.left_out.filter((x): x is string => typeof x === "string")
    : [];
  const leftWords = left.length
    ? ` Left out: ${left[0]}${left.length > 1 ? ` and ${left.length - 1} more` : ""}.`
    : "";
  switch (card.outcome) {
    case "kept":
      return "Kept the tasks as they are; nothing changed.";
    case "applied": {
      const n = typeof card.changed === "number" ? card.changed : 0;
      const next =
        card.running === true ? "the session takes them if they fit" : "your next Start runs them";
      return `Changed ${n} ${plural(n, "task", "tasks")}; ${next}.${leftWords}`;
    }
    case "not_applied":
      return `Nothing changed: none of the changes applies now.${leftWords}`;
    case "applying":
      return "Making the changes…";
    default:
      return null;
  }
}
