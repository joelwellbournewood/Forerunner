/**
 * Linux adapter: X11 (and XWayland) through `xdotool` and `wmctrl`, screenshots through
 * ImageMagick `import`, `scrot` or `gnome-screenshot`, whichever is installed (ADR 0021).
 * Every call is an argv array through the platform runner; the model's text is one argument
 * after `--`, never part of a command string.
 */
import { readFile, stat } from "node:fs/promises";
import {
  ForerunnerError,
  join,
  type RunOptions,
  type RunResult,
  run as runProcess,
  ShellError,
} from "@forerunner/platform";
import { parseKey, toXdotoolKey, validateText } from "../keys.ts";
import type { WindowInfo } from "../types.ts";
import {
  type AdapterCallOptions,
  abortError,
  type DesktopAdapter,
  type MouseButton,
  type Runner,
  resolveWindow,
  type ScreenshotResult,
  validateClick,
  type Which,
} from "./types.ts";

export type LinuxScreenshotTool = "import" | "scrot" | "gnome-screenshot";
export const LINUX_SCREENSHOT_TOOLS: readonly LinuxScreenshotTool[] = [
  "import",
  "scrot",
  "gnome-screenshot",
];
export const LINUX_REQUIRED_TOOLS = ["xdotool", "wmctrl"] as const;

export interface LinuxScreenshotter {
  tool: LinuxScreenshotTool;
  path: string;
}

export interface LinuxTools {
  xdotool: string;
  wmctrl: string;
  screenshot: LinuxScreenshotter;
}

export interface LinuxToolDetection {
  tools: LinuxTools | null;
  found: Record<string, string>;
  missing: string[];
}

export async function detectLinuxTools(which: Which): Promise<LinuxToolDetection> {
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const tool of LINUX_REQUIRED_TOOLS) {
    const p = await which(tool);
    if (p) found[tool] = p;
    else missing.push(tool);
  }
  let screenshot: LinuxScreenshotter | null = null;
  for (const tool of LINUX_SCREENSHOT_TOOLS) {
    const p = await which(tool);
    if (!p) continue;
    found[tool] = p;
    screenshot ??= { tool, path: p };
  }
  if (!screenshot) missing.push(`a screenshot tool (${LINUX_SCREENSHOT_TOOLS.join(", ")})`);
  const xdotool = found.xdotool;
  const wmctrl = found.wmctrl;
  const tools = xdotool && wmctrl && screenshot ? { xdotool, wmctrl, screenshot } : null;
  return { tools, found, missing };
}

const XDOTOOL_BUTTON: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };

/** Pure argv builders; the unit tests check them and that none of them is a shell. */
export const linuxArgv = {
  listWindows: (wmctrl: string): string[] => [wmctrl, "-l", "-p", "-x"],
  activeWindow: (xdotool: string): string[] => [xdotool, "getactivewindow"],
  activate: (xdotool: string, windowId: string): string[] => [
    xdotool,
    "windowactivate",
    "--sync",
    windowId,
  ],
  type: (xdotool: string, text: string, delayMs: number): string[] => [
    xdotool,
    "type",
    "--clearmodifiers",
    "--delay",
    String(delayMs),
    "--",
    text,
  ],
  key: (xdotool: string, key: string): string[] => [xdotool, "key", "--clearmodifiers", "--", key],
  click: (xdotool: string, x: number, y: number, button: MouseButton): string[] => [
    xdotool,
    "mousemove",
    "--sync",
    String(x),
    String(y),
    "click",
    XDOTOOL_BUTTON[button],
  ],
  screenshot: (shot: LinuxScreenshotter, file: string, windowId?: string): string[] => {
    switch (shot.tool) {
      case "import":
        return [shot.path, "-window", windowId ?? "root", file];
      case "scrot":
        return windowId
          ? [shot.path, "--focused", "--overwrite", file]
          : [shot.path, "--overwrite", file];
      case "gnome-screenshot":
        return windowId ? [shot.path, "--window", "--file", file] : [shot.path, "--file", file];
    }
  },
};

/** `wmctrl -l -p -x`: `<id> <desktop> <pid> <instance.Class> <host> <title...>`. */
export function parseWmctrlLine(line: string): (Omit<WindowInfo, "exe"> & { pid: number }) | null {
  const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trimEnd());
  if (!m?.[1] || !m[3] || !m[4]) return null;
  return {
    id: m[1].toLowerCase(),
    pid: Number(m[3]),
    windowClass: m[4] === "N/A" ? "" : m[4],
    title: m[6] ?? "",
  };
}

/** xdotool prints window ids in decimal; wmctrl in 8-digit hex. */
export function hexWindowId(decimal: string): string {
  const n = Number(decimal.trim());
  if (!Number.isInteger(n) || n < 0) return decimal.trim().toLowerCase();
  return `0x${n.toString(16).padStart(8, "0")}`;
}

export interface LinuxAdapterOptions {
  tools: LinuxTools;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  /** Executable name for a pid; defaults to reading `/proc/<pid>/comm`. */
  readComm?: (pid: number) => Promise<string | null>;
  /** Delay between typed characters in ms (xdotool `--delay`). */
  typeDelayMs?: number;
  timeoutMs?: number;
}

async function defaultReadComm(pid: number): Promise<string | null> {
  try {
    return (await readFile(join("/proc", String(pid), "comm"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export class LinuxDesktopAdapter implements DesktopAdapter {
  readonly platform = "linux" as const;
  private readonly run: Runner;
  private readonly readComm: (pid: number) => Promise<string | null>;

  constructor(private readonly opts: LinuxAdapterOptions) {
    this.run = opts.run ?? runProcess;
    this.readComm = opts.readComm ?? defaultReadComm;
  }

  private async exec(argv: string[], what: string, opts?: AdapterCallOptions): Promise<RunResult> {
    const runOpts: RunOptions = {
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      maxOutputBytes: 1024 * 1024,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    };
    try {
      return await this.run(argv, runOpts);
    } catch (e) {
      if (opts?.signal?.aborted) throw abortError(opts.signal);
      if (e instanceof ShellError) {
        throw new ForerunnerError(
          e.result.timedOut ? "timeout" : "internal",
          `${what} failed (${argv[0]}): ${e.result.stderr.trim().slice(-300) || `exit ${e.result.code}`}`,
          { details: { tool: argv[0] } },
        );
      }
      throw e;
    }
  }

  async listWindows(opts?: AdapterCallOptions): Promise<WindowInfo[]> {
    const r = await this.exec(
      linuxArgv.listWindows(this.opts.tools.wmctrl),
      "listing windows",
      opts,
    );
    const out: WindowInfo[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const w = parseWmctrlLine(line);
      if (!w) continue;
      const comm = await this.readComm(w.pid);
      const instance = w.windowClass.split(".")[0] ?? "";
      out.push({ ...w, exe: (comm ?? instance).toLowerCase() });
    }
    return out;
  }

  async activeWindow(opts?: AdapterCallOptions): Promise<WindowInfo | null> {
    const r = await this.run(linuxArgv.activeWindow(this.opts.tools.xdotool), {
      allowFailure: true,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    if (r.code !== 0) return null;
    const id = hexWindowId(r.stdout.trim());
    const windows = await this.listWindows(opts);
    return windows.find((w) => w.id === id) ?? null;
  }

  async focus(app: string | WindowInfo, opts?: AdapterCallOptions): Promise<WindowInfo> {
    const windows = await this.listWindows(opts);
    const w = resolveWindow(windows, app);
    if (!w) {
      throw new ForerunnerError(
        "not_found",
        `no window of ${typeof app === "string" ? app : app.id}`,
      );
    }
    await this.exec(
      linuxArgv.activate(this.opts.tools.xdotool, w.id),
      "activating the window",
      opts,
    );
    return w;
  }

  async typeText(text: string, opts?: AdapterCallOptions): Promise<void> {
    const clean = validateText(text);
    await this.exec(
      linuxArgv.type(this.opts.tools.xdotool, clean, this.opts.typeDelayMs ?? 12),
      "typing",
      opts,
    );
  }

  async pressKey(key: string, opts?: AdapterCallOptions): Promise<void> {
    const parsed = parseKey(key);
    await this.exec(
      linuxArgv.key(this.opts.tools.xdotool, toXdotoolKey(parsed)),
      "pressing a key",
      opts,
    );
  }

  async click(
    x: number,
    y: number,
    opts?: AdapterCallOptions & { button?: MouseButton },
  ): Promise<void> {
    const button = validateClick(x, y, opts?.button);
    await this.exec(linuxArgv.click(this.opts.tools.xdotool, x, y, button), "clicking", opts);
  }

  async screenshot(
    path: string,
    opts?: AdapterCallOptions & { window?: WindowInfo },
  ): Promise<ScreenshotResult> {
    await this.exec(
      linuxArgv.screenshot(this.opts.tools.screenshot, path, opts?.window?.id),
      "taking a screenshot",
      opts,
    );
    const s = await stat(path);
    return { path, bytes: s.size };
  }
}
