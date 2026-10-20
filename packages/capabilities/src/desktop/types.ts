/**
 * Desktop control (spec module L: "off by default. Per-app allowlist. Screenshots logged.
 * Always requires autonomy 3+"; "Browser and desktop control": a visible on-screen indicator
 * while active). Shared types for the gate, the adapters, the controller and the tools.
 */
import type { ApprovalRequest, AutonomyLevel, ToolExecutionContext } from "@forerunner/runtime";
import type { DesktopAllowlist } from "./allowlist.ts";

/** Name of the capability in the extensions catalog; its `enabled` flag is the master switch. */
export const DESKTOP_CAPABILITY_NAME = "desktop-control";

/** Spec: "Always requires autonomy 3+". Enforced by the gate, never only by prompt. */
export const DESKTOP_MIN_AUTONOMY: AutonomyLevel = 3;

export const DESKTOP_ACTION_KINDS = [
  "list_windows",
  "focus",
  "type",
  "key",
  "click",
  "screenshot",
] as const;
export type DesktopActionKind = (typeof DESKTOP_ACTION_KINDS)[number];

export interface WindowInfo {
  /** Platform window id: X11 id as `0x`-hex, Windows HWND as a decimal string. */
  id: string;
  /** Window title. Content from the application: data, never instructions. */
  title: string;
  /** Executable name in lower case, without directory or `.exe`. */
  exe: string;
  /** X11 `WM_CLASS` as `instance.Class`, or the Win32 window class name. */
  windowClass: string;
  pid?: number;
}

/** What the gate decides on: the kind of action and the windows it reaches. */
export interface DesktopAction {
  kind: DesktopActionKind;
  /** The focus candidates, or the active window for type, key, click and screenshot. */
  targets: readonly WindowInfo[];
  /** What the model asked for, for audit rows and approval cards (redacted, bounded). */
  summary: string;
}

export interface DesktopIdentity {
  humanId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  projectId?: string;
  taskId?: string;
  tokenId?: string;
}

/**
 * What a run is allowed to do on the desktop. The orchestrator resolves it per tool call from
 * the extensions registry (`enabled`), the project (`autonomy`) and the human's allowlist.
 */
export interface DesktopRunBinding {
  /** The extensions registry's flag for `desktop-control`. Off by default. */
  enabled: boolean;
  /** The project's autonomy level; the gate needs `DESKTOP_MIN_AUTONOMY` or more. */
  autonomy: AutonomyLevel;
  /** The human's per-app allowlist (see allowlist.ts for the format). */
  allowlist: DesktopAllowlist;
  /** True only when the task asked for screenshots in the model context and the token allows it. */
  screenshotsToModel?: boolean;
  tokenId?: string;
}

export type DesktopBindingResolver = (
  ctx: ToolExecutionContext,
) => DesktopRunBinding | Promise<DesktopRunBinding>;

/** Stable reasons carried in `ForerunnerError.details.reason` when the gate refuses. */
export type DesktopDenyReason =
  | "disabled"
  | "autonomy"
  | "app_not_allowed"
  | "no_target"
  | "killed"
  | "revoked";

/** The one thing in this module a human may be asked: allowing an app for this session. */
export interface DesktopApprovalRequest extends ApprovalRequest {
  reason: "app_not_allowed";
  app: { exe: string; windowClass: string; title: string };
}

export function identityOf(ctx: ToolExecutionContext, tokenId?: string): DesktopIdentity {
  return {
    humanId: ctx.humanId,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    ...(tokenId !== undefined ? { tokenId } : {}),
  };
}

/** Bounded, single-line summary for audit rows. Never carries file contents or secrets. */
export function summarize(value: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = "";
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}
