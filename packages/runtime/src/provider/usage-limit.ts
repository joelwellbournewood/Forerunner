/**
 * "This credential cannot serve until its limit resets" (U-078, ADR 0100), as the two ways
 * Forerunner calls Claude report it, mapped to one stable code: `provider_usage_limit`. A
 * short throttle stays `provider_rate_limit` (the SDKs retry it); a usage limit makes the
 * source rest (`limits.restingUntil`) and the call or the task move to the next source.
 *
 * What the sources say (read 2026-10-31):
 *
 * - **The Messages API** (platform.claude.com/docs/en/api/errors and /api/rate-limits): a tier's
 *   monthly spend cap answers 429 `rate_limit_error` with no `retry-after` header,
 *   `error.details.error_code: "enforced_spend_limit_reached"` and a message ending "You will
 *   regain access on 2026-09-01 at 00:00 UTC."; a spend limit the person set answers 400
 *   `invalid_request_error` whose message starts "You have reached your specified API usage
 *   limits" (or "... specified workspace API usage limits") and says when access resumes; a
 *   billing problem is 402 `billing_error`; an empty prepaid balance is the message "Your credit
 *   balance is too low to access the Anthropic API" (the text Claude Code itself matches). A
 *   plain 429 with `retry-after` is a per-minute rate limit, not a usage limit.
 * - **Claude Code** (the binary the Agent SDK 0.3.304 ships, 2.1.304): for a subscriber it emits
 *   `rate_limit_event` messages whose `rate_limit_info.status` is `rejected` once the plan's
 *   limit is reached, with `resetsAt` in epoch seconds (from the
 *   `anthropic-ratelimit-unified-reset` header) and `rateLimitType` (`five_hour`, `seven_day`,
 *   ...); the failed turn is an assistant message with `error: "rate_limit"` and a text such as
 *   "You've hit your limit · resets 3pm". `error: "billing_error"` is its "credit balance is too
 *   low". A `rate_limit` without a rejected event or such a text is a throttle.
 */
export const USAGE_LIMIT_CODE = "provider_usage_limit" as const;

/** How long a source rests when its error names no reset time. */
export const DEFAULT_REST_MS = 60 * 60 * 1000;
/** The longest rest a reported reset time can set (a monthly cap resets within a month). */
export const MAX_REST_MS = 32 * 24 * 60 * 60 * 1000;

const REGAIN = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2}) UTC/i;
const SPEND_LIMIT = /reached your (?:specified )?(?:workspace )?API usage limits/i;
const CREDIT_LOW = /credit balance (?:is )?too low/i;
/** Claude Code's wording when the plan's limit (not a throttle) stopped the turn. */
const PLAN_LIMIT_TEXT =
  /(?:hit|reached) your (?:[a-z0-9' -]+ )?limit|usage limit|out of (?:extra )?usage|spend limit|shared budget/i;

/** The reset time a Messages API message names ("regain access on <date> at <hh:mm> UTC"). */
export function resetFromText(text: string): string | undefined {
  const m = REGAIN.exec(text);
  if (!m) return undefined;
  const iso = `${m[1]}T${m[2]}:${m[3]}:00.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

/** An epoch time in seconds or milliseconds as ISO; undefined when it is no number. */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toISOString();
}

/**
 * A Messages API error (the Anthropic SDK's `APIError`: `status`, the parsed body as `error`,
 * `headers`) that says the credential's limit is reached, with the reset time when it names
 * one (the message, else a `retry-after` header); null for any other error.
 */
export function usageLimitOfApiError(e: unknown, nowMs: number): { resetAt?: string } | null {
  if (!e || typeof e !== "object") return null;
  const status = (e as { status?: unknown }).status;
  const body = (e as { error?: unknown }).error as
    | { type?: unknown; error?: { type?: unknown; message?: unknown; details?: unknown } }
    | undefined;
  const inner = body?.error ?? (body as { message?: unknown; type?: unknown } | undefined);
  const innerMessage = typeof inner?.message === "string" ? inner.message : "";
  const text = `${innerMessage} ${e instanceof Error ? e.message : ""}`;
  const details = (inner as { details?: { error_code?: unknown } } | undefined)?.details;
  const spendCap = details?.error_code === "enforced_spend_limit_reached";
  const limited =
    spendCap ||
    SPEND_LIMIT.test(text) ||
    CREDIT_LOW.test(text) ||
    status === 402 ||
    inner?.type === "billing_error";
  if (!limited) return null;
  const resetAt = resetFromText(text) ?? retryAfterOf(e, nowMs);
  return resetAt ? { resetAt } : {};
}

function retryAfterOf(e: unknown, nowMs: number): string | undefined {
  const headers = (e as { headers?: { get?: (name: string) => string | null } }).headers;
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : null;
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(nowMs + seconds * 1000).toISOString()
    : undefined;
}

/** Claude Code's `rate_limit_event` once the subscription's limit rejects calls; else null. */
export function rejectedRateLimitOf(msg: Record<string, unknown>): { resetAt?: string } | null {
  if (msg.type !== "rate_limit_event") return null;
  const info = msg.rate_limit_info as { status?: unknown; resetsAt?: unknown } | undefined;
  if (info?.status !== "rejected") return null;
  const resetAt = epochToIso(info.resetsAt);
  return resetAt ? { resetAt } : {};
}

/**
 * Whether Claude Code's assistant error kind (`SDKAssistantMessageError`) means the plan's or
 * the account's limit, not a throttle: `billing_error` always; `rate_limit` when Claude Code
 * reported the limit rejected (`rate_limit_event`) or its text says the limit is hit.
 */
export function isClaudeCodeUsageLimit(kind: string, text: string, rejected: boolean): boolean {
  if (kind === "billing_error") return true;
  if (kind !== "rate_limit") return false;
  return rejected || PLAN_LIMIT_TEXT.test(text);
}

/**
 * Until when a source rests after a usage limit: the reported reset when it is ahead (at most
 * `MAX_REST_MS` away), else `DEFAULT_REST_MS` from now.
 */
export function restUntil(resetAt: string | undefined, nowMs: number): string {
  const t = resetAt ? Date.parse(resetAt) : Number.NaN;
  const until =
    Number.isFinite(t) && t > nowMs ? Math.min(t, nowMs + MAX_REST_MS) : nowMs + DEFAULT_REST_MS;
  return new Date(until).toISOString();
}
