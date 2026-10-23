import { createSign } from "node:crypto";
import { type Clock, ForerunnerError, log } from "@forerunner/platform";

/**
 * FCM HTTP v1 sender (spec R.6; ADR 0085). One message to one registration token per call:
 * `POST <api>/v1/projects/<project>/messages:send` with an OAuth2 access token minted from the
 * service account (an RS256 JWT exchanged at the account's `token_uri`, node:crypto only).
 *
 * The service account JSON arrives by reference (`FORERUNNER_FCM_SERVICE_ACCOUNT_REF`, resolved
 * by main.ts); it lives in this object only. Nothing here logs or returns the private key, the
 * access token or a registration token: outcomes carry an HTTP status and FCM's error code.
 */
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const DEFAULT_FCM_API_URL = "https://fcm.googleapis.com";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Lifetime asked for in the JWT; Google caps it at one hour. */
const JWT_LIFETIME_S = 3600;
/** An access token is renewed this long before Google says it expires. */
const TOKEN_EARLY_RENEW_MS = 60_000;
const REASON_MAX = 200;

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/**
 * Parse a Google service-account key file. Errors name the missing field only, never echo the
 * content (it holds the private key).
 */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ForerunnerError("validation", "FCM service account is not valid JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new ForerunnerError("validation", "FCM service account is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof o[key] === "string" && (o[key] as string).trim() !== "" ? (o[key] as string) : undefined;
  const projectId = str("project_id");
  const clientEmail = str("client_email");
  const privateKey = str("private_key");
  for (const [name, value] of [
    ["project_id", projectId],
    ["client_email", clientEmail],
    ["private_key", privateKey],
  ] as const) {
    if (!value) {
      throw new ForerunnerError("validation", `FCM service account has no ${name}`, {
        details: { field: name },
      });
    }
  }
  return {
    projectId: projectId as string,
    clientEmail: clientEmail as string,
    privateKey: privateKey as string,
    tokenUri: str("token_uri") ?? DEFAULT_TOKEN_URI,
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** The signed JWT assertion for the OAuth2 JWT-bearer grant (RFC 7523). */
export function signServiceAccountJwt(account: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: account.tokenUri,
      iat,
      exp: iat + JWT_LIFETIME_S,
    }),
  );
  const input = `${header}.${claims}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(input).sign(account.privateKey);
  } catch {
    throw new ForerunnerError("validation", "FCM service account private_key cannot sign (RS256)");
  }
  return `${input}.${base64url(signature)}`;
}

export interface PushMessage {
  title: string;
  body: string;
  /** String values only (FCM `data`); the app's handler routes on `kind` and `link`. */
  data: Record<string, string>;
  /** Android delivery priority: "high" wakes the device (urgent kinds), "normal" may wait for doze. */
  priority: "high" | "normal";
}

export type SendOutcome =
  | { status: "sent"; attempts: number }
  /** The token is dead (404 / UNREGISTERED): the caller clears it from the device. */
  | { status: "unregistered"; attempts: number; reason: string }
  | { status: "failed"; attempts: number; reason: string; httpStatus: number | null };

/** What the fan-out needs from a sender; tests may pass their own. */
export interface PushSender {
  readonly projectId: string;
  send(token: string, message: PushMessage): Promise<SendOutcome>;
}

export interface FcmSenderOptions {
  account: ServiceAccount;
  clock: Clock;
  /** Overrides the account's `project_id` (FORERUNNER_FCM_PROJECT_ID). */
  projectId?: string;
  /** FCM API base URL (a stand-in in tests); default https://fcm.googleapis.com. */
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Attempts per message including the first; default 4. */
  maxAttempts?: number;
  /** First backoff after a 5xx / 429 / network error, doubled per retry; default 500 ms. */
  backoffMs?: number;
  /** Upper bound of one wait, Retry-After included; default 30 s. */
  maxBackoffMs?: number;
  /** Waits between retries; default `clock.sleep`. */
  sleep?: (ms: number) => Promise<void>;
}

const logger = log("state-api:push");

interface CachedToken {
  value: string;
  renewAt: number;
}

class Retryable extends Error {
  constructor(
    readonly reason: string,
    readonly httpStatus: number | null,
    readonly retryAfterMs: number | null,
  ) {
    super(reason);
  }
}

function clip(text: string): string {
  return text.replace(/[^\w .:/()-]/g, "").slice(0, REASON_MAX);
}

/** FCM's error status and `FcmError.errorCode` from an error body; never the free-text message. */
function fcmErrorCode(body: unknown): { status: string | null; errorCode: string | null } {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!err || typeof err !== "object") return { status: null, errorCode: null };
  const status = typeof err.status === "string" ? err.status : null;
  let errorCode: string | null = null;
  if (Array.isArray(err.details)) {
    for (const d of err.details) {
      const code = (d as { errorCode?: unknown } | null)?.errorCode;
      if (typeof code === "string") errorCode = code;
    }
  }
  return { status, errorCode };
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

export class FcmSender implements PushSender {
  readonly projectId: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cached: CachedToken | undefined;
  private minting: Promise<string> | undefined;

  constructor(private readonly opts: FcmSenderOptions) {
    this.projectId = opts.projectId || opts.account.projectId;
    this.apiUrl = (opts.apiUrl || DEFAULT_FCM_API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.backoffMs = Math.max(0, opts.backoffMs ?? 500);
    this.maxBackoffMs = Math.max(this.backoffMs, opts.maxBackoffMs ?? 30_000);
    this.sleep = opts.sleep ?? ((ms) => opts.clock.sleep(ms));
  }

  get endpoint(): string {
    return `${this.apiUrl}/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`;
  }

  async send(token: string, message: PushMessage): Promise<SendOutcome> {
    let attempts = 0;
    let reauthorized = false;
    let last: Retryable | undefined;
    while (attempts < this.maxAttempts) {
      if (attempts > 0) {
        const exp = this.backoffMs * 2 ** (attempts - 1);
        await this.sleep(Math.min(this.maxBackoffMs, Math.max(exp, last?.retryAfterMs ?? 0)));
      }
      attempts += 1;
      try {
        const res = await this.post(token, message);
        if (res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { status: "sent", attempts };
        }
        const body = await res.json().catch(() => null);
        const { status, errorCode } = fcmErrorCode(body);
        const reason = clip(`fcm http ${res.status} ${errorCode ?? status ?? ""}`.trim());
        if (res.status === 404 || errorCode === "UNREGISTERED") {
          return { status: "unregistered", attempts, reason };
        }
        if (res.status === 401 && !reauthorized) {
          // The access token was revoked or expired early: mint a new one once.
          reauthorized = true;
          this.cached = undefined;
          last = new Retryable(reason, res.status, 0);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          last = new Retryable(reason, res.status, retryAfterMs(res));
          continue;
        }
        return { status: "failed", attempts, reason, httpStatus: res.status };
      } catch (e) {
        if (e instanceof Retryable) {
          last = e;
          continue;
        }
        if (e instanceof ForerunnerError) {
          return { status: "failed", attempts, reason: clip(e.message), httpStatus: null };
        }
        // Network error (connection refused, reset, DNS): retried like a 5xx.
        last = new Retryable("fcm network error", null, null);
      }
    }
    return {
      status: "failed",
      attempts,
      reason: last?.reason ?? "fcm send failed",
      httpStatus: last?.httpStatus ?? null,
    };
  }

  private async post(token: string, message: PushMessage): Promise<Response> {
    const access = await this.accessToken();
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: { priority: message.priority === "high" ? "HIGH" : "NORMAL" },
        },
      }),
    });
  }

  /** A cached access token, or a new one from the account's token endpoint (one mint at a time). */
  private async accessToken(): Promise<string> {
    const now = this.opts.clock.now();
    if (this.cached && now < this.cached.renewAt) return this.cached.value;
    if (!this.minting) {
      this.minting = this.mint().finally(() => {
        this.minting = undefined;
      });
    }
    return this.minting;
  }

  private async mint(): Promise<string> {
    const now = this.opts.clock.now();
    const assertion = signServiceAccountJwt(this.opts.account, now);
    const res = await this.fetchImpl(this.opts.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = typeof body?.error === "string" ? body.error : "";
      const reason = clip(`oauth http ${res.status} ${code}`.trim());
      if (res.status === 429 || res.status >= 500) {
        throw new Retryable(reason, res.status, retryAfterMs(res));
      }
      logger.warn("access token refused", { httpStatus: res.status, error: clip(code) });
      throw new ForerunnerError("provider_auth", reason);
    }
    const value = typeof body?.access_token === "string" ? body.access_token : "";
    if (!value) throw new ForerunnerError("provider_auth", "oauth response has no access_token");
    const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : JWT_LIFETIME_S;
    this.cached = {
      value,
      renewAt: now + Math.max(0, expiresIn * 1000 - TOKEN_EARLY_RENEW_MS),
    };
    return value;
  }
}
