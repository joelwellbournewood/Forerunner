import { z } from "zod";
import type { Clock } from "../lib/clock.ts";
import type { KeyValueStore } from "../lib/storage.ts";
import {
  generateDeviceKey,
  importSigningKey,
  isEd25519Supported,
  pairingProofMessage,
  signBytes,
} from "./crypto.ts";
import { ErrorBody, PairingCompleteView } from "./types.ts";

/**
 * The web session (ADR 0009, web kind): the scoped session token the service issued at
 * pairing plus the Ed25519 key this tab generated for it. Both live in `sessionStorage`
 * only, so they end with the tab; neither reaches a cookie, `localStorage`, a log line or
 * the query string (the tests assert it).
 */
export const WebSession = z.object({
  token: z.string().min(1),
  deviceId: z.string(),
  humanId: z.string(),
  kind: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  publicKey: z.string(),
  privateJwk: z.object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    d: z.string(),
    x: z.string(),
  }),
  /** Service the token belongs to; a page opened against another service ignores it. */
  serviceUrl: z.string(),
});
export type WebSession = z.infer<typeof WebSession>;

export const SESSION_KEY = "forerunner.approvals.session";

const CODE_RE = /^[A-Z0-9]{4,32}$/;

/**
 * The one-time code travels in the URL fragment (`#code=XXXXXXXX`): browsers never send a
 * fragment to a server, so it stays out of access logs, referrers and proxies. Anything
 * else in the fragment is ignored.
 */
export function parseFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  // A query string is never accepted: servers log it.
  if (!raw || raw.startsWith("?")) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const code = params.get("code")?.trim().toUpperCase() ?? "";
  return CODE_RE.test(code) ? code : null;
}

/** Remove the fragment from the address bar and history so a reload or a copied URL cannot replay it. */
export function stripFragment(win: Pick<Window, "history" | "location"> = window): void {
  try {
    const { pathname, search } = win.location;
    win.history.replaceState(win.history.state, "", `${pathname}${search}`);
  } catch {
    // some embedders refuse replaceState; the code is single use on the service anyway
  }
}

export function loadSession(
  store: KeyValueStore,
  clock: Clock,
  serviceUrl: string,
): WebSession | null {
  const raw = store.get(SESSION_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    store.remove(SESSION_KEY);
    return null;
  }
  const result = WebSession.safeParse(parsed);
  if (!result.success) {
    store.remove(SESSION_KEY);
    return null;
  }
  const s = result.data;
  if (s.serviceUrl !== serviceUrl || Date.parse(s.expiresAt) <= clock.now()) {
    store.remove(SESSION_KEY);
    return null;
  }
  return s;
}

export function saveSession(store: KeyValueStore, session: WebSession): void {
  store.set(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(store: KeyValueStore): void {
  store.remove(SESSION_KEY);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ExchangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExchangeError";
  }
}

export interface ExchangeInput {
  baseUrl: string;
  code: string;
  deviceName: string;
  fetchImpl?: FetchLike;
}

/**
 * Exchange the one-time code for a scoped session token (`POST /pairing/complete`): a fresh
 * Ed25519 key is generated, the proof `sign("pair:<code>")` shows possession, and the
 * service answers with the token it stores only as a hash. The code is single use: a second
 * exchange, or one after the service's ten-minute window, fails with `pairing_invalid`.
 */
export async function exchangeCode(input: ExchangeInput): Promise<WebSession> {
  if (!(await isEd25519Supported())) {
    throw new ExchangeError(
      "web.unsupported",
      "This browser cannot sign requests (no Ed25519 in WebCrypto). Use a current Chrome, Firefox or Safari.",
    );
  }
  const fetchImpl = input.fetchImpl ?? ((u, i) => fetch(u, i));
  const key = await generateDeviceKey();
  const signingKey = await importSigningKey(key.privateJwk);
  const proof = await signBytes(signingKey, pairingProofMessage(input.code));
  let res: Response;
  try {
    res = await fetchImpl(`${input.baseUrl}/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code: input.code,
        publicKey: key.publicKey,
        proof,
        name: input.deviceName,
        platform: "web",
      }),
    });
  } catch {
    throw new ExchangeError(
      "web.network",
      "Cannot reach the state service. Check your connection.",
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = ErrorBody.safeParse(body);
    const code = err.success ? err.data.code : "web.http_error";
    if (code === "pairing_invalid") {
      throw new ExchangeError(
        code,
        "This link was already used or has expired. Ask for a new link.",
      );
    }
    if (code === "rate_limited") {
      throw new ExchangeError(code, "Too many attempts. Wait a minute and open the link again.");
    }
    throw new ExchangeError(code, `The state service refused the link (${res.status}).`);
  }
  const parsed = PairingCompleteView.safeParse(body);
  if (!parsed.success) {
    throw new ExchangeError(
      "web.invalid_response",
      "The state service answered with something this page cannot read.",
    );
  }
  return {
    token: parsed.data.token,
    deviceId: parsed.data.deviceId,
    humanId: parsed.data.humanId,
    kind: parsed.data.kind,
    scopes: parsed.data.scopes,
    expiresAt: parsed.data.expiresAt,
    publicKey: key.publicKey,
    privateJwk: key.privateJwk,
    serviceUrl: input.baseUrl,
  };
}
