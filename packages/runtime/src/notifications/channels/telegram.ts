/**
 * Telegram channel: Bot API `sendMessage` over an injected `fetch`. The bot token is a secret
 * reference (`secret:telegram_bot_token` by default) resolved at send time through the secrets
 * port; the token is part of the request URL, so the URL is never logged and every error text
 * passes through the port's redaction before it leaves this module.
 */
import { errorMessage, log } from "@forerunner/platform";
import { parseSecretRef } from "@forerunner/vault";
import { deepLinkFor, type Notification } from "../types.ts";
import { type Channel, type ChannelContext, type ChannelResult, plainText } from "./types.ts";

/** The runtime's secrets port (`SecretResolver` from @forerunner/vault satisfies it). */
export interface SecretsLike {
  resolve(input: unknown, granted: ReadonlySet<string>): Promise<unknown>;
  redact(text: string): string;
}

export type TelegramFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TelegramChannelOptions {
  fetch: TelegramFetch;
  secrets: SecretsLike;
  /** Secret reference of the bot token. */
  tokenRef?: string;
  apiBase?: string;
  timeoutMs?: number;
}

export const DEFAULT_TELEGRAM_TOKEN_REF = "secret:telegram_bot_token";
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
/** Telegram's own limit for one message. */
export const TELEGRAM_MAX_TEXT = 4096;

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private readonly logger = log("notify:telegram");
  private readonly tokenRef: string;
  private readonly tokenName: string;
  private readonly apiBase: string;

  constructor(private readonly opts: TelegramChannelOptions) {
    this.tokenRef = opts.tokenRef ?? DEFAULT_TELEGRAM_TOKEN_REF;
    this.tokenName = parseSecretRef(this.tokenRef);
    this.apiBase = (opts.apiBase ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  }

  configured(ctx: ChannelContext): string | null {
    return ctx.prefs.telegram_chat_id ? null : "no Telegram chat id";
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    const chatId = ctx.prefs.telegram_chat_id;
    if (!chatId) return { ok: false, reason: "no Telegram chat id", retryable: false };
    let token: string;
    try {
      const resolved = await this.opts.secrets.resolve(this.tokenRef, new Set([this.tokenName]));
      if (typeof resolved !== "string" || resolved.length === 0 || resolved === this.tokenRef) {
        return { ok: false, reason: `secret ${this.tokenName} is not set`, retryable: false };
      }
      token = resolved;
    } catch (e) {
      return {
        ok: false,
        reason: `bot token unavailable: ${this.redact(errorMessage(e))}`,
        retryable: false,
      };
    }
    const text = plainText(n, deepLinkFor(n.link)).slice(0, TELEGRAM_MAX_TEXT);
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await this.opts.fetch(`${this.apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        this.logger.debug("sent", { kind: n.kind, chatId });
        return { ok: true, detail: `chat ${chatId}` };
      }
      const description = await res
        .json()
        .then((j) =>
          j && typeof j === "object" && "description" in j ? String(j.description) : "",
        )
        .catch(() => "");
      const reason = this.redact(
        `telegram api ${res.status}${description ? `: ${description}` : ""}`,
      );
      this.logger.warn("send failed", { kind: n.kind, status: res.status });
      return { ok: false, reason, retryable: res.status === 429 || res.status >= 500 };
    } catch (e) {
      const reason = this.redact(`telegram request failed: ${errorMessage(e)}`);
      this.logger.warn("send failed", { kind: n.kind });
      return { ok: false, reason, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private redact(text: string): string {
    // The URL carries the token; strip any "/bot<token>/" fragment before the port's redaction.
    return this.opts.secrets.redact(text.replace(/\/bot[^/\s]+\//g, "/bot[redacted]/"));
  }
}
