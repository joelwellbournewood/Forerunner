/**
 * Email channel. Sends through a small port the agent email capability provides in production
 * (its mailbox `send`, under the email policy) and a fake in tests. The address is the
 * human's `notify_prefs.email` or their primary email.
 */
import { errorMessage } from "@forerunner/platform";
import { deepLinkFor, type Notification } from "../types.ts";
import { type Channel, type ChannelContext, type ChannelResult, plainText } from "./types.ts";

export interface EmailPort {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export class EmailChannel implements Channel {
  readonly name = "email" as const;

  constructor(private readonly port: EmailPort | null) {}

  configured(ctx: ChannelContext): string | null {
    if (!this.port) return "no email sender: enable the agent email capability";
    if (!ctx.prefs.email) return "no email address";
    return null;
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    const why = this.configured(ctx);
    if (why || !this.port || !ctx.prefs.email) {
      return { ok: false, reason: why ?? "email channel is not configured", retryable: false };
    }
    try {
      await this.port.sendEmail(
        ctx.prefs.email,
        `[Forerunner] ${n.title}`,
        plainText(n, deepLinkFor(n.link)),
      );
      return { ok: true, detail: ctx.prefs.email };
    } catch (e) {
      return { ok: false, reason: `email send failed: ${errorMessage(e)}`, retryable: true };
    }
  }
}
