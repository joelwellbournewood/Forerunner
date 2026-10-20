/**
 * The adapter contract: one implementation per platform, a fake for tests. Adapters run
 * processes with argv arrays through the platform runner (never a shell string) and know
 * nothing about gates, audit or the indicator; that is the controller's job.
 */
import { ForerunnerError, type RunOptions, type RunResult } from "@forerunner/platform";
import { appMatches } from "../allowlist.ts";
import type { WindowInfo } from "../types.ts";

export type MouseButton = "left" | "middle" | "right";
export const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];

export interface AdapterCallOptions {
  signal?: AbortSignal;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
}

export interface DesktopAdapter {
  readonly platform: "linux" | "windows" | "fake";
  listWindows(opts?: AdapterCallOptions): Promise<WindowInfo[]>;
  activeWindow(opts?: AdapterCallOptions): Promise<WindowInfo | null>;
  /** Bring a window to the front; `app` names an executable or class, or is a listed window. */
  focus(app: string | WindowInfo, opts?: AdapterCallOptions): Promise<WindowInfo>;
  typeText(text: string, opts?: AdapterCallOptions): Promise<void>;
  pressKey(key: string, opts?: AdapterCallOptions): Promise<void>;
  click(x: number, y: number, opts?: AdapterCallOptions & { button?: MouseButton }): Promise<void>;
  /** Save a PNG of `window` (or the whole screen when none) to `path`. */
  screenshot(
    path: string,
    opts?: AdapterCallOptions & { window?: WindowInfo },
  ): Promise<ScreenshotResult>;
  dispose?(): Promise<void>;
}

export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;
export type Which = (cmd: string) => Promise<string | null>;

export const MAX_COORDINATE = 32_767;

export function validateClick(x: number, y: number, button: MouseButton = "left"): MouseButton {
  for (const [name, v] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_COORDINATE) {
      throw new ForerunnerError(
        "validation",
        `${name} must be an integer between 0 and ${MAX_COORDINATE}`,
      );
    }
  }
  if (!MOUSE_BUTTONS.includes(button)) {
    throw new ForerunnerError("validation", `button must be one of ${MOUSE_BUTTONS.join(", ")}`);
  }
  return button;
}

/** The window a focus request names: by id for a listed window, by app for a name. */
export function resolveWindow(
  windows: readonly WindowInfo[],
  app: string | WindowInfo,
): WindowInfo | undefined {
  if (typeof app !== "string") return windows.find((w) => w.id === app.id) ?? app;
  return windows.find((w) => appMatches(w, app));
}

export function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "aborted");
}
