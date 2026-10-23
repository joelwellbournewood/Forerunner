import {
  type ConsolidationReport,
  consolidate,
  createMemory,
  type Embedder,
  exportRow,
  grantFor,
  type LessonFiles,
  lintLesson,
  type MemoryContext,
  type MemoryScope,
  MemoryService,
  rowToDoc,
  SCOPE_ORDER,
  vectorToJson,
} from "@forerunner/memory";
import { type Clock, errorMessage, ForerunnerError, join, log } from "@forerunner/platform";
import {
  type HumanRequestRow,
  type JsonObject,
  type JsonValue,
  type LessonRow,
  type LessonStatus,
  openStore,
  parseStoreUrl,
  type StateStore,
} from "@forerunner/state";
import { WEEK_MINUTES } from "../models/watch.ts";
import { screenLessons } from "../session/lessons.ts";
import type { Schedule, Scheduler, StartRequest } from "../session/triggers.ts";
import { isYes } from "../wiring/state-ports.ts";
import type {
  MemoryPort,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecordRequest,
  MemoryRecordResult,
} from "./ports.ts";

/**
 * Memory in the loop (spec G, phase 4). The session runner, the task executor and the critic
 * loop reach `@forerunner/memory` only through this class:
 *
 * - `recall` loads the lessons an agent may read (its scope grant is issued in code from its
 *   kind: a principal gets its own private scope plus shared, the critic gets critic plus
 *   shared, a specialist nothing) under a hard token budget; a block over the budget is never
 *   returned (ADR 0036);
 * - `record` stores what a session learned (lessons the specialists spelled out, critic
 *   findings resolved, the human's decisions) in the agent's private memory, or in critic
 *   memory when the critic proposes a repeat finding;
 * - the weekly consolidation runs on the scheduler: a report-only run files one approval
 *   request with the proposals; the answer in the inbox applies them (`syncApprovals`);
 * - the memory views (spec K.5): list and search per scope, edit, delete, pin.
 */
export interface MemoryLoopDeps {
  store: StateStore;
  /**
   * The local private index next to a shared state (ADR 0002, ADR 0083): `agent_private` rows
   * are written to and read from it only. `openPrivateIndex` opens it; a `sqlite:` state in
   * solo mode holds every scope itself and passes none.
   */
  privateStore?: Pick<StateStore, "lesson">;
  clock: Clock;
  /** Memory root (`<data>/memory`); default from `appDirs()`. */
  root?: string;
  files?: LessonFiles;
  embedder?: Embedder;
  /** The human whose inbox receives consolidation proposals. */
  humanId: string;
  /** Consolidation thresholds; defaults from the memory package (ADR 0027). */
  consolidation?: {
    duplicateThreshold?: number;
    contradictionMin?: number;
    unusedAfterDays?: number;
    staleAfterDays?: number;
  };
}

/** `change_card.key` of a consolidation approval request. */
export const CONSOLIDATION_KEY = "memory:consolidation";
/** The scheduler entry for the weekly job (a sentinel agent id, like the model watch). */
export const MEMORY_CONSOLIDATION_AGENT_ID = "memory-consolidation";
export const MEMORY_CONSOLIDATION_SCHEDULE_ID = "memory:consolidation";
export const CONSOLIDATION_OPTIONS = ["apply", "skip"] as const;

export interface LessonQuery {
  scope: MemoryScope;
  /** Required for `agent_private`: whose private memory. */
  ownerAgentId?: string;
  projectId?: string | null;
  /** Case-insensitive substring of the text. */
  text?: string;
  tags?: string[];
  status?: LessonStatus;
  limit?: number;
}

export interface LessonPatch {
  text?: string;
  tags?: string[];
  confidence?: number;
  pinned?: boolean;
}

export interface ConsolidationProposal {
  requestId: string;
  status: HumanRequestRow["status"];
  createdAt: string;
  reports: ConsolidationReport[];
  proposals: string[];
  appliedAt: string | null;
  answer: JsonValue | null;
}

export interface ConsolidationRun {
  /** The approval request filed (or reused) for the proposals; null when nothing is proposed. */
  requestId: string | null;
  reports: ConsolidationReport[];
  proposals: number;
}

export function scheduleMemoryConsolidation(
  scheduler: Scheduler,
  opts: { timezone?: string; everyMinutes?: number; enabled?: boolean } = {},
): Schedule {
  const schedule: Schedule = {
    id: MEMORY_CONSOLIDATION_SCHEDULE_ID,
    agentId: MEMORY_CONSOLIDATION_AGENT_ID,
    kind: "every",
    everyMinutes: opts.everyMinutes ?? WEEK_MINUTES,
    timezone: opts.timezone ?? "UTC",
    enabled: opts.enabled ?? true,
  };
  scheduler.add(schedule);
  return schedule;
}

export function isMemoryConsolidationRequest(req: StartRequest): boolean {
  return req.agentId === MEMORY_CONSOLIDATION_AGENT_ID && req.trigger === "schedule";
}

/** File name of the private index under the memory root. */
export const PRIVATE_INDEX_FILE = "private.sqlite";

/**
 * Where this install's private memory index lives for a state URL: null for a `sqlite:` state
 * (solo mode: the one local store holds every scope), `<data>/memory/private.sqlite` for a
 * shared state (Postgres through the state service in paired and hybrid mode), which never
 * holds a private row (ADR 0002; `LessonRepo` refuses one on the Postgres dialect).
 */
export function privateIndexUrl(stateUrl: string, dirs: { data: string }): string | null {
  if (parseStoreUrl(stateUrl).dialect === "sqlite") return null;
  return `sqlite:${join(dirs.data, "memory", PRIVATE_INDEX_FILE)}`;
}

/**
 * Open the private index: the state schema at the same migration version (one `lesson` table
 * in use), foreign keys off because the agents and projects its rows name live in the shared
 * store. The caller closes it with the state store.
 */
export async function openPrivateIndex(url: string, clock: Clock): Promise<StateStore> {
  if (parseStoreUrl(url).dialect !== "sqlite") {
    throw new ForerunnerError(
      "MEMORY_SCOPE_VIOLATION",
      "the private index must be a sqlite: store",
      {
        details: { url: url.replace(/\/\/[^@]*@/, "//[REDACTED]@") },
      },
    );
  }
  return openStore({ url, clock, sqlite: { foreignKeys: false } });
}

export class MemoryLoop implements MemoryPort {
  private readonly logger = log("memory-loop");
  readonly ctx: MemoryContext;
  readonly service: MemoryService;

  constructor(private readonly deps: MemoryLoopDeps) {
    this.ctx = createMemory({
      store: { lesson: deps.store.lesson, review: deps.store.review, clock: deps.clock },
      ...(deps.privateStore ? { privateStore: { lesson: deps.privateStore.lesson } } : {}),
      root: deps.root,
      files: deps.files,
      embedder: deps.embedder,
      clock: deps.clock,
    });
    this.service = new MemoryService(this.ctx);
  }

  get files(): LessonFiles {
    return this.ctx.files;
  }

  // -------------------------------------------------------------------------------------
  // The port the runner and the executor use

  async recall(req: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const grant = grantFor(req.kind, req.agentId);
    const empty: MemoryRecallResult = {
      block: "",
      tokens: 0,
      lessonIds: [],
      denied: [],
      warnings: [],
    };
    if (grant.scopes.length === 0 || req.maxTokens <= 0) return empty;
    let loaded: Awaited<ReturnType<MemoryService["recallForSession"]>>;
    try {
      loaded = await this.service.recallForSession({
        grant,
        projectId: req.projectId,
        brief: req.query,
        tags: req.tags ?? [],
        maxTokens: req.maxTokens,
      });
    } catch (e) {
      // The agent's standing notes alone do not fit: nothing is loaded, the warning is shown.
      if (e instanceof ForerunnerError && e.code === "budget_exceeded")
        return { ...empty, warnings: [e.message] };
      throw e;
    }
    const warnings = [
      ...loaded.result.touchFailures.map(
        (t) => `touch failed for ${t.id} (${t.stage}): ${t.error}`,
      ),
      ...loaded.result.excluded.map((x) => `lesson ${x.id} excluded: ${x.reason}`),
    ];
    // The budget is a hard limit (phase 4 gate): a block over it is dropped, never sent.
    if (loaded.tokens > req.maxTokens) {
      return {
        ...empty,
        warnings: [
          ...warnings,
          `memory block of ${loaded.tokens} tokens exceeds the budget of ${req.maxTokens}; dropped`,
        ],
      };
    }
    return {
      block: loaded.block,
      tokens: loaded.tokens,
      lessonIds: loaded.result.lessons.map((l) => l.lesson.id),
      denied: loaded.result.denied.map((d) => d.scope),
      warnings,
    };
  }

  async record(req: MemoryRecordRequest): Promise<MemoryRecordResult> {
    if (req.lessons.length === 0) return { recorded: 0, merged: 0, rejected: [] };
    // The injection gate (AGENTS.md): a candidate that reads like an instruction never reaches
    // the store, whoever proposed it; the caller reports and quotes it to the human.
    const screened = screenLessons(req.lessons, "agent_output");
    const rejected: MemoryRecordResult["rejected"] = screened.rejected.map((r) => ({
      text: r.text,
      error: r.error,
      injection: r.rules,
    }));
    if (screened.kept.length === 0) return { recorded: 0, merged: 0, rejected };
    const out = await this.service.rememberFromSession({
      agentId: req.agentId,
      sessionId: req.sessionId,
      projectId: req.projectId,
      scope: req.scope ?? "agent_private",
      lessons: screened.kept,
      authorHuman: req.authorHuman ?? null,
    });
    return {
      recorded: out.recorded.length,
      merged: out.recorded.filter((r) => r.action === "merged").length,
      rejected: [...rejected, ...out.rejected],
    };
  }

  // -------------------------------------------------------------------------------------
  // Memory views (spec K.5): per scope, search, edit, delete, pin

  async list(q: LessonQuery): Promise<LessonRow[]> {
    if (q.scope === "agent_private" && !q.ownerAgentId)
      throw new ForerunnerError("validation", "a private memory view needs the owning agent", {
        details: { scope: q.scope },
      });
    if (q.scope === "agent_private" && q.ownerAgentId) await this.assertOwnAgent(q.ownerAgentId);
    return this.ctx.repo.search({
      scope: q.scope,
      ...(q.ownerAgentId ? { ownerAgentId: q.ownerAgentId } : {}),
      ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
      ...(q.text ? { text: q.text } : {}),
      ...(q.tags?.length ? { tags: q.tags } : {}),
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit ?? 200,
    });
  }

  /** Edit a lesson's text, tags, confidence or pin; the file is rewritten from the row. */
  async edit(
    id: string,
    patch: LessonPatch,
    by: { humanId?: string | null; agentId?: string | null } = {},
  ): Promise<LessonRow> {
    const row = await this.ownLesson(id);
    const next: LessonRow = {
      ...row,
      ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    };
    const problems = lintLesson(rowToDoc(next));
    if (problems.length)
      throw new ForerunnerError("validation", `lesson ${id}: ${problems.join("; ")}`, {
        details: { id, problems },
      });
    const changes: Partial<LessonRow> = {};
    if (patch.text !== undefined) changes.text = next.text;
    if (patch.tags !== undefined) changes.tags = next.tags;
    if (patch.confidence !== undefined) changes.confidence = next.confidence;
    if (patch.pinned !== undefined) changes.pinned = next.pinned;
    if (patch.text !== undefined)
      changes.embedding = vectorToJson(this.ctx.embedder.embed(next.text));
    if (by.humanId !== undefined) changes.author_human = by.humanId;
    if (by.agentId !== undefined) changes.author_agent = by.agentId;
    const updated = await this.ctx.repo.update(id, row.version, changes);
    await this.exportQuietly(updated);
    return updated;
  }

  async pin(id: string, pinned: boolean): Promise<LessonRow> {
    const row = await this.ownLesson(id);
    const updated = await this.ctx.repo.setPinned(id, row.version, pinned);
    await this.exportQuietly(updated);
    return updated;
  }

  /** Delete from the human's point of view: the row is retired and its file removed. */
  async remove(id: string): Promise<LessonRow> {
    const row = await this.ownLesson(id);
    const retired = row.status === "retired" ? row : await this.ctx.repo.retire(id, row.version);
    const path = this.ctx.files.pathFor(row.scope, row.owner_agent_id, row.id);
    try {
      await this.ctx.files.remove(path);
    } catch (e) {
      this.logger.warn("lesson file not removed", { id, error: errorMessage(e) });
    }
    await this.catalogQuietly(row.scope, row.owner_agent_id);
    return retired;
  }

  /**
   * The human boundary of the views (spec G.1 "never mixed", K.5 per agent): a private scope
   * is readable and editable only through the loop of the human who owns the agent. A row of
   * another human's agent reads as not found, so the view neither shows nor confirms it.
   * Critic and shared rows have no owner and stay editable.
   */
  private async assertOwnAgent(ownerAgentId: string): Promise<void> {
    const agent = await this.deps.store.agent.get(ownerAgentId);
    if (!agent || agent.owner_human_id !== this.deps.humanId)
      throw new ForerunnerError(
        "not_found",
        `agent ${ownerAgentId} is not one of this human's agents`,
        { details: { agentId: ownerAgentId } },
      );
  }

  private async ownLesson(id: string): Promise<LessonRow> {
    const row = await this.ctx.repo.mustGet(id);
    if (row.scope === "agent_private" && row.owner_agent_id) {
      const agent = await this.deps.store.agent.get(row.owner_agent_id);
      if (!agent || agent.owner_human_id !== this.deps.humanId)
        throw new ForerunnerError("not_found", `lesson ${id} is not in this human's memory`, {
          details: { id },
        });
    }
    return row;
  }

  // -------------------------------------------------------------------------------------
  // Weekly consolidation (spec G.4): report, approval request, apply on the answer

  /** Scopes the weekly job covers: every principal's private memory, critic and shared. */
  async consolidationScopes(): Promise<{ scope: MemoryScope; ownerAgentId?: string }[]> {
    const principals = await this.deps.store.agent.principals(this.deps.humanId);
    const out: { scope: MemoryScope; ownerAgentId?: string }[] = [];
    for (const scope of SCOPE_ORDER) {
      if (scope === "agent_private")
        for (const a of principals) out.push({ scope, ownerAgentId: a.id });
      else out.push({ scope });
    }
    return out;
  }

  /**
   * Report-only consolidation of every scope; the proposals go to the human as one approval
   * request (reused while one is open). Nothing is changed here.
   */
  async propose(): Promise<ConsolidationRun> {
    const reports: ConsolidationReport[] = [];
    for (const s of await this.consolidationScopes()) {
      try {
        reports.push(
          await consolidate(this.ctx, {
            scope: s.scope,
            ownerAgentId: s.ownerAgentId,
            clock: this.deps.clock,
            apply: false,
            ...this.deps.consolidation,
          }),
        );
      } catch (e) {
        this.logger.warn("consolidation report failed", {
          scope: s.scope,
          error: errorMessage(e),
        });
      }
    }
    const withProposals = reports.filter((r) => r.proposals.length > 0);
    const proposals = withProposals.flatMap((r) => r.proposals.map((p) => `${r.scope}: ${p}`));
    if (proposals.length === 0) return { requestId: null, reports, proposals: 0 };
    const open = (
      await this.deps.store.humanRequest.open({ humanId: this.deps.humanId }, { limit: 200 })
    ).find((r) => keyOf(r) === CONSOLIDATION_KEY);
    if (open) return { requestId: open.id, reports, proposals: proposals.length };
    const row = await this.deps.store.humanRequest.insert({
      human_id: this.deps.humanId,
      kind: "approval",
      why: `Weekly memory consolidation: ${proposals.length} proposed change(s) (merge duplicates, flag contradictions, retire unused lessons). Nothing changes until you apply them.`,
      steps: proposals.slice(0, 100),
      options: [...CONSOLIDATION_OPTIONS],
      blocking: false,
      risk: "medium",
      change_card: {
        key: CONSOLIDATION_KEY,
        reports: withProposals.map((r) => reportJson(r)),
        applied_at: null,
      },
    });
    return { requestId: row.id, reports, proposals: proposals.length };
  }

  /** Every consolidation request (open, answered, expired), newest first. */
  async proposals(opts: { limit?: number } = {}): Promise<ConsolidationProposal[]> {
    const rows = await this.deps.store.humanRequest.list(
      { kind: "approval", human_id: this.deps.humanId },
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: opts.limit ?? 50 },
    );
    return rows
      .filter((r) => keyOf(r) === CONSOLIDATION_KEY)
      .map((r) => {
        const card = (r.change_card ?? {}) as JsonObject;
        const reports = Array.isArray(card.reports)
          ? (card.reports as unknown as ConsolidationReport[])
          : [];
        return {
          requestId: r.id,
          status: r.status,
          createdAt: r.created_at,
          reports,
          proposals: r.steps,
          appliedAt: typeof card.applied_at === "string" ? card.applied_at : null,
          answer: r.answer,
        };
      });
  }

  /**
   * Apply the consolidations the human approved in the inbox; skip the ones declined. The
   * human approved the proposals in the request, not whatever the scope looks like now: each
   * scope is re-reported first and applied only when the same lessons would be merged,
   * flagged and retired; a scope that drifted (lessons added, edited or used since) is left
   * alone, marked `stale` on the card, and proposed again so the human reads the new list.
   */
  async syncApprovals(): Promise<{ applied: number; skipped: number; stale: number }> {
    let applied = 0;
    let skipped = 0;
    let stale = 0;
    for (const p of await this.proposals({ limit: 100 })) {
      if (p.status !== "answered" || p.appliedAt) continue;
      const row = await this.deps.store.humanRequest.mustGet(p.requestId);
      const card = (row.change_card ?? {}) as JsonObject;
      if (!approved(row.answer)) {
        await this.deps.store.humanRequest.patch(row.id, {
          change_card: { ...card, applied_at: this.deps.clock.nowIso(), skipped: true },
        });
        skipped++;
        continue;
      }
      const staleScopes: string[] = [];
      for (const r of p.reports) {
        const opts = {
          scope: r.scope,
          ownerAgentId: r.ownerAgentId ?? undefined,
          clock: this.deps.clock,
          ...this.deps.consolidation,
        };
        try {
          const now = await consolidate(this.ctx, { ...opts, apply: false });
          if (!sameProposals(r, now)) {
            staleScopes.push(scopeLabel(r));
            continue;
          }
          await consolidate(this.ctx, { ...opts, apply: true });
        } catch (e) {
          this.logger.warn("consolidation apply failed", {
            scope: r.scope,
            error: errorMessage(e),
          });
        }
      }
      await this.deps.store.humanRequest.patch(row.id, {
        change_card: {
          ...card,
          applied_at: this.deps.clock.nowIso(),
          ...(staleScopes.length ? { stale: staleScopes } : {}),
        },
      });
      if (staleScopes.length === p.reports.length && p.reports.length) stale++;
      else applied++;
      if (staleScopes.length) {
        this.logger.info("consolidation proposals changed since approval; proposing again", {
          requestId: row.id,
          scopes: staleScopes,
        });
        await this.propose();
      }
    }
    return { applied, skipped, stale };
  }

  private async exportQuietly(row: LessonRow): Promise<void> {
    try {
      await exportRow(this.ctx.files, row);
      await this.ctx.files.writeCatalog(row.scope, row.owner_agent_id);
    } catch (e) {
      this.logger.warn("lesson file not updated", { id: row.id, error: errorMessage(e) });
    }
  }

  private async catalogQuietly(scope: MemoryScope, owner: string | null): Promise<void> {
    try {
      await this.ctx.files.writeCatalog(scope, owner);
    } catch (e) {
      this.logger.warn("catalog not updated", { scope, error: errorMessage(e) });
    }
  }
}

/** The same lessons would be merged (same survivor), flagged and retired: ids, not wording. */
export function sameProposals(approved: ConsolidationReport, now: ConsolidationReport): boolean {
  const merges = (r: ConsolidationReport) =>
    r.merged.map((m) => `${m.keptId}<-${[...m.retiredIds].sort().join(",")}`).sort();
  const flags = (r: ConsolidationReport) =>
    r.contradictions.map((c) => (c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`)).sort();
  const retired = (r: ConsolidationReport) => [...r.retired].sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  return (
    same(merges(approved), merges(now)) &&
    same(flags(approved), flags(now)) &&
    same(retired(approved), retired(now))
  );
}

function scopeLabel(r: ConsolidationReport): string {
  return r.ownerAgentId ? `${r.scope}:${r.ownerAgentId}` : r.scope;
}

function keyOf(r: HumanRequestRow): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

function approved(answer: JsonValue | null): boolean {
  if (typeof answer === "string") return answer === "apply" || isYes(answer);
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const choice = (answer as JsonObject).choice ?? (answer as JsonObject).answer;
    return choice === "apply" || isYes(choice);
  }
  return isYes(answer);
}

function reportJson(r: ConsolidationReport): JsonObject {
  return {
    scope: r.scope,
    ownerAgentId: r.ownerAgentId,
    ranAt: r.ranAt,
    applied: r.applied,
    merged: r.merged.map((m) => ({ ...m })),
    contradictions: r.contradictions.map((c) => ({ ...c })),
    retired: [...r.retired],
    proposals: [...r.proposals],
  };
}
