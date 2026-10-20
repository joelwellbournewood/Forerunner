import type { DeviceKind } from "@forerunner/state";

/**
 * Scopes a device session token can carry (ADR 0009). `confirm:high` is never stored on a
 * token: it is granted per request when the request is signed by the device key and carries
 * the biometric assertion flag the shell sets after its biometric prompt.
 */
export const SCOPES = [
  "read",
  "write:inbox",
  "write:queue",
  "write:remote",
  "write:approvals",
  "confirm:high",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Scopes a token may be issued with (everything but the per-request one). */
export const ISSUABLE_SCOPES: readonly Scope[] = SCOPES.filter((s) => s !== "confirm:high");

/** Default scopes per device kind. Phones get every issuable scope; the approvals web page cannot drive runners. */
export const DEFAULT_SCOPES: Record<Extract<DeviceKind, "phone" | "web">, readonly Scope[]> = {
  phone: ["read", "write:inbox", "write:queue", "write:remote", "write:approvals"],
  web: ["read", "write:inbox", "write:queue", "write:approvals"],
};

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** Validate and narrow a requested scope list to issuable scopes; undefined falls back to the kind's defaults. */
export function resolveScopes(
  kind: "phone" | "web",
  requested: readonly string[] | undefined,
): { ok: true; scopes: Scope[] } | { ok: false; invalid: string[] } {
  if (requested === undefined) return { ok: true, scopes: [...DEFAULT_SCOPES[kind]] };
  const invalid = requested.filter((s) => !isScope(s) || !ISSUABLE_SCOPES.includes(s));
  if (invalid.length) return { ok: false, invalid };
  const scopes = [...new Set(requested as Scope[])];
  if (!scopes.includes("read")) scopes.unshift("read");
  return { ok: true, scopes };
}
