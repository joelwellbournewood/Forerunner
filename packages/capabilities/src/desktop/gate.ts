/**
 * The desktop gate, enforced in code before every action (spec L, "Browser and desktop
 * control", Phase 6 "Desktop control behind autonomy 3+"). Four conditions, all required:
 * the capability is enabled (off by default; the extensions registry owns the flag), the
 * project's autonomy level is 3 or more, every window the action reaches belongs to an
 * application on the human's allowlist, and the run is neither killed nor revoked. A prompt may
 * ask; only this code can allow.
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { AutonomyLevel } from "@forerunner/runtime";
import { describeEntry, windowAllowed } from "./allowlist.ts";
import type { DesktopApprovalPort } from "./approvals.ts";
import {
  DESKTOP_MIN_AUTONOMY,
  type DesktopAction,
  type DesktopDenyReason,
  type DesktopIdentity,
  type DesktopRunBinding,
  type WindowInfo,
} from "./types.ts";

export interface DesktopGateContext {
  identity: DesktopIdentity;
  binding: DesktopRunBinding;
  /** The run's signal is aborted or the kill switch froze this scope. */
  killed: boolean;
}

export interface DesktopGateDeps {
  clock: Clock;
  /** Optional: ask the human to allow an app for this session. Without it the gate refuses. */
  approvals?: DesktopApprovalPort;
}

/** Codes are the platform's stable set; the reason is in `details.reason`. */
export function desktopDenial(
  reason: DesktopDenyReason,
  message: string,
  details: Record<string, unknown> = {},
): ForerunnerError {
  const code =
    reason === "autonomy"
      ? "autonomy_insufficient"
      : reason === "killed"
        ? "killed"
        : "tool_not_allowed";
  return new ForerunnerError(code, message, { details: { gate: "desktop", reason, ...details } });
}

export function isDesktopDenial(e: unknown, reason?: DesktopDenyReason): e is ForerunnerError {
  return (
    e instanceof ForerunnerError &&
    e.details.gate === "desktop" &&
    (reason === undefined || e.details.reason === reason)
  );
}

export class DesktopGate {
  private revokedReason: string | null = null;
  /** Apps a human allowed for a session through the approval port: `<sessionId>:<exe>|<class>`. */
  private readonly sessionAllowed = new Set<string>();

  constructor(private readonly deps: DesktopGateDeps) {}

  get revoked(): boolean {
    return this.revokedReason !== null;
  }

  get reason(): string | null {
    return this.revokedReason;
  }

  /** After revoke() every check refuses until resume(). The controller also stops in-flight work. */
  revoke(reason = "desktop control revoked"): void {
    this.revokedReason = reason;
    this.sessionAllowed.clear();
  }

  resume(): void {
    this.revokedReason = null;
  }

  static minAutonomy(): AutonomyLevel {
    return DESKTOP_MIN_AUTONOMY;
  }

  /**
   * The conditions that need no window: kill state, revocation, the enabled flag, autonomy.
   * The controller runs this before touching the desktop; check() runs it again.
   */
  checkStatic(ctx: DesktopGateContext): void {
    const base = { runId: ctx.identity.runId, sessionId: ctx.identity.sessionId };
    if (ctx.killed) {
      throw desktopDenial("killed", "run stopped by the kill switch", base);
    }
    if (this.revokedReason !== null) {
      throw desktopDenial("revoked", `desktop control was revoked: ${this.revokedReason}`, base);
    }
    if (!ctx.binding.enabled) {
      throw desktopDenial(
        "disabled",
        "desktop control is off; a human enables it in the Extensions panel",
        base,
      );
    }
    if (ctx.binding.autonomy < DESKTOP_MIN_AUTONOMY) {
      throw desktopDenial(
        "autonomy",
        `desktop control needs autonomy level ${DESKTOP_MIN_AUTONOMY}+ (this project is at ${ctx.binding.autonomy})`,
        { ...base, autonomy: ctx.binding.autonomy, required: DESKTOP_MIN_AUTONOMY },
      );
    }
  }

  async check(action: DesktopAction, ctx: DesktopGateContext): Promise<void> {
    this.checkStatic(ctx);
    const base = {
      action: action.kind,
      runId: ctx.identity.runId,
      sessionId: ctx.identity.sessionId,
    };
    if (action.kind === "list_windows") return;
    if (action.targets.length === 0) {
      throw desktopDenial(
        "no_target",
        action.kind === "focus"
          ? "no window of that application is open"
          : "no active window; focus an allowed application first",
        base,
      );
    }
    for (const w of action.targets) {
      if (windowAllowed(w, ctx.binding.allowlist)) continue;
      const key = `${ctx.identity.sessionId}:${w.exe}|${w.windowClass.toLowerCase()}`;
      if (this.sessionAllowed.has(key)) continue;
      const outcome = await this.askHuman(action, w, ctx);
      if (outcome === "approved") {
        this.sessionAllowed.add(key);
        continue;
      }
      throw desktopDenial(
        "app_not_allowed",
        outcome === "pending"
          ? `waiting for the human to allow ${w.exe} (${w.windowClass}) for this session`
          : `application ${w.exe} (${w.windowClass}) is not on the desktop allowlist` +
              (ctx.binding.allowlist.length
                ? `; allowed: ${ctx.binding.allowlist.map(describeEntry).join(", ")}`
                : "; the allowlist is empty"),
        { ...base, app: w.exe, windowClass: w.windowClass, pending: outcome === "pending" },
      );
    }
  }

  private async askHuman(
    action: DesktopAction,
    w: WindowInfo,
    ctx: DesktopGateContext,
  ): Promise<"approved" | "denied" | "pending"> {
    if (!this.deps.approvals) return "denied";
    const id = ctx.identity;
    return this.deps.approvals.ask({
      sessionId: id.sessionId,
      runId: id.runId,
      agentId: id.agentId,
      humanId: id.humanId,
      projectId: id.projectId,
      taskId: id.taskId,
      tool: `desktop_${action.kind}`,
      actionClass: "permission_change",
      risk: "high",
      why: `the agent wants to ${action.kind} in ${w.exe} (${w.windowClass}), which is not on your desktop allowlist`,
      input: { action: action.kind, summary: action.summary },
      reason: "app_not_allowed",
      app: { exe: w.exe, windowClass: w.windowClass, title: w.title },
    });
  }
}
