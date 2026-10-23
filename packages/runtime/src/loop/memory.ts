import type {
  LessonRecordPortRequest,
  LessonRecordPortResult,
  MemoryCommandPort,
} from "@forerunner/commands";
import {
  type ConsolidationReport,
  consolidate,
  createMemory,
  type Embedder,
  exportRow,
  formatSource,
  GENERAL_TAG,
  grantFor,
  type LessonFiles,
  lintLesson,
  type MemoryContext,
  type MemoryScope,
  MemoryService,
  offerToProjects,
  type ProjectTags,
  parseSource,
  pendingPromotions as pendingPromotionRows,
  promote,
  proposalFor,
  proposePromotion,
  rejectPromotion,
  remember,
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
  type ProjectRow,
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
  PromotionCandidate,
  PromotionResolution,
  PromotionReviewOutcome,
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
 * - cross-project sharing (spec G.6, ADR 0059): a recorded critic or shared lesson tagged
 *   `general` becomes a shared-store proposal at once; a private one only when its human
 *   proposes it from the memory view (`proposeSharing`); the session runner has the critic
 *   review this human's pending proposals at session end and calls `resolvePromotion`, which
 *   promotes an accepted one and files one offer (an approval request) per other project of
 *   the same human whose tags overlap; the human accepts (a pinned copy in that project's
 *   shared memory) or dismisses, from the memory view or the inbox, each an audit row;
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
/** `change_card.key` of a cross-project offer (spec G.6): one request per lesson and project. */
export const OFFER_KEY = "memory:offer";
export const OFFER_OPTIONS = ["accept", "dismiss"] as const;
/** Audit rows of the human's answer to an offer. */
export const OFFER_ACCEPTED_AUDIT_TOOL = "memory.offer_accepted";
export const OFFER_DISMISSED_AUDIT_TOOL = "memory.offer_dismissed";
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

/** One cross-project offer (spec G.6) as the memory view and the inbox show it. */
export interface LessonOffer {
  requestId: string;
  status: HumanRequestRow["status"];
  /** The promoted (global shared) lesson. */
  lessonId: string;
  text: string;
  tags: string[];
  confidence: number;
  projectId: string;
  projectName: string;
  /** Tags the lesson and the project have in common. */
  sharedTags: string[];
  createdAt: string;
  answer: JsonValue | null;
  /** When the answer was applied; null while open or not yet applied. */
  appliedAt: string | null;
  /** The pinned project copy an accepted offer made. */
  copyId: string | null;
  version: number;
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
        ...(req.countTokens ? { countTokens: req.countTokens } : {}),
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
    const scope = req.scope ?? "agent_private";
    const out = await this.service.rememberFromSession({
      agentId: req.agentId,
      sessionId: req.sessionId,
      projectId: req.projectId,
      scope,
      lessons: screened.kept,
      authorHuman: req.authorHuman ?? null,
    });
    // Spec G.6: a critic or shared lesson tagged `general` is proposed to the shared store
    // here, idempotently; the critic decides at the next session end. A private lesson is
    // never proposed by itself: its human approves the exact text (`proposeSharing`).
    const proposed: string[] = [];
    if (scope !== "agent_private") {
      for (const r of out.recorded) {
        const lesson = r.lesson;
        if (!lesson.tags.includes(GENERAL_TAG)) continue;
        if (lesson.scope === "shared" && lesson.project_id === null) continue;
        try {
          // A re-recorded lesson supersedes its earlier row; a proposal still pending for
          // that row follows the lesson (same proposal, the merged text) instead of a second
          // proposal for the same lesson.
          const stale =
            r.action === "merged" && r.supersededId
              ? await proposalFor(this.ctx, r.supersededId)
              : undefined;
          const proposal = stale
            ? await this.exportQuietly(
                await this.ctx.repo.update(stale.id, stale.version, {
                  source: formatSource({ ...parseSource(stale.source), promotion: lesson.id }),
                  text: lesson.text,
                  tags: [...lesson.tags],
                  confidence: lesson.confidence,
                  embedding: lesson.embedding,
                }),
              )
            : await proposePromotion(this.ctx, lesson.id, { agentId: req.agentId });
          if (!proposed.includes(proposal.id)) proposed.push(proposal.id);
        } catch (e) {
          this.logger.warn("lesson not proposed for sharing", {
            id: lesson.id,
            error: errorMessage(e),
          });
        }
      }
    }
    return {
      recorded: out.recorded.length,
      merged: out.recorded.filter((r) => r.action === "merged").length,
      rejected: [...rejected, ...out.rejected],
      proposed,
    };
  }

  // -------------------------------------------------------------------------------------
  // A lesson the human states in chat or voice (spec O.2, ADR 0061): the registry's
  // `memory.record` through `memoryCommandPort`

  /**
   * Record a lesson the human stated into the private memory of that human's own principal:
   * the agent must be a principal (or the conversation agent) owned by the human, the text
   * passes the same injection screen as any lesson candidate (a stated "lesson" that reads as
   * an order to skip a guard is refused and quoted back), and it is stored with the human as
   * author, the chat as source and `STATED_LESSON_CONFIDENCE`. A near-duplicate of an existing
   * lesson supersedes it (the package's merge); the result names the superseded row so the
   * undo can put it back.
   */
  async recordStated(req: LessonRecordPortRequest): Promise<LessonRecordPortResult> {
    const agent = await this.deps.store.agent.get(req.agentId);
    if (
      !agent ||
      agent.owner_human_id !== req.humanId ||
      (agent.kind !== "principal" && agent.kind !== "conversation")
    )
      throw new ForerunnerError(
        "autonomy_insufficient",
        "a stated lesson goes only into the private memory of the human's own principal",
        { details: { agentId: req.agentId } },
      );
    const screened = screenLessons([{ text: req.text }], "unknown");
    const refused = screened.rejected[0];
    if (refused)
      throw new ForerunnerError("injection_suspected", `not recorded: ${refused.error}`, {
        details: { rules: refused.rules },
      });
    const out = await this.service.rememberFromSession({
      agentId: agent.id,
      sessionId: "chat",
      projectId: req.projectId,
      scope: "agent_private",
      lessons: [
        {
          text: req.text,
          tags: lessonTags(req.tags),
          source: req.source,
          confidence: STATED_LESSON_CONFIDENCE,
        },
      ],
      authorHuman: req.humanId,
    });
    const rec = out.recorded[0];
    if (!rec)
      throw new ForerunnerError(
        "validation",
        `not recorded: ${out.rejected[0]?.error ?? "the lesson was rejected"}`,
      );
    this.logger.info("stated lesson recorded", {
      id: rec.lesson.id,
      agentId: agent.id,
      projectId: req.projectId,
      action: rec.action,
    });
    return {
      lessonId: rec.lesson.id,
      text: rec.lesson.text,
      action: rec.action,
      supersededId: rec.supersededId ?? null,
    };
  }

  /**
   * The undo of `recordStated`: the lesson is retired and its file removed; a lesson it
   * superseded by a merge is active again. Only the human who owns the agent can undo.
   */
  async forgetStated(req: {
    lessonId: string;
    restoreId?: string | null;
    humanId: string;
  }): Promise<void> {
    const row = await this.ctx.repo.get(req.lessonId);
    if (!row) return;
    const owner = row.owner_agent_id ? await this.deps.store.agent.get(row.owner_agent_id) : null;
    if (row.scope !== "agent_private" || !owner || owner.owner_human_id !== req.humanId)
      throw new ForerunnerError(
        "not_found",
        `lesson ${req.lessonId} is not in this human's memory`,
        {
          details: { id: req.lessonId },
        },
      );
    if (row.status !== "retired") await this.ctx.repo.retire(row.id, row.version);
    try {
      await this.ctx.files.remove(this.ctx.files.pathFor(row.scope, row.owner_agent_id, row.id));
    } catch (e) {
      this.logger.warn("lesson file not removed", { id: row.id, error: errorMessage(e) });
    }
    if (req.restoreId) {
      const old = await this.ctx.repo.get(req.restoreId);
      if (old && old.superseded_by === row.id)
        await this.exportQuietly(
          await this.ctx.repo.patch(old.id, { superseded_by: null, status: "active" }),
        );
    }
    await this.catalogQuietly(row.scope, row.owner_agent_id);
  }

  // -------------------------------------------------------------------------------------
  // Cross-project sharing (spec G.6, ADR 0059): proposals, the critic's decision, offers

  /**
   * The human proposes a lesson for every project from the memory view. The lesson is tagged
   * `general` first when it is not (the human's own act on the exact text), then proposed:
   * a private lesson with the human's approval and its owner as the proposing agent (the
   * package refuses anything else), a critic or project-level shared one directly. Another
   * human's private lesson reads as not found.
   */
  async proposeSharing(id: string): Promise<LessonRow> {
    const row = await this.ownLesson(id);
    if (row.status !== "active" || row.superseded_by !== null)
      throw new ForerunnerError("validation", "only an active, current lesson can be shared", {
        details: { id, status: row.status },
      });
    if (row.scope === "shared" && row.project_id === null)
      throw new ForerunnerError("validation", "lesson is already shared across projects", {
        details: { id },
      });
    const current = row.tags.includes(GENERAL_TAG)
      ? row
      : await this.edit(id, { tags: [...row.tags, GENERAL_TAG] }, { humanId: this.deps.humanId });
    const agentId = current.owner_agent_id ?? current.author_agent ?? undefined;
    return proposePromotion(this.ctx, id, {
      ...(agentId ? { agentId } : {}),
      humanApproval: { humanId: this.deps.humanId },
    });
  }

  /**
   * Open proposals this human's critic decides: made by one of the human's agents or by the
   * human. Another human's proposals (a shared Postgres store) are theirs to review.
   */
  async pendingProposals(): Promise<LessonRow[]> {
    const agents = new Set(
      (await this.deps.store.agent.forOwner(this.deps.humanId)).map((a) => a.id),
    );
    return (await pendingPromotionRows(this.ctx)).filter(
      (r) =>
        r.author_human === this.deps.humanId ||
        (r.author_agent !== null && agents.has(r.author_agent)),
    );
  }

  async pendingPromotions(): Promise<PromotionCandidate[]> {
    const out: PromotionCandidate[] = [];
    for (const r of await this.pendingProposals()) {
      const originId = parseSource(r.source).promotion ?? null;
      const origin = originId ? await this.ctx.repo.get(originId) : undefined;
      out.push({
        id: r.id,
        text: r.text,
        tags: [...r.tags],
        confidence: r.confidence,
        originId,
        originScope: origin?.scope ?? null,
        originProjectId: origin?.project_id ?? null,
      });
    }
    return out;
  }

  /**
   * The critic's decision on a proposal. A completed accepting review promotes it (the
   * package verifies the review row accepted) and files the offers; any other completed
   * verdict retires the proposal with the review named in its source (the origin stays);
   * a review that did not complete decides nothing and the proposal waits for the next session.
   */
  async resolvePromotion(id: string, review: PromotionReviewOutcome): Promise<PromotionResolution> {
    if (!review.completed || !review.reviewId) return { status: "pending", offers: [] };
    if (review.verdict === "accept") {
      const promoted = await promote(this.ctx, id, { reviewId: review.reviewId });
      const offers = await this.fileOffers(promoted);
      return { status: "promoted", offers };
    }
    const retired = await rejectPromotion(this.ctx, id);
    const named = await this.ctx.repo.patch(retired.id, {
      source: formatSource({ ...parseSource(retired.source), rejected_by: review.reviewId }),
    });
    await this.exportQuietly(named);
    return { status: "rejected", offers: [] };
  }

  /**
   * Projects this human's agents work on: the ones whose `settings.members` name one of the
   * human's principals, or (a single-human install) a project that declares no members.
   */
  async humanProjects(): Promise<ProjectRow[]> {
    const principals = (await this.deps.store.agent.principals(this.deps.humanId)).map((a) => a.id);
    const projects = await this.deps.store.project.list({}, { limit: 1000 });
    return projects.filter((p) => {
      if (!p.active) return false;
      const members = (p.settings as { members?: unknown }).members;
      if (Array.isArray(members) && members.length)
        return members.some((m) => typeof m === "string" && principals.includes(m));
      return true;
    });
  }

  /**
   * What a project is about, for the offer rule: `settings.tags` plus the tags of the active
   * lessons recorded about it in critic, shared and this human's principals' private memory
   * (tags only; no text leaves the scope).
   */
  async projectTags(project: ProjectRow): Promise<string[]> {
    const tags = new Set<string>();
    const declared = (project.settings as { tags?: unknown }).tags;
    if (Array.isArray(declared))
      for (const t of declared) if (typeof t === "string" && t) tags.add(t);
    const add = (rows: LessonRow[]) => {
      for (const r of rows) for (const t of r.tags) tags.add(t);
    };
    for (const scope of ["critic", "shared"] as const)
      add(await this.ctx.repo.search({ scope, projectId: project.id, limit: 1000 }));
    for (const a of await this.deps.store.agent.principals(this.deps.humanId))
      add(
        await this.ctx.repo.search({
          scope: "agent_private",
          ownerAgentId: a.id,
          projectId: project.id,
          limit: 1000,
        }),
      );
    return [...tags].sort();
  }

  /**
   * One offer per other project of the same human whose tags overlap the promoted lesson's
   * (the package's rule, never the origin project): a non-blocking approval request with
   * `accept`/`dismiss`. A pair that already has a request (open or answered) is not offered
   * again. Nothing crosses humans: only this human's projects are candidates.
   */
  async fileOffers(lesson: LessonRow): Promise<{ projectId: string; requestId: string }[]> {
    const projects = await this.humanProjects();
    const tagged: ProjectTags[] = [];
    for (const p of projects) tagged.push({ id: p.id, tags: await this.projectTags(p) });
    const offers = await offerToProjects(this.ctx, lesson.id, tagged);
    if (offers.length === 0) return [];
    const existing = await this.offerRequests({ limit: 1000 });
    const out: { projectId: string; requestId: string }[] = [];
    for (const o of offers) {
      const dup = existing.find((r) => {
        const card = offerCard(r);
        return card.lessonId === lesson.id && card.projectId === o.projectId;
      });
      if (dup) continue;
      const project = projects.find((p) => p.id === o.projectId);
      const row = await this.deps.store.humanRequest.insert({
        human_id: this.deps.humanId,
        project_id: o.projectId,
        kind: "approval",
        why: `Shared lesson offered to ${project?.name ?? o.projectId} (tags in common: ${o.sharedTags.join(", ")}). Accept pins it for that project; dismiss leaves it available by relevance only.`.slice(
          0,
          4000,
        ),
        steps: [lesson.text],
        options: [...OFFER_OPTIONS],
        blocking: false,
        risk: "low",
        change_card: {
          key: OFFER_KEY,
          lesson_id: lesson.id,
          project_id: o.projectId,
          shared_tags: [...o.sharedTags],
          applied_at: null,
          copy_id: null,
        },
        author_human: lesson.author_human ?? null,
        author_agent: lesson.author_agent ?? null,
      });
      out.push({ projectId: o.projectId, requestId: row.id });
    }
    return out;
  }

  private async offerRequests(opts: { limit?: number } = {}): Promise<HumanRequestRow[]> {
    const rows = await this.deps.store.humanRequest.list(
      { kind: "approval", human_id: this.deps.humanId },
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: opts.limit ?? 100 },
    );
    return rows.filter((r) => keyOf(r) === OFFER_KEY);
  }

  /** Every offer of this human (open, answered, expired), newest first. */
  async offers(opts: { limit?: number } = {}): Promise<LessonOffer[]> {
    const out: LessonOffer[] = [];
    for (const r of await this.offerRequests(opts)) {
      const card = offerCard(r);
      const lesson = await this.ctx.repo.get(card.lessonId);
      const project = await this.deps.store.project.get(card.projectId);
      out.push({
        requestId: r.id,
        status: r.status,
        lessonId: card.lessonId,
        text: lesson?.text ?? r.steps[0] ?? "",
        tags: lesson ? [...lesson.tags] : [],
        confidence: lesson?.confidence ?? 0,
        projectId: card.projectId,
        projectName: project?.name ?? card.projectId,
        sharedTags: card.sharedTags,
        createdAt: r.created_at,
        answer: r.answer,
        appliedAt: card.appliedAt,
        copyId: card.copyId,
        version: r.version,
      });
    }
    return out;
  }

  /** The human answers an offer from the memory view; applied at once. */
  async answerOffer(
    requestId: string,
    answer: (typeof OFFER_OPTIONS)[number],
  ): Promise<LessonOffer> {
    if (!OFFER_OPTIONS.includes(answer))
      throw new ForerunnerError("validation", `answer must be one of ${OFFER_OPTIONS.join(", ")}`);
    const row = await this.deps.store.humanRequest.mustGet(requestId);
    if (keyOf(row) !== OFFER_KEY || row.human_id !== this.deps.humanId)
      throw new ForerunnerError("not_found", `offer ${requestId} not found`, {
        details: { requestId },
      });
    await this.deps.store.humanRequest.answer(row.id, row.version, answer, this.deps.humanId);
    await this.syncOffers();
    const view = (await this.offers({ limit: 1000 })).find((o) => o.requestId === requestId);
    if (!view) throw new ForerunnerError("not_found", `offer ${requestId} not found`);
    return view;
  }

  /**
   * Apply answered offers (from the memory view or the inbox): an accepted one copies the
   * promoted lesson into the project's shared memory as a pinned, project-level lesson whose
   * source names the origin (never into any private scope), a dismissed one changes nothing;
   * each is one audit row. A lesson retired since the offer is marked `stale` and skipped.
   */
  async syncOffers(): Promise<{ accepted: number; dismissed: number; stale: number }> {
    const out = { accepted: 0, dismissed: 0, stale: 0 };
    for (const r of await this.offerRequests({ limit: 1000 })) {
      if (r.status !== "answered") continue;
      const card = offerCard(r);
      if (card.appliedAt) continue;
      const raw = (r.change_card ?? {}) as JsonObject;
      const now = this.deps.clock.nowIso();
      if (!offerAccepted(r.answer)) {
        await this.deps.store.humanRequest.patch(r.id, {
          change_card: { ...raw, applied_at: now, dismissed: true },
        });
        await this.auditOffer(OFFER_DISMISSED_AUDIT_TOOL, r, card, "dismissed", true);
        out.dismissed++;
        continue;
      }
      const lesson = await this.ctx.repo.get(card.lessonId);
      if (lesson?.status !== "active" || lesson.superseded_by !== null) {
        await this.deps.store.humanRequest.patch(r.id, {
          change_card: { ...raw, applied_at: now, stale: true },
        });
        await this.auditOffer(
          OFFER_ACCEPTED_AUDIT_TOOL,
          r,
          card,
          "lesson no longer active; nothing copied",
          false,
        );
        out.stale++;
        continue;
      }
      const copy = await remember(
        this.ctx,
        {
          scope: "shared",
          text: lesson.text,
          tags: lesson.tags,
          confidence: lesson.confidence,
          projectId: card.projectId,
          pinned: true,
          source: formatSource({ promotion: lesson.id, human: this.deps.humanId }),
          authorHuman: this.deps.humanId,
          authorAgent: null,
        },
        { noDedup: true },
      );
      await this.catalogQuietly("shared", null);
      await this.deps.store.humanRequest.patch(r.id, {
        change_card: { ...raw, applied_at: now, copy_id: copy.lesson.id },
      });
      await this.auditOffer(
        OFFER_ACCEPTED_AUDIT_TOOL,
        r,
        card,
        `copied as ${copy.lesson.id} (pinned for the project)`,
        true,
      );
      out.accepted++;
    }
    return out;
  }

  private async auditOffer(
    tool: string,
    r: HumanRequestRow,
    card: OfferCard,
    result: string,
    allowed: boolean,
  ): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        session_id: null,
        run_id: null,
        agent_id: null,
        human_id: this.deps.humanId,
        tool,
        input_summary: JSON.stringify({
          requestId: r.id,
          lessonId: card.lessonId,
          projectId: card.projectId,
        }),
        result_summary: result,
        allowed,
        denied_reason: allowed ? null : result,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.warn("offer answer not audited", { requestId: r.id, error: errorMessage(e) });
    }
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

  private async exportQuietly(row: LessonRow): Promise<LessonRow> {
    try {
      await exportRow(this.ctx.files, row);
      await this.ctx.files.writeCatalog(row.scope, row.owner_agent_id);
    } catch (e) {
      this.logger.warn("lesson file not updated", { id: row.id, error: errorMessage(e) });
    }
    return row;
  }

  private async catalogQuietly(scope: MemoryScope, owner: string | null): Promise<void> {
    try {
      await this.ctx.files.writeCatalog(scope, owner);
    } catch (e) {
      this.logger.warn("catalog not updated", { scope, error: errorMessage(e) });
    }
  }
}

/**
 * Confidence of a lesson the human stated (ADR 0061): above a session's default 0.5 because
 * the human said it, below 1 so a later contradiction is still weighed.
 */
export const STATED_LESSON_CONFIDENCE = 0.8;

/** Tags as the lesson lint wants them: lowercase kebab-case, at most 16, the rest dropped. */
function lessonTags(tags: readonly string[]): string[] {
  const out = tags
    .map((t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);
  return [...new Set(out)].slice(0, 16);
}

/** The registry's memory port (`CommandPorts.memory`) over the daemon's memory loop. */
export function memoryCommandPort(memory: MemoryLoop): MemoryCommandPort {
  return {
    recordLesson: (req) => memory.recordStated(req),
    forgetLesson: (req) => memory.forgetStated(req),
  };
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

interface OfferCard {
  lessonId: string;
  projectId: string;
  sharedTags: string[];
  appliedAt: string | null;
  copyId: string | null;
}

function offerCard(r: HumanRequestRow): OfferCard {
  const card = (r.change_card ?? {}) as JsonObject;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    lessonId: str(card.lesson_id) ?? "",
    projectId: str(card.project_id) ?? "",
    sharedTags: Array.isArray(card.shared_tags)
      ? card.shared_tags.filter((t): t is string => typeof t === "string")
      : [],
    appliedAt: str(card.applied_at),
    copyId: str(card.copy_id),
  };
}

function offerAccepted(answer: JsonValue | null): boolean {
  if (typeof answer === "string") return answer === "accept" || isYes(answer);
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const choice = (answer as JsonObject).choice ?? (answer as JsonObject).answer;
    return choice === "accept" || isYes(choice);
  }
  return isYes(answer);
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
