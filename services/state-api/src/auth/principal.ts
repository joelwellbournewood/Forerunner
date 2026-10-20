import type { Clock } from "@forerunner/platform";
import type { DeviceRow, StateStore } from "@forerunner/state";
import { ApiError, forbidden, unauthorized } from "../errors.ts";
import { constantTimeEqual, verifyRequestSignature } from "./crypto.ts";
import type { ReplayGuard } from "./replay.ts";
import type { Scope } from "./scopes.ts";
import type { SessionTokenRecord, SessionTokenStore } from "./tokens.ts";

/**
 * Who is calling. Admin = the desktop runtime or the cloud runner holding the service admin
 * token (they also talk to Postgres directly; the service is their realtime and remote
 * channel). Device = a paired phone or approvals web page with a scoped session token.
 */
export type Principal =
  | {
      kind: "admin";
      scopes: readonly Scope[];
      humanId: null;
      deviceId: null;
      /**
       * Which install is calling (`X-Forerunner-Install`), so each PC runtime and the cloud
       * runner get their own rate-limit bucket and idempotency space; null without the header.
       */
      installId: string | null;
    }
  | {
      kind: "device";
      deviceId: string;
      humanId: string;
      scopes: readonly Scope[];
      device: DeviceRow;
      token: SessionTokenRecord;
      /** True when this request carried a valid device signature. */
      signed: boolean;
      /** True when the signed request carried the biometric assertion flag. */
      biometric: boolean;
    };

export const ALL_SCOPES: readonly Scope[] = [
  "read",
  "write:inbox",
  "write:queue",
  "write:remote",
  "write:approvals",
  "confirm:high",
];

export const HEADER_SIGNATURE = "x-device-signature";
export const HEADER_TIMESTAMP = "x-device-timestamp";
export const HEADER_BIOMETRIC = "x-biometric-assertion";
export const HEADER_INSTALL = "x-forerunner-install";

const INSTALL_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The install id an admin caller declares, or null when absent or malformed (never an error). */
export function installIdOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return INSTALL_ID.test(value) ? value : null;
}

export interface AuthDeps {
  store: StateStore;
  tokens: SessionTokenStore;
  clock: Clock;
  adminToken: string | undefined;
  signatureWindowMs: number;
  /** Refuses a signed mutation presented twice inside the window; optional for embedders. */
  replay?: ReplayGuard;
}

export interface IncomingRequest {
  method: string;
  /** Path plus query string. */
  pathWithQuery: string;
  headers: { get(name: string): string | null };
  /** Raw body bytes or text; empty for GET. */
  body: string | Uint8Array;
}

function parseTimestamp(raw: string): number | undefined {
  if (/^\d{10,16}$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Resolve the principal of a request from `Authorization: Bearer <token>`, then validate the
 * device signature when present. Revoked devices are refused at once: the device row is
 * read on every request (one indexed lookup) so `DeviceRepo.revoke` takes effect within one
 * request, as spec R demands for a lost phone.
 */
export async function authenticate(deps: AuthDeps, req: IncomingRequest): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m?.[1]) throw unauthorized();
  const token = m[1];

  if (deps.adminToken && constantTimeEqual(token, deps.adminToken)) {
    return {
      kind: "admin",
      scopes: ALL_SCOPES,
      humanId: null,
      deviceId: null,
      installId: installIdOf(req.headers.get(HEADER_INSTALL)),
    };
  }

  const record = deps.tokens.lookup(token);
  if (!record) throw unauthorized("invalid or expired session token");
  const device = await deps.store.device.get(record.deviceId);
  if (!device || device.revoked) {
    throw new ApiError(401, "unauthorized", "device revoked", { deviceId: record.deviceId });
  }
  await deps.tokens.touch(record);
  // last_seen is written at most once a minute so a busy phone does not bump the row version on every call.
  if (!device.last_seen || deps.clock.now() - Date.parse(device.last_seen) >= 60_000) {
    await deps.store.device.seen(device.id);
  }

  const signature = req.headers.get(HEADER_SIGNATURE);
  const biometricHeader = req.headers.get(HEADER_BIOMETRIC);
  let signed = false;
  let biometric = false;
  if (signature) {
    const timestamp = req.headers.get(HEADER_TIMESTAMP) ?? "";
    const ts = parseTimestamp(timestamp);
    if (ts === undefined) throw new ApiError(401, "bad_signature", "X-Device-Timestamp missing");
    if (Math.abs(deps.clock.now() - ts) > deps.signatureWindowMs) {
      throw new ApiError(401, "bad_signature", "X-Device-Timestamp outside the allowed window", {
        windowMs: deps.signatureWindowMs,
      });
    }
    biometric = biometricHeader === "1" || biometricHeader === "true";
    const ok = verifyRequestSignature(device.public_key, signature, {
      method: req.method,
      path: req.pathWithQuery,
      body: req.body,
      timestamp,
      biometric,
    });
    if (!ok) throw new ApiError(401, "bad_signature", "device signature does not verify");
    // A verified mutation signature is single use inside the window (ADR 0009 amendment).
    if (
      deps.replay &&
      !READ_METHODS.has(req.method.toUpperCase()) &&
      !deps.replay.accept(signature)
    ) {
      throw new ApiError(
        401,
        "bad_signature",
        "signed request replayed; sign again with a fresh timestamp",
      );
    }
    signed = true;
  }
  return {
    kind: "device",
    deviceId: device.id,
    humanId: device.owner_human_id,
    scopes: record.scopes,
    device,
    token: record,
    signed,
    biometric,
  };
}

/** Throw 403 unless the principal holds `scope`. `confirm:high` needs a signed biometric request. */
export function requireScope(p: Principal, scope: Scope): void {
  if (p.kind === "admin") return;
  if (scope === "confirm:high") {
    if (!p.signed) throw forbidden("high-risk confirmation needs a device-signed request");
    if (!p.biometric) {
      throw new ApiError(
        403,
        "biometric_required",
        "high-risk confirmation needs the biometric assertion flag",
      );
    }
    return;
  }
  if (!p.scopes.includes(scope)) throw forbidden(`scope ${scope} required`, { scope });
}

/** Mutations from devices must be signed (ADR 0009). */
export function requireSigned(p: Principal): void {
  if (p.kind === "device" && !p.signed) {
    throw new ApiError(401, "bad_signature", "mutations need X-Device-Signature");
  }
}

/** Devices act only for their own human; admins may pass any humanId. */
export function resolveHumanId(p: Principal, requested: string | undefined): string | undefined {
  if (p.kind === "admin") return requested;
  if (requested && requested !== p.humanId)
    throw forbidden("not your human", { humanId: requested });
  return p.humanId;
}

export function mustHumanId(p: Principal, requested: string | undefined): string {
  const id = resolveHumanId(p, requested);
  if (!id) throw new ApiError(400, "validation", "humanId is required");
  return id;
}
