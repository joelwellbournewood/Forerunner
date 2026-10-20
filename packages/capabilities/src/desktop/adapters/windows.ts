/**
 * Windows adapter: PowerShell scripts for window enumeration (Get-Process plus user32 for the
 * foreground window and class), AppActivate / SetForegroundWindow for focus, SendKeys for
 * typing and key presses, user32 for clicks and System.Drawing for screenshots (ADR 0021).
 * Each script is written once to a private temp directory and invoked with `-File <path>`
 * and positional arguments; the model's text reaches the script only as a base64 argument,
 * so no value is ever spliced into script text or parsed as a parameter.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  ForerunnerError,
  join,
  type RunOptions,
  type RunResult,
  run as runProcess,
  ShellError,
} from "@forerunner/platform";
import { type NamedKey, type ParsedKey, parseKey, validateText } from "../keys.ts";
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
} from "./types.ts";

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const USER32_WINDOWS = lines(
  'Add-Type -TypeDefinition @"',
  "using System;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "public static class FrWin {",
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  "}",
  '"@',
);

/** The scripts, by file name. ASCII only (PowerShell 5.1 reads BOM-less files as ANSI). */
export const WINDOWS_SCRIPTS = {
  "list-windows.ps1": lines(
    "$ErrorActionPreference = 'Stop'",
    USER32_WINDOWS.trimEnd(),
    "$fg = [FrWin]::GetForegroundWindow()",
    "$rows = @()",
    "foreach ($p in Get-Process) {",
    "  if ($p.MainWindowHandle -eq 0) { continue }",
    "  $sb = New-Object System.Text.StringBuilder 256",
    "  [void][FrWin]::GetClassName($p.MainWindowHandle, $sb, 256)",
    "  $rows += [pscustomobject]@{ id = [string]$p.MainWindowHandle; pid = $p.Id; exe = $p.ProcessName; windowClass = $sb.ToString(); title = $p.MainWindowTitle; active = ($p.MainWindowHandle -eq $fg) }",
    "}",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 3",
  ),
  "focus.ps1": lines(
    "param([int]$TargetPid, [string]$Handle)",
    "$ErrorActionPreference = 'Stop'",
    USER32_WINDOWS.trimEnd(),
    "$shell = New-Object -ComObject WScript.Shell",
    "$ok = $shell.AppActivate($TargetPid)",
    "if (-not $ok -and $Handle -ne '0') {",
    "  $h = [IntPtr]::new([int64]$Handle)",
    "  [void][FrWin]::ShowWindow($h, 9)",
    "  $ok = [FrWin]::SetForegroundWindow($h)",
    "}",
    "if (-not $ok) { Write-Error ('could not activate process ' + $TargetPid); exit 3 }",
  ),
  "send-keys.ps1": lines(
    "param([string]$KeysBase64)",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$keys = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($KeysBase64))",
    "[System.Windows.Forms.SendKeys]::SendWait($keys)",
  ),
  "click.ps1": lines(
    "param([int]$X, [int]$Y, [string]$Button)",
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class FrMouse {",
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
    "}",
    '"@',
    "[void][FrMouse]::SetCursorPos($X, $Y)",
    "Start-Sleep -Milliseconds 30",
    "switch ($Button) {",
    "  'right' { $down = 0x0008; $up = 0x0010 }",
    "  'middle' { $down = 0x0020; $up = 0x0040 }",
    "  default { $down = 0x0002; $up = 0x0004 }",
    "}",
    "[FrMouse]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)",
    "[FrMouse]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)",
  ),
  "screenshot.ps1": lines(
    "param([string]$PathBase64, [string]$Handle)",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Windows.Forms",
    'Add-Type -TypeDefinition @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public struct FrRect { public int Left; public int Top; public int Right; public int Bottom; }",
    "public static class FrShot {",
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out FrRect rect);',
    "}",
    '"@',
    "$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathBase64))",
    "if ($Handle -ne '0') {",
    "  $r = New-Object FrRect",
    "  if (-not [FrShot]::GetWindowRect([IntPtr]::new([int64]$Handle), [ref]$r)) { Write-Error 'window not found'; exit 3 }",
    "  $left = $r.Left; $top = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top",
    "} else {",
    "  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "  $left = $b.Left; $top = $b.Top; $w = $b.Width; $h = $b.Height",
    "}",
    "if ($w -le 0 -or $h -le 0) { Write-Error 'empty capture area'; exit 3 }",
    "$bmp = New-Object System.Drawing.Bitmap $w, $h",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)",
    "$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$g.Dispose(); $bmp.Dispose()",
  ),
} as const;

export type WindowsScriptName = keyof typeof WINDOWS_SCRIPTS;

/** The argv for one script run: the interpreter, fixed flags, `-File <path>`, the arguments. */
export function windowsArgv(
  powershell: string,
  scriptPath: string,
  args: readonly string[] = [],
): string[] {
  return [
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ];
}

export function base64Arg(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

const SENDKEYS_SPECIAL = new Set(["+", "^", "%", "~", "(", ")", "{", "}", "[", "]"]);

/** SendKeys text: every control character of its grammar wrapped in braces, newlines as ENTER. */
export function escapeSendKeys(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n") out += "{ENTER}";
    else if (ch === "\t") out += "{TAB}";
    else if (SENDKEYS_SPECIAL.has(ch)) out += `{${ch}}`;
    else out += ch;
  }
  return out;
}

const SENDKEYS_NAMED: Record<NamedKey, string> = {
  Return: "{ENTER}",
  Tab: "{TAB}",
  Escape: "{ESC}",
  BackSpace: "{BACKSPACE}",
  Delete: "{DELETE}",
  Insert: "{INSERT}",
  Home: "{HOME}",
  End: "{END}",
  Page_Up: "{PGUP}",
  Page_Down: "{PGDN}",
  Up: "{UP}",
  Down: "{DOWN}",
  Left: "{LEFT}",
  Right: "{RIGHT}",
  space: " ",
  F1: "{F1}",
  F2: "{F2}",
  F3: "{F3}",
  F4: "{F4}",
  F5: "{F5}",
  F6: "{F6}",
  F7: "{F7}",
  F8: "{F8}",
  F9: "{F9}",
  F10: "{F10}",
  F11: "{F11}",
  F12: "{F12}",
};

/** `ctrl+shift+s` -> `^+s`, `alt+F4` -> `%{F4}`. The Windows key is outside SendKeys. */
export function toSendKeys(k: ParsedKey): string {
  let prefix = "";
  for (const m of k.modifiers) {
    if (m === "ctrl") prefix += "^";
    else if (m === "alt") prefix += "%";
    else if (m === "shift") prefix += "+";
    else
      throw new ForerunnerError(
        "not_supported",
        "the super/Windows key cannot be sent with SendKeys",
      );
  }
  const key = k.named ? SENDKEYS_NAMED[k.key as NamedKey] : escapeSendKeys(k.key);
  return `${prefix}${key}`;
}

export interface WindowsAdapterOptions {
  /** Path of powershell.exe (or pwsh.exe) as `which()` found it. */
  powershell: string;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  /** Where the scripts are written; default a fresh directory under the OS temp dir. */
  scriptDir?: string;
  timeoutMs?: number;
}

interface RawWindow {
  id?: unknown;
  pid?: unknown;
  exe?: unknown;
  windowClass?: unknown;
  title?: unknown;
  active?: unknown;
}

export function parseWindowsList(stdout: string): Array<WindowInfo & { active: boolean }> {
  const text = stdout.trim();
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ForerunnerError("internal", "window list was not JSON");
  }
  const items: RawWindow[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: Array<WindowInfo & { active: boolean }> = [];
  for (const it of items) {
    if (it.id === undefined || it.id === null) continue;
    out.push({
      id: String(it.id),
      pid: typeof it.pid === "number" ? it.pid : undefined,
      exe: String(it.exe ?? "")
        .replace(/\.exe$/i, "")
        .toLowerCase(),
      windowClass: String(it.windowClass ?? ""),
      title: String(it.title ?? ""),
      active: it.active === true,
    });
  }
  return out;
}

export class WindowsDesktopAdapter implements DesktopAdapter {
  readonly platform = "windows" as const;
  private readonly run: Runner;
  private dir: string | null = null;
  private readonly written = new Set<WindowsScriptName>();

  constructor(private readonly opts: WindowsAdapterOptions) {
    this.run = opts.run ?? runProcess;
  }

  /** Where the scripts live; created on first use. Exposed for the tests. */
  scriptPath(name: WindowsScriptName): string {
    if (this.dir === null) {
      this.dir = this.opts.scriptDir ?? mkdtempSync(join(tmpdir(), "forerunner-desktop-"));
    }
    const path = join(this.dir, name);
    if (!this.written.has(name)) {
      writeFileSync(path, `﻿${WINDOWS_SCRIPTS[name]}`, "utf8");
      this.written.add(name);
    }
    return path;
  }

  private async ps(
    name: WindowsScriptName,
    args: readonly string[],
    what: string,
    opts?: AdapterCallOptions,
  ): Promise<RunResult> {
    const argv = windowsArgv(this.opts.powershell, this.scriptPath(name), args);
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
          `${what} failed (${name}): ${e.result.stderr.trim().slice(-300) || `exit ${e.result.code}`}`,
          { details: { script: name } },
        );
      }
      throw e;
    }
  }

  private async listWithActive(opts?: AdapterCallOptions) {
    const r = await this.ps("list-windows.ps1", [], "listing windows", opts);
    return parseWindowsList(r.stdout);
  }

  async listWindows(opts?: AdapterCallOptions): Promise<WindowInfo[]> {
    return (await this.listWithActive(opts)).map(({ active: _active, ...w }) => w);
  }

  async activeWindow(opts?: AdapterCallOptions): Promise<WindowInfo | null> {
    const hit = (await this.listWithActive(opts)).find((w) => w.active);
    if (!hit) return null;
    const { active: _active, ...w } = hit;
    return w;
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
    await this.ps("focus.ps1", [String(w.pid ?? 0), w.id || "0"], "activating the window", opts);
    return w;
  }

  async typeText(text: string, opts?: AdapterCallOptions): Promise<void> {
    const keys = escapeSendKeys(validateText(text));
    await this.ps("send-keys.ps1", [base64Arg(keys)], "typing", opts);
  }

  async pressKey(key: string, opts?: AdapterCallOptions): Promise<void> {
    const keys = toSendKeys(parseKey(key));
    await this.ps("send-keys.ps1", [base64Arg(keys)], "pressing a key", opts);
  }

  async click(
    x: number,
    y: number,
    opts?: AdapterCallOptions & { button?: MouseButton },
  ): Promise<void> {
    const button = validateClick(x, y, opts?.button);
    await this.ps("click.ps1", [String(x), String(y), button], "clicking", opts);
  }

  async screenshot(
    path: string,
    opts?: AdapterCallOptions & { window?: WindowInfo },
  ): Promise<ScreenshotResult> {
    await this.ps(
      "screenshot.ps1",
      [base64Arg(path), opts?.window?.id || "0"],
      "taking a screenshot",
      opts,
    );
    const s = await stat(path);
    return { path, bytes: s.size };
  }

  async dispose(): Promise<void> {
    if (this.dir !== null && this.opts.scriptDir === undefined) {
      rmSync(this.dir, { recursive: true, force: true });
    }
    this.dir = null;
    this.written.clear();
  }
}
