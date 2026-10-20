/**
 * The daemon's side of desktop control (spec L.4, S.32; ADR 0021, ADR 0039): the per-call
 * binding the gate decides on (the extension row's flag, the project's autonomy, the human's
 * allowlist), the indicator as a runtime bus event the shells render, and the adapter used
 * when this machine has no desktop tools, which refuses every action in code instead of
 * pretending one happened. Nothing here decides anything the gate does not check.
 */
import type { EventEmitter } from "node:events";
import { desktop } from "@forerunner/capabilities";
import { type Clock, ForerunnerError, log } from "@forerunner/platform";
import type { AuditLogRepo, ExtensionRow, StateStore } from "@forerunner/state";
import { ZodError } from "zod";
import type { ToolExecutionContext } from "../agent/tools.ts";
import { type AutonomyLevel, isValidAutonomyLevel } from "../enforcement/autonomy.ts";
import { ROW_STATUS_ERROR, ROW_STATUS_PENDING } from "../extensions/types.ts";

/** Runtime bus event (and `/events` frame) of the on-screen indicator: `{ on, ...reason }`. */
export const DESKTOP_INDICATOR_EVENT = "desktop.indicator";

export interface DesktopIndicatorPayload {
  on: boolean;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  humanId?: string;
  app?: string;
  message?: string;
  at?: string;
}

/**
 * The indicator port over the runtime bus: every attached shell receives the frame and shows
 * (or hides) its banner. The controller keeps the call order (on before the first action, off
 * after the last); a shell that is not attached misses nothing it could have shown.
 */
export class BusIndicator implements desktop.Indicator {
  constructor(private readonly events: Pick<EventEmitter, "emit">) {}
  on(reason: desktop.IndicatorReason): void {
    const payload: DesktopIndicatorPayload = { on: true, ...reason };
    this.events.emit(DESKTOP_INDICATOR_EVENT, payload);
  }
  off(): void {
    const payload: DesktopIndicatorPayload = { on: false };
    this.events.emit(DESKTOP_INDICATOR_EVENT, payload);
  }
}

/**
 * The adapter when detection found no usable desktop (no display, missing tools, an
 * unsupported platform): every action is refused with `not_supported` naming what is missing.
 * The gate still runs first, so a disabled capability or a low autonomy level is reported as
 * such, and the refusal is an audit row like any other denial.
 */
export class UnavailableDesktopAdapter implements desktop.DesktopAdapter {
  readonly platform: desktop.DesktopAdapter["platform"];
  constructor(private readonly detection: Pick<desktop.AdapterDetection, "platform" | "missing">) {
    this.platform =
      detection.platform === "linux" || detection.platform === "windows"
        ? detection.platform
        : "fake";
  }
  private refuse(): never {
    throw new ForerunnerError(
      "not_supported",
      `desktop control is not available on this machine: ${this.detection.missing.join("; ") || "no adapter"}`,
      { details: { missing: [...this.detection.missing] } },
    );
  }
  async listWindows(): Promise<desktop.WindowInfo[]> {
    return this.refuse();
  }
  async activeWindow(): Promise<desktop.WindowInfo | null> {
    return this.refuse();
  }
  async focus(): Promise<desktop.WindowInfo> {
    return this.refuse();
  }
  async typeText(): Promise<void> {
    return this.refuse();
  }
  async pressKey(): Promise<void> {
    return this.refuse();
  }
  async click(): Promise<void> {
    return this.refuse();
  }
  async screenshot(): Promise<desktop.ScreenshotResult> {
    return this.refuse();
  }
}

/** Audit row of an allowlist file that could not be read (allowed=false, one per refused read). */
export const DESKTOP_ALLOWLIST_READ_TOOL = "desktop_allowlist.read";

export interface GuardedAllowlistDeps {
  audit: Pick<AuditLogRepo, "append">;
  clock: Clock;
}

/**
 * The allowlist store behind the daemon's binding and routes, with the one failure the
 * module's file store reports without a stable code made one: a hand-edited
 * `<config>/desktop-allowlist.json` that is not JSON, or not an allowlist. The file store's
 * `JSON.parse` (or its schema) throws a plain error, which would reach the tools and the
 * routes as `internal` carrying the parser's message. Here it is `validation` naming the file
 * to fix, with one `desktop_allowlist.read` audit row (allowed=false) and a warning; the
 * parser's message stays out of all three (the file holds no secrets, but a parser's snippet
 * is content, not a code). The tools fail closed: no binding is built from a file that did
 * not read, and the next call reads the file again, so a fix needs no restart. A write maps
 * only the read before it; the store's own rule on the entries (a `ZodError` for an empty
 * name, say) and any `ForerunnerError` pass through unchanged.
 */
export class GuardedAllowlistStore implements desktop.DesktopAllowlistStore {
  private readonly logger = log("desktop");
  constructor(
    private readonly inner: desktop.DesktopAllowlistStore,
    /** The file the store reads, for the error, the audit row and the log line. */
    readonly file: string,
    private readonly deps: GuardedAllowlistDeps,
  ) {}
  get(humanId: string): Promise<desktop.DesktopAllowEntry[]> {
    return this.guard(humanId, "read", () => this.inner.get(humanId));
  }
  set(humanId: string, entries: desktop.DesktopAllowlist): Promise<desktop.DesktopAllowEntry[]> {
    return this.guard(humanId, "write", () => this.inner.set(humanId, entries));
  }
  private async guard<T>(humanId: string, op: "read" | "write", body: () => Promise<T>) {
    try {
      return await body();
    } catch (e) {
      if (e instanceof ForerunnerError) throw e;
      const why =
        e instanceof SyntaxError
          ? "is not valid JSON"
          : op === "read" && isZodError(e)
            ? "does not hold a valid allowlist (an object keyed by human id, each a list of app, exe or class entries)"
            : null;
      if (why === null) throw e;
      const message = `${this.file} ${why}; fix or remove the file`;
      this.logger.warn("desktop allowlist unreadable; every desktop action is refused", {
        file: this.file,
        why,
      });
      await this.deps.audit.append({
        tool: DESKTOP_ALLOWLIST_READ_TOOL,
        allowed: false,
        human_id: humanId,
        input_summary: this.file,
        result_summary: "every desktop action refused until the file reads",
        denied_reason: `validation: ${message}`,
        occurred_at: this.deps.clock.nowIso(),
      });
      throw new ForerunnerError("validation", message, { cause: e, details: { file: this.file } });
    }
  }
}

function isZodError(e: unknown): boolean {
  return e instanceof ZodError || (e instanceof Error && e.name === "ZodError");
}

/** The extension row's flag as the gate reads it: installed, enabled, neither pending nor errored. */
export function extensionRowEnabled(row: ExtensionRow | undefined): boolean {
  if (!row) return false;
  return row.enabled && row.status !== ROW_STATUS_PENDING && row.status !== ROW_STATUS_ERROR;
}

export interface DesktopBindingDeps {
  extensions: Pick<StateStore["extension"], "byName">;
  projects: { get(id: string): Promise<{ autonomy_level: number } | undefined> };
  humans: { get(id: string): Promise<{ default_autonomy: number } | undefined> };
  allowlist: desktop.DesktopAllowlistStore;
}

/**
 * The binding per tool call: `enabled` from the `desktop-control` extension row (off until a
 * human installs and enables it in the panel), `autonomy` from the run's project (the human's
 * default when the run has no project; 0 when neither exists), the human's allowlist from the
 * store. Screenshots never enter the model context: the runtime does not forward image
 * artifacts (desktop-control.md, Known issues), so no token claims them.
 */
export function desktopBindingResolver(deps: DesktopBindingDeps): desktop.DesktopBindingResolver {
  return async (ctx: ToolExecutionContext): Promise<desktop.DesktopRunBinding> => {
    const row = await deps.extensions.byName("capability", desktop.DESKTOP_CAPABILITY_NAME);
    const project = ctx.projectId ? await deps.projects.get(ctx.projectId) : undefined;
    const level = project
      ? project.autonomy_level
      : ((await deps.humans.get(ctx.humanId))?.default_autonomy ?? 0);
    const autonomy: AutonomyLevel = isValidAutonomyLevel(level) ? level : 0;
    return {
      enabled: extensionRowEnabled(row),
      autonomy,
      allowlist: await deps.allowlist.get(ctx.humanId),
      screenshotsToModel: false,
    };
  };
}
