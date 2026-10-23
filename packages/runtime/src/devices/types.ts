import { z } from "zod";

/**
 * Wire shapes of Settings -> Devices (spec R.2, ADR 0009): what the daemon's `/devices` routes
 * and the desktop app exchange. This file imports nothing but zod so the UI can load it
 * through `daemon/api-types`.
 */

/** One device as the Devices section shows it; the public key is not needed there. */
export const DaemonDeviceView = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  /** `phone`, `web` or `desktop` (the service's device kinds). */
  kind: z.string(),
  pairedAt: z.string(),
  lastSeen: z.string().nullable(),
  revoked: z.boolean(),
  revokedAt: z.string().nullable(),
  /** True for this daemon's own `desktop` row (the install the app runs on). */
  current: z.boolean(),
  version: z.number().int(),
});
export type DaemonDeviceView = z.infer<typeof DaemonDeviceView>;

export const DeviceListView = z.object({
  devices: z.array(DaemonDeviceView),
  /** False when no state service is configured: the list comes from the store, no pairing. */
  pairingAvailable: z.boolean(),
});
export type DeviceListView = z.infer<typeof DeviceListView>;

export const PAIRING_KINDS = ["phone", "web"] as const;
export type PairingKind = (typeof PAIRING_KINDS)[number];

export const StartPairingBody = z.object({
  kind: z.enum(PAIRING_KINDS).optional(),
  name: z.string().max(120).optional(),
});
export type StartPairingBody = z.infer<typeof StartPairingBody>;

export const PairingStartView = z.object({
  /** The one-time code (8 characters); the human may type it on the phone. */
  code: z.string(),
  /** ISO-8601 UTC; the service forgets the code after it. */
  expiresAt: z.string(),
  kind: z.string(),
  humanId: z.string(),
  /** The service URL the phone completes the pairing at. */
  serviceUrl: z.string(),
  /** `fr://pair?u=<service>&c=<code>&h=<human>`: what the QR encodes (apps/ui `pairing.ts`). */
  link: z.string(),
});
export type PairingStartView = z.infer<typeof PairingStartView>;

export const RevokeDeviceView = z.object({
  device: DaemonDeviceView,
  /** Session tokens the service dropped; null when the store revoked the row directly. */
  tokensRevoked: z.number().int().nullable(),
});
export type RevokeDeviceView = z.infer<typeof RevokeDeviceView>;

/** The daemon's device routes, in the notation of `DAEMON_ROUTES`. */
export const DEVICES_ROUTES = {
  devices:
    "GET /devices (DeviceListView { devices: DaemonDeviceView[], pairingAvailable }: the daemon's human's paired devices, newest pairing first, revoked ones included, this install marked current; spec R.2)",
  startPairing:
    "POST /devices/pairing { kind?: phone|web, name? } (201 PairingStartView: the one-time code, its expiry and the fr:// link the QR encodes; the daemon asks the state service with its admin token, which never reaches the app; 503 unavailable without a service URL or the admin token)",
  revokeDevice:
    "POST /devices/:id/revoke (RevokeDeviceView: revoked at once, the device's tokens dropped, its next request refused; 400 validation for this install's own device, 403 another human's, 404 unknown)",
} as const;
