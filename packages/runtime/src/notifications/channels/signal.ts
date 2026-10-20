/**
 * Signal channel through `signal-cli` when it is on PATH; otherwise the channel reports itself
 * unavailable and the notifier moves on. The sending account (the agent's registered number) is
 * configuration; the recipient is the human's `notify_prefs.signal_number`.
 */
import { errorMessage, run as platformRun, which as platformWhich } from "@forerunner/platform";
import type { RunFn, WhichFn } from "../../sandbox/types.ts";
import { deepLinkFor, type Notification } from "../types.ts";
import { type Channel, type ChannelContext, type ChannelResult, plainText } from "./types.ts";

export interface SignalChannelOptions {
  /** The registered sender number (E.164), from configuration; null disables the channel. */
  account: string | null;
  binary?: string;
  run?: RunFn;
  which?: WhichFn;
  timeoutMs?: number;
}

/** `signal-cli -a <account> send -m <text> -- <recipient>`; "--" keeps a leading "+" or "-" safe. */
export function signalSendArgv(
  binary: string,
  account: string,
  text: string,
  recipient: string,
): string[] {
  return [binary, "-a", account, "send", "-m", text, "--", recipient];
}

export class SignalChannel implements Channel {
  readonly name = "signal" as const;
  private readonly binary: string;
  private readonly run: RunFn;
  private readonly which: WhichFn;
  private binaryPath: Promise<string | null> | null = null;

  constructor(private readonly opts: SignalChannelOptions) {
    this.binary = opts.binary ?? "signal-cli";
    this.run = opts.run ?? platformRun;
    this.which = opts.which ?? platformWhich;
  }

  configured(ctx: ChannelContext): string | null {
    if (!this.opts.account) return "no Signal sender account configured";
    if (!ctx.prefs.signal_number) return "no Signal number";
    return null;
  }

  private path(): Promise<string | null> {
    if (!this.binaryPath) this.binaryPath = this.which(this.binary).catch(() => null);
    return this.binaryPath;
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    const why = this.configured(ctx);
    if (why || !this.opts.account || !ctx.prefs.signal_number) {
      return { ok: false, reason: why ?? "signal channel is not configured", retryable: false };
    }
    const bin = await this.path();
    if (!bin) return { ok: false, reason: `${this.binary} is not on PATH`, retryable: false };
    const argv = signalSendArgv(
      bin,
      this.opts.account,
      plainText(n, deepLinkFor(n.link)),
      ctx.prefs.signal_number,
    );
    try {
      const r = await this.run(argv, {
        timeoutMs: this.opts.timeoutMs ?? 60_000,
        allowFailure: true,
      });
      if (r.code === 0) return { ok: true, detail: ctx.prefs.signal_number };
      return {
        ok: false,
        reason: `signal-cli exited ${r.timedOut ? "by timeout" : r.code}: ${r.stderr.trim().slice(-300)}`,
        retryable: true,
      };
    } catch (e) {
      return { ok: false, reason: `signal-cli failed: ${errorMessage(e)}`, retryable: false };
    }
  }
}
