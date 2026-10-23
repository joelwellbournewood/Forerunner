/**
 * The desktop controller: one per daemon (one desktop), wiring the gate, the platform adapter,
 * the on-screen indicator and the audit log. Every action goes through `perform`: binding,
 * static gate, targets, full gate, indicator on, the action, audit row. Actions are serialised
 * (one keyboard, one mouse); a revoke aborts the in-flight action and drops the queued ones.
 * Screenshots land under the agent's sandbox directory, never a worktree, and their bytes
 * reach the model only when the binding allows it and the call asked.
 */
import { mkdirSync, readFileSync } from "node:fs";
import {
  type AppDirsOptions,
  appDirs,
  type Clock,
  ForerunnerError,
  isInside,
  join,
  type Logger,
  log,
  safeSegment,
} from "@forerunner/platform";
import type {
  AuditPort,
  KillReport,
  KillScope,
  KillSwitch,
  ToolExecutionContext,
} from "@forerunner/runtime";
import type { DesktopAdapter, MouseButton } from "./adapters/types.ts";
import { appMatches, windowAllowed } from "./allowlist.ts";
import type { DesktopApprovalPort } from "./approvals.ts";
import { DesktopGate, type DesktopGateContext, desktopDenial } from "./gate.ts";
import type { Indicator, IndicatorReason } from "./indicator.ts";
import {
  DESKTOP_CAPABILITY_NAME,
  type DesktopAction,
  type DesktopActionKind,
  type DesktopBindingResolver,
  type DesktopIdentity,
  type DesktopRunBinding,
  identityOf,
  summarize,
  type WindowInfo,
} from "./types.ts";

export interface DesktopControllerOptions {
  adapter: DesktopAdapter;
  binding: DesktopBindingResolver;
  indicator: Indicator;
  audit: AuditPort;
  clock: Clock;
  approvals?: DesktopApprovalPort;
  /** The kill switch's frozen state is part of the gate; attachKillSwitch adds the live stop. */
  kill?: Pick<KillSwitch, "isFrozen">;
  /** Where an agent's screenshots go; default `<data>/desktop/<agent>/screenshots`. */
  screenshotDir?: (agentId: string) => string;
  appDirs?: AppDirsOptions;
  /** The indicator goes off this long after the last action unless another one starts. */
  indicatorIdleMs?: number;
  logger?: Logger;
}

export const DEFAULT_INDICATOR_IDLE_MS = 1500;

export function desktopScreenshotDir(agentId: string, dirs: AppDirsOptions = {}): string {
  return join(appDirs(dirs).data, "desktop", safeSegment(agentId, "agent"), "screenshots");
}

export interface DesktopScreenshot {
  path: string;
  bytes: number;
  window: { id: string; exe: string; windowClass: string; title: string };
  /** Only when the binding allows screenshots in the model context and the call asked. */
  image?: { mediaType: "image/png"; base64: string };
}

export interface DesktopWindowList {
  /** Windows of allowlisted applications. */
  windows: WindowInfo[];
  /** Windows of other applications: counted, never named. */
  hidden: number;
}

/**
 * What the on-screen indicator shows right now (spec S.32), for a shell that (re)connects and
 * missed the `desktop.indicator` frames: `active` mirrors `indicatorOn`; `app`, `sessionId`
 * and `agentId` are those of the last `on` (null when off or not known); `since` is when the
 * indicator turned on.
 */
export interface DesktopControlState {
  active: boolean;
  app: string | null;
  sessionId: string | null;
  agentId: string | null;
  since: string | null;
}

export interface DesktopStatus {
  capability: string;
  adapter: DesktopAdapter["platform"];
  revoked: boolean;
  revokedReason: string | null;
  indicatorOn: boolean;
  /** The indicator's state with the names the banner shows (the shells re-read it on reconnect). */
  desktopControl: DesktopControlState;
  inFlight: number;
  queued: number;
  /** Actions performed since the daemon started. */
  actions: number;
}

export interface DesktopRevokeReport {
  reason: string;
  interrupted: number;
  dropped: number;
}

interface Waiter {
  identity: DesktopIdentity;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface Slot {
  signal: AbortSignal;
  targets: readonly WindowInfo[];
  binding: DesktopRunBinding;
  identity: DesktopIdentity;
}

/** The same error, with how much of the text was typed before it, for the audit row. */
function withTypedCount(err: ForerunnerError, typed: number, total: number): ForerunnerError {
  if (typed <= 0) return err;
  return new ForerunnerError(
    err.code,
    `typed ${typed} of ${total} characters, then ${err.message}`,
    { details: { ...err.details, typedChars: typed, totalChars: total }, cause: err },
  );
}

function matchesScope(identity: DesktopIdentity, scope: KillScope | "all"): boolean {
  if (scope === "all") return true;
  if (scope.sessionId && scope.sessionId !== identity.sessionId) return false;
  if (scope.agentId && scope.agentId !== identity.agentId) return false;
  return true;
}

export class DesktopController {
  readonly gate: DesktopGate;
  private readonly logger: Logger;
  private running = false;
  private waiters: Waiter[] = [];
  private readonly inflight = new Map<AbortController, DesktopIdentity>();
  private indicatorActive = false;
  /** The reason of the last `on` while the indicator is on; null while off. */
  private indicatorReason: IndicatorReason | null = null;
  private cancelIdle: (() => void) | null = null;
  private seq = 0;
  private actions = 0;

  constructor(private readonly opts: DesktopControllerOptions) {
    this.gate = new DesktopGate({
      clock: opts.clock,
      ...(opts.approvals ? { approvals: opts.approvals } : {}),
    });
    this.logger = opts.logger ?? log("desktop");
  }

  get adapter(): DesktopAdapter {
    return this.opts.adapter;
  }

  // ------------------------------------------------------------------------------------------
  // Operations

  listWindows(ctx: ToolExecutionContext): Promise<DesktopWindowList> {
    return this.perform(ctx, "list_windows", { summary: "list windows" }, async (slot) => {
      const all = await this.opts.adapter.listWindows({ signal: slot.signal });
      const windows = all.filter((w) => windowAllowed(w, slot.binding.allowlist));
      const hidden = all.length - windows.length;
      return {
        value: { windows, hidden },
        result: `${windows.length} allowed window(s), ${hidden} of other applications hidden`,
      };
    });
  }

  focus(ctx: ToolExecutionContext, app: string): Promise<WindowInfo> {
    return this.perform(ctx, "focus", { app, summary: `focus ${app}` }, async (slot) => {
      const target = slot.targets[0];
      if (!target) throw desktopDenial("no_target", `no window of ${app} is open`);
      const w = await this.opts.adapter.focus(target, { signal: slot.signal });
      return { value: w, result: `focused ${w.exe} (${w.windowClass}) ${summarize(w.title, 80)}` };
    });
  }

  typeText(ctx: ToolExecutionContext, text: string): Promise<void> {
    const summary = `type ${text.length} chars into the active window`;
    return this.perform(ctx, "type", { summary }, async (slot) => {
      // The adapter types in chunks; when it is cut short (timeout, revoke, kill) the error and
      // the audit row say how many characters reached the application.
      let typed = 0;
      try {
        await this.opts.adapter.typeText(text, {
          signal: slot.signal,
          onProgress: (done) => {
            typed = done;
          },
        });
      } catch (e) {
        throw withTypedCount(this.mapError(e, slot.signal), typed, text.length);
      }
      return {
        value: undefined,
        result: `typed ${text.length} chars into ${slot.targets[0]?.exe}`,
      };
    });
  }

  pressKey(ctx: ToolExecutionContext, key: string): Promise<void> {
    return this.perform(ctx, "key", { summary: `press ${key}` }, async (slot) => {
      await this.opts.adapter.pressKey(key, { signal: slot.signal });
      return { value: undefined, result: `pressed ${key} in ${slot.targets[0]?.exe}` };
    });
  }

  click(
    ctx: ToolExecutionContext,
    x: number,
    y: number,
    button: MouseButton = "left",
  ): Promise<void> {
    const summary = `${button} click at ${x},${y}`;
    return this.perform(ctx, "click", { summary }, async (slot) => {
      await this.opts.adapter.click(x, y, { button, signal: slot.signal });
      return { value: undefined, result: `${summary} in ${slot.targets[0]?.exe}` };
    });
  }

  screenshot(
    ctx: ToolExecutionContext,
    opts: { label?: string; includeInContext?: boolean } = {},
  ): Promise<DesktopScreenshot> {
    const summary = `screenshot${opts.label ? ` ${opts.label}` : ""}${opts.includeInContext ? " (asked for the image)" : ""}`;
    return this.perform(ctx, "screenshot", { summary }, async (slot) => {
      const w = slot.targets[0];
      if (!w) throw desktopDenial("no_target", "no active window to capture");
      const dirFor =
        this.opts.screenshotDir ?? ((a: string) => desktopScreenshotDir(a, this.opts.appDirs));
      const dir = dirFor(slot.identity.agentId);
      mkdirSync(dir, { recursive: true });
      const stamp = this.opts.clock.nowIso().replace(/[:.]/g, "-");
      const label = opts.label ? `-${safeSegment(opts.label, "shot")}` : "";
      const name = `${stamp}-${safeSegment(slot.identity.runId, "run")}-${++this.seq}${label}.png`;
      const path = join(dir, name);
      if (!isInside(dir, path)) {
        throw new ForerunnerError("path_not_allowed", "screenshot path escaped the sandbox");
      }
      const r = await this.opts.adapter.screenshot(path, { window: w, signal: slot.signal });
      const includeImage =
        opts.includeInContext === true && slot.binding.screenshotsToModel === true;
      const value: DesktopScreenshot = {
        path: r.path,
        bytes: r.bytes,
        window: { id: w.id, exe: w.exe, windowClass: w.windowClass, title: w.title },
        ...(includeImage
          ? {
              image: {
                mediaType: "image/png" as const,
                base64: readFileSync(r.path).toString("base64"),
              },
            }
          : {}),
      };
      const note = includeImage
        ? "; image returned to the model"
        : opts.includeInContext
          ? "; image withheld: the token does not allow screenshots in the model context"
          : "";
      return { value, result: `saved ${r.path} (${r.bytes} bytes, window ${w.exe})${note}` };
    });
  }

  /** The gate alone, for ToolSpec.beforeCall: no action, no indicator; denials are audited. */
  async check(
    kind: DesktopActionKind,
    ctx: ToolExecutionContext,
    input: { app?: string } = {},
  ): Promise<void> {
    const binding = await this.opts.binding(ctx);
    const identity = identityOf(ctx, binding.tokenId);
    const gateCtx = this.gateContext(identity, binding, ctx);
    try {
      this.gate.checkStatic(gateCtx);
      const targets = await this.targetsFor(kind, input.app, ctx.signal);
      await this.gate.check({ kind, targets, summary: summarize(input) }, gateCtx);
    } catch (e) {
      const err = this.mapError(e, ctx.signal);
      await this.audit(identity, kind, summarize(input), "", false, `${err.code}: ${err.message}`);
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle

  /** The run finished: the indicator goes off at once when nothing else is active. */
  async endRun(_runId: string): Promise<void> {
    if (!this.running && this.inflight.size === 0) await this.indicatorOff("run ended");
  }

  /** Stop everything and refuse until resume(): the Extensions panel's live revocation. */
  async revoke(reason = "desktop control revoked"): Promise<DesktopRevokeReport> {
    this.gate.revoke(reason);
    const report = await this.stopAll("all", reason, "revoked");
    this.logger.warn("revoked", { ...report });
    return report;
  }

  resume(): void {
    this.gate.resume();
  }

  /** Wire the kill switch: every stop interrupts the matching desktop actions at once. */
  attachKillSwitch(kill: { onStop(fn: (report: KillReport) => void): () => void }): () => void {
    return kill.onStop((report) => {
      void this.stopAll(report.scope, "kill switch", "killed").catch((e) =>
        this.logger.error("stop after kill failed", { error: String(e) }),
      );
    });
  }

  /** Wire the extensions registry: disabling or removing the capability revokes live. */
  attachExtensionRegistry(
    registry: { onEvent(listener: (event: { type: string; name: string }) => void): () => void },
    name: string = DESKTOP_CAPABILITY_NAME,
  ): () => void {
    return registry.onEvent((event) => {
      if (event.name !== name) return;
      if (event.type === "extension.disabled" || event.type === "extension.removed") {
        void this.revoke(
          `${name} ${event.type === "extension.removed" ? "removed" : "disabled"} in the Extensions panel`,
        ).catch((e) =>
          this.logger.error("revoke after extension change failed", { error: String(e) }),
        );
      } else if (event.type === "extension.enabled") {
        this.resume();
      }
    });
  }

  status(): DesktopStatus {
    return {
      capability: DESKTOP_CAPABILITY_NAME,
      adapter: this.opts.adapter.platform,
      revoked: this.gate.revoked,
      revokedReason: this.gate.reason,
      indicatorOn: this.indicatorActive,
      desktopControl: {
        active: this.indicatorActive,
        app: (this.indicatorActive && this.indicatorReason?.app) || null,
        sessionId: (this.indicatorActive && this.indicatorReason?.sessionId) || null,
        agentId: (this.indicatorActive && this.indicatorReason?.agentId) || null,
        since: (this.indicatorActive && this.indicatorReason?.at) || null,
      },
      inFlight: this.inflight.size,
      queued: this.waiters.length,
      actions: this.actions,
    };
  }

  async close(): Promise<void> {
    await this.stopAll("all", "daemon stopping", "killed");
    await this.opts.adapter.dispose?.();
  }

  // ------------------------------------------------------------------------------------------
  // Internals

  private gateContext(
    identity: DesktopIdentity,
    binding: DesktopRunBinding,
    ctx: ToolExecutionContext,
  ): DesktopGateContext {
    const frozen =
      this.opts.kill?.isFrozen({ agentId: identity.agentId, sessionId: identity.sessionId }) ??
      false;
    return { identity, binding, killed: ctx.signal.aborted || frozen };
  }

  private async targetsFor(
    kind: DesktopActionKind,
    app: string | undefined,
    signal: AbortSignal,
  ): Promise<WindowInfo[]> {
    if (kind === "list_windows") return [];
    if (kind === "focus") {
      if (!app) throw new ForerunnerError("validation", "focus needs an application name");
      const windows = await this.opts.adapter.listWindows({ signal });
      return windows.filter((w) => appMatches(w, app));
    }
    const active = await this.opts.adapter.activeWindow({ signal });
    return active ? [active] : [];
  }

  private async perform<T>(
    ctx: ToolExecutionContext,
    kind: DesktopActionKind,
    input: { app?: string; summary: string },
    body: (slot: Slot) => Promise<{ value: T; result: string }>,
  ): Promise<T> {
    const binding = await this.opts.binding(ctx);
    const identity = identityOf(ctx, binding.tokenId);
    const ac = new AbortController();
    const onAbort = () => ac.abort(ctx.signal.reason ?? new Error("run aborted"));
    let acquired = false;
    try {
      // Cheap checks first: nothing touches the desktop (or waits for it) when the capability
      // is off, the level too low, or the run stopped.
      this.gate.checkStatic(this.gateContext(identity, binding, ctx));
      await this.acquire(identity);
      acquired = true;
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      this.inflight.set(ac, identity);
      if (ac.signal.aborted) throw ac.signal.reason;
      const targets = await this.targetsFor(kind, input.app, ac.signal);
      const action: DesktopAction = { kind, targets, summary: input.summary };
      await this.gate.check(action, this.gateContext(identity, binding, ctx));
      if (ac.signal.aborted) throw ac.signal.reason;
      await this.indicatorOnFor(identity, targets[0]);
      const { value, result } = await body({ signal: ac.signal, targets, binding, identity });
      this.actions++;
      await this.audit(identity, kind, input.summary, result, true);
      return value;
    } catch (e) {
      const err = this.mapError(e, ac.signal);
      await this.audit(identity, kind, input.summary, "", false, `${err.code}: ${err.message}`);
      throw err;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      this.inflight.delete(ac);
      if (acquired) this.release();
      this.scheduleIdleOff();
    }
  }

  private mapError(e: unknown, signal: AbortSignal): ForerunnerError {
    if (e instanceof ForerunnerError) return e;
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof ForerunnerError) return reason;
      return desktopDenial(
        this.gate.revoked ? "revoked" : "killed",
        this.gate.revoked ? `desktop control was revoked: ${this.gate.reason}` : "run stopped",
      );
    }
    return new ForerunnerError("internal", e instanceof Error ? e.message : String(e), {
      cause: e,
    });
  }

  private acquire(identity: DesktopIdentity): Promise<void> {
    if (!this.running) {
      this.running = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ identity, resolve, reject });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.running = false;
  }

  private async stopAll(
    scope: KillScope | "all",
    reason: string,
    kind: "revoked" | "killed",
  ): Promise<DesktopRevokeReport> {
    const err = desktopDenial(
      kind,
      kind === "revoked" ? `desktop control was revoked: ${reason}` : `run stopped: ${reason}`,
    );
    let interrupted = 0;
    for (const [ac, identity] of [...this.inflight]) {
      if (!matchesScope(identity, scope)) continue;
      ac.abort(err);
      interrupted++;
    }
    const keep: Waiter[] = [];
    let dropped = 0;
    for (const w of this.waiters) {
      if (matchesScope(w.identity, scope)) {
        w.reject(err);
        dropped++;
      } else keep.push(w);
    }
    this.waiters = keep;
    if (scope === "all" || (this.inflight.size === 0 && this.waiters.length === 0)) {
      await this.indicatorOff(reason);
    }
    return { reason, interrupted, dropped };
  }

  /**
   * On before the action. While it is already on, a new `on` is sent only when what the banner
   * names changed (another session, or the application became known or changed), so the
   * shells never show a stale name; the same burst on the same app sends nothing more.
   */
  private async indicatorOnFor(identity: DesktopIdentity, target?: WindowInfo): Promise<void> {
    this.cancelIdle?.();
    this.cancelIdle = null;
    const app = target?.exe;
    const current = this.indicatorReason;
    if (
      this.indicatorActive &&
      current &&
      current.sessionId === identity.sessionId &&
      current.agentId === identity.agentId &&
      (app === undefined || app === current.app)
    ) {
      return;
    }
    const since = this.indicatorActive && current ? current.at : this.opts.clock.nowIso();
    const reason: IndicatorReason = {
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      runId: identity.runId,
      humanId: identity.humanId,
      ...(app !== undefined
        ? { app }
        : current?.app !== undefined && current.sessionId === identity.sessionId
          ? { app: current.app }
          : {}),
      message: "",
      at: since,
    };
    reason.message = `Forerunner agent ${identity.agentId} is controlling ${reason.app ?? "the desktop"}`;
    this.indicatorActive = true;
    this.indicatorReason = reason;
    await this.opts.indicator.on(reason);
  }

  private async indicatorOff(why: string): Promise<void> {
    this.cancelIdle?.();
    this.cancelIdle = null;
    if (!this.indicatorActive) return;
    this.indicatorActive = false;
    this.indicatorReason = null;
    await this.opts.indicator.off();
    this.logger.info("indicator off", { why });
  }

  private scheduleIdleOff(): void {
    if (!this.indicatorActive || this.running || this.inflight.size > 0) return;
    this.cancelIdle?.();
    this.cancelIdle = this.opts.clock.setTimeout(() => {
      this.cancelIdle = null;
      void this.indicatorOff("idle");
    }, this.opts.indicatorIdleMs ?? DEFAULT_INDICATOR_IDLE_MS);
  }

  private async audit(
    identity: DesktopIdentity,
    kind: DesktopActionKind | "revoke",
    inputSummary: string,
    resultSummary: string,
    allowed: boolean,
    deniedReason?: string,
  ): Promise<void> {
    await this.opts.audit.append({
      sessionId: identity.sessionId,
      runId: identity.runId,
      agentId: identity.agentId,
      humanId: identity.humanId,
      tool: `desktop_${kind}`,
      inputSummary: summarize(inputSummary),
      resultSummary: summarize(resultSummary),
      allowed,
      ...(deniedReason ? { deniedReason } : {}),
      costUsdMicro: 0,
      occurredAt: this.opts.clock.nowIso(),
      tokenId: identity.tokenId ?? "",
    });
  }
}
