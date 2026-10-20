/**
 * Desktop channel. Every notification is emitted on the in-process bus; the daemon forwards it
 * as the SSE event `notification` and an attached shell shows the toast (ADR 0031). When no
 * shell is connected the channel falls back to the OS: `notify-send` on Linux, a PowerShell
 * toast on Windows. Both run through `run()` with argv arrays; the title and body reach
 * PowerShell through environment variables, never inside the script text.
 */
import {
  currentPlatform,
  errorMessage,
  type Platform,
  run as platformRun,
  which as platformWhich,
  type RunOptions,
} from "@forerunner/platform";
import type { RunFn, WhichFn } from "../../sandbox/types.ts";
import type { NotificationEmitter } from "../emitter.ts";
import { type Notification, type Urgency, urgencyOf } from "../types.ts";
import type { Channel, ChannelContext, ChannelResult } from "./types.ts";

export interface DesktopChannelOptions {
  emitter: NotificationEmitter;
  /** How many shells hold the event stream; default: listeners on the emitter. */
  shellsConnected?: () => number;
  platform?: Platform;
  run?: RunFn;
  which?: WhichFn;
  /** Windows AppUserModelID the toast is shown under; default: the PowerShell host's own. */
  appId?: string;
  /**
   * Fall back to the OS notifier (`notify-send`, a PowerShell toast) when no shell holds the
   * event stream. Default true; the orchestrator turns it off for a composition that has no
   * desktop (ADR 0038), and the channel then reports itself unavailable without a shell.
   */
  osFallback?: boolean;
  /** Limits for the OS tools. */
  maxTitleChars?: number;
  maxBodyChars?: number;
}

/** The PowerShell host's own AppUserModelID: toasts show without registering an app. */
export const DEFAULT_WINDOWS_TOAST_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export const TOAST_TITLE_ENV = "FORERUNNER_TOAST_TITLE";
export const TOAST_BODY_ENV = "FORERUNNER_TOAST_BODY";
export const TOAST_APP_ID_ENV = "FORERUNNER_TOAST_APP_ID";

/** Constant script: it reads the text from the environment, so no user text is interpolated. */
export const POWERSHELL_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  `$title = $env:${TOAST_TITLE_ENV}`,
  `$body = $env:${TOAST_BODY_ENV}`,
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$nodes = $template.GetElementsByTagName('text')",
  "$nodes.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null",
  "$nodes.Item(1).AppendChild($template.CreateTextNode($body)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:${TOAST_APP_ID_ENV}).Show($toast)`,
].join("; ");

const LINUX_URGENCY: Record<Urgency, string> = {
  info: "low",
  normal: "normal",
  urgent: "critical",
};

/** `notify-send` argv; options come before the two positional texts, so a leading "-" is safe. */
export function notifySendArgv(title: string, body: string, urgency: Urgency): string[] {
  return [
    "notify-send",
    "--app-name=Forerunner",
    `--urgency=${LINUX_URGENCY[urgency]}`,
    "--",
    title,
    body,
  ];
}

/** PowerShell argv; the texts travel in the environment (see `toastEnv`). */
export function powershellToastArgv(): string[] {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_TOAST_SCRIPT,
  ];
}

export function toastEnv(title: string, body: string, appId: string): Record<string, string> {
  return { [TOAST_TITLE_ENV]: title, [TOAST_BODY_ENV]: body, [TOAST_APP_ID_ENV]: appId };
}

function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export class DesktopChannel implements Channel {
  readonly name = "desktop" as const;
  private readonly platform: Platform;
  private readonly run: RunFn;
  private readonly which: WhichFn;
  private readonly toolPath = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: DesktopChannelOptions) {
    this.platform = opts.platform ?? currentPlatform();
    this.run = opts.run ?? platformRun;
    this.which = opts.which ?? platformWhich;
  }

  configured(): string | null {
    return null;
  }

  private shells(): number {
    return this.opts.shellsConnected?.() ?? this.opts.emitter.listenerCount("notification");
  }

  /** The OS tool path, probed once per process (a tool installed later needs a daemon restart). */
  private tool(cmd: string): Promise<string | null> {
    let p = this.toolPath.get(cmd);
    if (!p) {
      p = this.which(cmd).catch(() => null);
      this.toolPath.set(cmd, p);
    }
    return p;
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    const level = urgencyOf(n);
    const title = cut(n.title, this.opts.maxTitleChars ?? 200);
    const body = cut(n.body, this.opts.maxBodyChars ?? 1000);
    this.opts.emitter.emit("notification", {
      // The record id (matches GET /notifications/recent); a test send has none.
      id: ctx.recordId ?? n.dedupeKey,
      kind: n.kind,
      title,
      body,
      level,
      route: n.link,
      humanId: n.humanId,
      projectId: n.projectId ?? null,
    });
    if (this.shells() > 0) return { ok: true, detail: "shell" };
    if (this.opts.osFallback === false) {
      return { ok: false, reason: "no shell connected (OS notifier off)", retryable: false };
    }
    return this.osFallback(title, body, level);
  }

  private async osFallback(title: string, body: string, level: Urgency): Promise<ChannelResult> {
    if (this.platform === "linux") {
      const path = await this.tool("notify-send");
      if (!path) {
        return {
          ok: false,
          reason: "no shell connected and notify-send is not on PATH",
          retryable: false,
        };
      }
      return this.exec(notifySendArgv(title, body, level), {});
    }
    if (this.platform === "windows") {
      const path = await this.tool("powershell.exe");
      if (!path) {
        return {
          ok: false,
          reason: "no shell connected and powershell.exe is not on PATH",
          retryable: false,
        };
      }
      const env = toastEnv(title, body, this.opts.appId ?? DEFAULT_WINDOWS_TOAST_APP_ID);
      return this.exec(powershellToastArgv(), { env: { ...process.env, ...env } });
    }
    return {
      ok: false,
      reason: `no shell connected and no OS notifier for platform ${this.platform}`,
      retryable: false,
    };
  }

  private async exec(argv: string[], opts: RunOptions): Promise<ChannelResult> {
    try {
      const r = await this.run(argv, { ...opts, timeoutMs: 15_000, allowFailure: true });
      if (r.code === 0) return { ok: true, detail: argv[0] ?? null };
      return {
        ok: false,
        reason: `${argv[0]} exited ${r.timedOut ? "by timeout" : r.code}: ${r.stderr.trim().slice(-300)}`,
        retryable: !r.timedOut,
      };
    } catch (e) {
      return { ok: false, reason: `${argv[0]} failed: ${errorMessage(e)}`, retryable: false };
    }
  }
}
