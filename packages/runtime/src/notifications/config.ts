/**
 * Channel configuration the orchestrator reads once per runtime: the Signal sender account and
 * the Telegram bot token reference (a reference, never a value) and API base. Values come from
 * `config.json` (`notifications`), each overridable by a `FORERUNNER_*` variable; nothing is
 * hardcoded to a host, an account or a user. The per-human addresses (chat id, Signal number,
 * email) are preferences in `human.notify_prefs` (`prefs.ts`), not configuration.
 */
import { DEFAULT_TELEGRAM_API_BASE, DEFAULT_TELEGRAM_TOKEN_REF } from "./channels/telegram.ts";

export interface NotificationConfig {
  /** The agent's registered Signal sender number (E.164); null leaves the channel unconfigured. */
  signalAccount: string | null;
  /** Secret reference of the Telegram bot token (`secret:<name>`). */
  telegramTokenRef: string;
  /** Telegram Bot API base; only a stand-in changes it. */
  telegramApiBase: string;
}

/** The `notifications` block of `config.json` (every key optional). */
export interface NotificationConfigInput {
  signalAccount?: string | null;
  telegramTokenRef?: string;
  telegramApiBase?: string;
}

export const SIGNAL_ACCOUNT_ENV = "FORERUNNER_SIGNAL_ACCOUNT";
export const TELEGRAM_TOKEN_REF_ENV = "FORERUNNER_TELEGRAM_TOKEN_REF";
export const TELEGRAM_API_BASE_ENV = "FORERUNNER_TELEGRAM_API_BASE";

const SECRET_REF = /^secret:[a-z][a-z0-9_.:-]{0,127}$/;
const E164 = /^\+?[0-9]{6,20}$/;

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Merge the config file's `notifications` block with the environment (the environment wins).
 * Malformed values fall back to the default so a typo never points a channel somewhere odd: a
 * token reference must be `secret:<name>` (a value is refused, not stored), a Signal account
 * must look like a phone number, an API base must be an `http(s)` URL.
 */
export function notificationConfigFrom(
  config: { notifications?: NotificationConfigInput } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NotificationConfig {
  const file = config?.notifications ?? {};
  const signal = text(env[SIGNAL_ACCOUNT_ENV]) ?? text(file.signalAccount);
  const tokenRef = text(env[TELEGRAM_TOKEN_REF_ENV]) ?? text(file.telegramTokenRef);
  const apiBase = text(env[TELEGRAM_API_BASE_ENV]) ?? text(file.telegramApiBase);
  return {
    signalAccount: signal && E164.test(signal) ? signal : null,
    telegramTokenRef: tokenRef && SECRET_REF.test(tokenRef) ? tokenRef : DEFAULT_TELEGRAM_TOKEN_REF,
    telegramApiBase: apiBase && /^https?:\/\//.test(apiBase) ? apiBase : DEFAULT_TELEGRAM_API_BASE,
  };
}
