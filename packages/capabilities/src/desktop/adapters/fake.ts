/**
 * Test adapter: records every call, holds actions on request (so a revoke can interrupt one),
 * and writes a tiny PNG for screenshots so paths exist.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, ForerunnerError } from "@forerunner/platform";
import { parseKey, validateText } from "../keys.ts";
import type { WindowInfo } from "../types.ts";
import {
  type AdapterCallOptions,
  abortError,
  type DesktopAdapter,
  type MouseButton,
  resolveWindow,
  type ScreenshotResult,
  validateClick,
} from "./types.ts";

export type FakeMethod =
  | "listWindows"
  | "activeWindow"
  | "focus"
  | "typeText"
  | "pressKey"
  | "click"
  | "screenshot";

export interface FakeCall {
  method: FakeMethod;
  args: unknown[];
}

/** 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export interface FakeDesktopAdapterOptions {
  windows?: WindowInfo[];
  active?: WindowInfo | null;
  onCall?: (call: FakeCall) => void;
}

export class FakeDesktopAdapter implements DesktopAdapter {
  readonly platform = "fake" as const;
  readonly calls: FakeCall[] = [];
  windows: WindowInfo[];
  active: WindowInfo | null;
  private holding = false;
  private waiters: Array<() => void> = [];
  disposed = false;

  constructor(private readonly opts: FakeDesktopAdapterOptions = {}) {
    this.windows = opts.windows ?? [];
    this.active = opts.active ?? null;
  }

  /** Every action from now on waits until release() or its signal aborts. */
  hold(): void {
    this.holding = true;
  }

  release(): void {
    this.holding = false;
    for (const w of this.waiters.splice(0)) w();
  }

  get held(): number {
    return this.waiters.length;
  }

  private record(method: FakeMethod, args: unknown[]): void {
    const call = { method, args };
    this.calls.push(call);
    this.opts.onCall?.(call);
  }

  private async action(method: FakeMethod, args: unknown[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    this.record(method, args);
    if (!this.holding) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(abortError(signal));
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async listWindows(opts?: AdapterCallOptions): Promise<WindowInfo[]> {
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    this.record("listWindows", []);
    return [...this.windows];
  }

  async activeWindow(opts?: AdapterCallOptions): Promise<WindowInfo | null> {
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    this.record("activeWindow", []);
    return this.active;
  }

  async focus(app: string | WindowInfo, opts?: AdapterCallOptions): Promise<WindowInfo> {
    const w = resolveWindow(this.windows, app);
    if (!w)
      throw new ForerunnerError(
        "not_found",
        `no window of ${typeof app === "string" ? app : app.id}`,
      );
    await this.action("focus", [w.id], opts?.signal);
    this.active = w;
    return w;
  }

  async typeText(text: string, opts?: AdapterCallOptions): Promise<void> {
    await this.action("typeText", [validateText(text)], opts?.signal);
  }

  async pressKey(key: string, opts?: AdapterCallOptions): Promise<void> {
    parseKey(key);
    await this.action("pressKey", [key], opts?.signal);
  }

  async click(
    x: number,
    y: number,
    opts?: AdapterCallOptions & { button?: MouseButton },
  ): Promise<void> {
    const button = validateClick(x, y, opts?.button);
    await this.action("click", [x, y, button], opts?.signal);
  }

  async screenshot(
    path: string,
    opts?: AdapterCallOptions & { window?: WindowInfo },
  ): Promise<ScreenshotResult> {
    await this.action("screenshot", [path, opts?.window?.id ?? null], opts?.signal);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, TINY_PNG);
    return { path, bytes: TINY_PNG.length };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
