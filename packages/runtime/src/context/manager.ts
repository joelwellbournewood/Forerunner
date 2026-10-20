import type { Clock } from "@forerunner/platform";
import {
  type CompressionSelection,
  type HeadroomPort,
  type HeadroomProbe,
  headroomSdkEnv,
  NoHeadroom,
  selectCompression,
} from "./headroom.ts";
import { ContextOriginals, type SessionOriginals } from "./originals.ts";
import {
  ContextPipeline,
  type ContextSettings,
  DEFAULT_CONTEXT_SETTINGS,
  type PipelineSavings,
} from "./pipeline.ts";

/** Headroom is re-probed this often during a session, through the session's Clock (ADR 0003). */
export const HEADROOM_REPROBE_MS = 60_000;

export interface SessionContext {
  sessionId: string;
  projectId: string | undefined;
  settings: ContextSettings;
  /**
   * One pipeline per session: settings, the original-block store and the savings records. Each
   * run begins its own compressor on it, so cross-turn references never leave a transcript.
   */
  pipeline: ContextPipeline;
  /** Where the originals of changed blocks are written; null when no store is configured. */
  originals: SessionOriginals | null;
  selection: CompressionSelection;
  /**
   * Environment for an SDK-driven run of this session (`ANTHROPIC_BASE_URL`,
   * `ANTHROPIC_CUSTOM_HEADERS`); null unless the proxy is in use for a project.
   */
  sdkEnv: Record<string, string> | null;
  /** Headroom `/stats` tokens_saved for the project at session start; null when not in use. */
  headroomBaseline: number | null;
  probedAt: number;
  /** Cancels the scheduled re-probe; set only while the policy is `headroom`. */
  cancelReprobe: (() => void) | null;
}

export interface ContextSessionEnd {
  /** `/stats` delta between session start and end; 0 when the proxy was not used or died. */
  headroomSavedTokens: number;
  compression: PipelineSavings;
  selection: CompressionSelection;
}

export interface ContextManagerDeps {
  clock: Clock;
  headroom?: HeadroomPort;
  /** The project's context settings (settings.context); default: the defaults in code. */
  settingsFor?: (projectId: string | undefined) => Promise<ContextSettings>;
  countTokens?: (text: string) => number;
  /** Called when a session's selection carries a notice (Headroom asked for, not in use). */
  onNotice?: (sessionId: string, selection: CompressionSelection) => void;
  /**
   * Base directory of the original-block store (`join(appDirs().cache, "context")`, ADR 0003
   * section 2). Absent: originals are not kept and no marker names one.
   */
  originalsDir?: string;
  /** Session directories older than this are pruned when the manager starts (default 30 days). */
  originalsMaxAgeMs?: number;
}

/**
 * Owns the context layer per session: resolves the project's policy, probes Headroom when the
 * policy asks for it (at session start and every 60 s after, on the session's Clock), hands the
 * executor the session's pipeline and selection, and at session end turns the pipeline totals
 * and the proxy's counter delta into the Session's `headroom_saved_tokens`. Never throws into a
 * session.
 */
export class ContextManager {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly headroom: HeadroomPort;
  private readonly originals: ContextOriginals | null;
  private closed = false;

  constructor(private readonly deps: ContextManagerDeps) {
    this.headroom = deps.headroom ?? new NoHeadroom();
    this.originals = deps.originalsDir ? new ContextOriginals(deps.originalsDir) : null;
    if (this.originals) {
      try {
        this.originals.prune(deps.clock.now(), deps.originalsMaxAgeMs);
      } catch {
        // pruning is housekeeping; a failure never stops a session
      }
    }
  }

  async forSession(sessionId: string, projectId?: string | null): Promise<SessionContext> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const settings = await this.settings(projectId ?? undefined);
    const selection = await selectCompression(settings.compression, this.headroom);
    const originals = this.originals?.forSession(sessionId) ?? null;
    const pipeline = new ContextPipeline(settings, this.deps.countTokens, originals);
    let headroomBaseline: number | null = null;
    if (selection.headroomUsed && projectId) {
      headroomBaseline = await this.headroom.tokensSaved(projectId).catch(() => null);
    }
    const ctx: SessionContext = {
      sessionId,
      projectId: projectId ?? undefined,
      settings,
      pipeline,
      originals,
      selection,
      sdkEnv: this.sdkEnvFor(selection, projectId ?? undefined),
      headroomBaseline,
      probedAt: this.deps.clock.now(),
      cancelReprobe: null,
    };
    this.sessions.set(sessionId, ctx);
    if (settings.compression === "headroom") this.scheduleReprobe(ctx);
    if (selection.notice) this.deps.onNotice?.(sessionId, selection);
    return ctx;
  }

  get(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async endSession(sessionId: string): Promise<ContextSessionEnd | null> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    this.sessions.delete(sessionId);
    ctx.cancelReprobe?.();
    ctx.cancelReprobe = null;
    let headroomSavedTokens = 0;
    if (ctx.headroomBaseline !== null && ctx.projectId) {
      const now = await this.headroom.tokensSaved(ctx.projectId).catch(() => null);
      if (now !== null) headroomSavedTokens = Math.max(0, now - ctx.headroomBaseline);
    }
    return { headroomSavedTokens, compression: ctx.pipeline.savings(), selection: ctx.selection };
  }

  /** Current proxy state for the Extensions panel and the cost view. */
  probe(): Promise<HeadroomProbe> {
    return this.headroom.probe();
  }

  /** The stored originals of a session (the log view); null when no store is configured. */
  originalsFor(sessionId: string): SessionOriginals | null {
    return this.originals?.forSession(sessionId) ?? null;
  }

  /** Stops every scheduled re-probe (daemon close). Sessions still end normally afterwards. */
  close(): void {
    this.closed = true;
    for (const ctx of this.sessions.values()) {
      ctx.cancelReprobe?.();
      ctx.cancelReprobe = null;
    }
  }

  private scheduleReprobe(ctx: SessionContext): void {
    if (this.closed) return;
    ctx.cancelReprobe = this.deps.clock.setTimeout(() => {
      ctx.cancelReprobe = null;
      void this.reprobe(ctx);
    }, HEADROOM_REPROBE_MS);
  }

  /**
   * The 60 s re-probe: a proxy that died drops the session to native with a notice; one that
   * came back is used again from the next run on. Runs only while the session is open.
   */
  private async reprobe(ctx: SessionContext): Promise<void> {
    if (this.closed || this.sessions.get(ctx.sessionId) !== ctx) return;
    const before = ctx.selection.headroomUsed;
    try {
      ctx.selection = await selectCompression("headroom", this.headroom);
    } catch {
      // selectCompression never throws; a failure here leaves the selection as it was
    }
    ctx.probedAt = this.deps.clock.now();
    ctx.sdkEnv = this.sdkEnvFor(ctx.selection, ctx.projectId);
    if (before && !ctx.selection.headroomUsed) this.deps.onNotice?.(ctx.sessionId, ctx.selection);
    if (this.sessions.get(ctx.sessionId) === ctx) this.scheduleReprobe(ctx);
  }

  private sdkEnvFor(
    selection: CompressionSelection,
    projectId: string | undefined,
  ): Record<string, string> | null {
    const url = selection.headroom?.url;
    return selection.headroomUsed && url && projectId ? headroomSdkEnv(url, projectId) : null;
  }

  private async settings(projectId: string | undefined): Promise<ContextSettings> {
    if (!this.deps.settingsFor) return { ...DEFAULT_CONTEXT_SETTINGS };
    try {
      return await this.deps.settingsFor(projectId);
    } catch {
      return { ...DEFAULT_CONTEXT_SETTINGS };
    }
  }
}
