import { type Clock, errorMessage, ForerunnerError } from "@forerunner/platform";
import type { DeviceRow, StateStore } from "@forerunner/state";

/**
 * Settings -> Devices on the desktop (spec R.2; ADR 0009): the human's paired devices, a new
 * pairing (the one-time code, its expiry and the `fr://` link the app shows as a QR) and an
 * immediate revocation. The desktop app talks only to this daemon; the daemon holds the state
 * service's admin token (from its vault, by reference) and never hands it to the UI.
 *
 * Pairing codes live in the service's memory, so starting a pairing needs the service; without
 * it `startPairing` is `unavailable` with what to configure. The list and the revocation go
 * through the service when it is configured (the service also drops the device's session
 * tokens and tells open streams), and through the shared store otherwise: the service checks
 * the device row on every request, so a row revoked in the store refuses the next request.
 */

/** One device as the Devices section shows it; the public key is not needed there. */
export interface DaemonDeviceView {
  id: string;
  name: string;
  platform: string;
  kind: string;
  pairedAt: string;
  lastSeen: string | null;
  revoked: boolean;
  revokedAt: string | null;
  /** True for this daemon's own `desktop` row (the install the app runs on). */
  current: boolean;
  version: number;
}

export type PairingKind = "phone" | "web";

export interface PairingStartView {
  code: string;
  expiresAt: string;
  kind: string;
  humanId: string;
  /** The service URL the phone completes the pairing at. */
  serviceUrl: string;
  /** `fr://pair?u=<service>&c=<code>&h=<human>`: what the QR encodes (apps/ui `pairing.ts`). */
  link: string;
}

export interface RevokeDeviceView {
  device: DaemonDeviceView;
  /** Session tokens the service dropped; null when the store revoked the row directly. */
  tokensRevoked: number | null;
}

/** Where the state service is and the admin credential to call it with. */
export interface DeviceServiceConfig {
  /** Base URL of the state service, e.g. https://state.example.test. */
  baseUrl: string;
  /** Read at every call (the vault is the only holder); null when the secret is missing. */
  adminToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export interface DeviceManagerDeps {
  store: Pick<StateStore, "device" | "auditLog">;
  clock: Clock;
  humanId: string;
  /** This daemon's own device row id, when it registered one. */
  currentDeviceId: () => string | null;
  /** Null when no state service is configured. */
  service: DeviceServiceConfig | null;
}

/** Audit tools of the daemon's device actions. */
export const DEVICE_AUDIT = {
  pairingStarted: "devices.pairing_start",
  revoked: "devices.revoke",
} as const;

/** The deep link the phone opens; the same format `apps/ui/src/mobile/pairing.ts` parses. */
export function pairingLink(serviceUrl: string, code: string, humanId?: string): string {
  const u = new URL("fr://pair");
  u.searchParams.set("u", serviceUrl);
  u.searchParams.set("c", code);
  if (humanId) u.searchParams.set("h", humanId);
  return u.toString();
}

interface ServiceDevice {
  id: string;
  ownerHumanId: string;
  name: string;
  platform: string;
  kind: string;
  lastSeen: string | null;
  revoked: boolean;
  revokedAt: string | null;
  pairedAt: string;
  version: number;
}

export class DeviceManager {
  constructor(private readonly deps: DeviceManagerDeps) {}

  /** Whether a pairing can be started here (the state service is configured). */
  get pairingAvailable(): boolean {
    return this.deps.service !== null;
  }

  /** The signed-in human's devices, newest pairing first, revoked ones included. */
  async list(): Promise<DaemonDeviceView[]> {
    if (this.deps.service) {
      const q = new URLSearchParams({ humanId: this.deps.humanId });
      const body = await this.call<{ devices: ServiceDevice[] }>(
        "GET",
        `/devices?${q.toString()}`,
      );
      return body.devices
        .filter((d) => d.ownerHumanId === this.deps.humanId)
        .map((d) => this.fromService(d));
    }
    const rows = await this.deps.store.device.list(
      { owner_human_id: this.deps.humanId },
      { orderBy: "paired_at desc" },
    );
    return rows.map((r) => this.fromRow(r));
  }

  async startPairing(input: { kind?: PairingKind; name?: string } = {}): Promise<PairingStartView> {
    const service = this.deps.service;
    if (!service) {
      throw new ForerunnerError(
        "unavailable",
        "pairing needs the state service: set FORERUNNER_STATE_API_URL and keep its admin token in the vault (FORERUNNER_STATE_API_ADMIN_TOKEN_REF, default secret:state_api_admin)",
      );
    }
    const kind = input.kind ?? "phone";
    const body = await this.call<{ code: string; expiresAt: string; kind: string }>(
      "POST",
      "/pairing/start",
      { humanId: this.deps.humanId, kind, ...(input.name ? { name: input.name } : {}) },
    );
    const serviceUrl = service.baseUrl.replace(/\/+$/, "");
    await this.audit(DEVICE_AUDIT.pairingStarted, `kind=${kind}`, `expires ${body.expiresAt}`);
    // The code itself is a one-time secret: it goes to the app that asked, never to the audit.
    return {
      code: body.code,
      expiresAt: body.expiresAt,
      kind: body.kind,
      humanId: this.deps.humanId,
      serviceUrl,
      link: pairingLink(serviceUrl, body.code, this.deps.humanId),
    };
  }

  /** Revoke at once (spec R.2): the device's next request to the service is refused. */
  async revoke(deviceId: string): Promise<RevokeDeviceView> {
    if (deviceId === this.deps.currentDeviceId()) {
      throw new ForerunnerError(
        "validation",
        "this is the device the app runs on; revoke it from another device",
      );
    }
    const row = await this.deps.store.device.get(deviceId);
    // Through the service the row may live only there; through the store it must be here.
    if (!row && !this.deps.service) throw new ForerunnerError("not_found", "device not found");
    if (row && row.owner_human_id !== this.deps.humanId) {
      throw new ForerunnerError("tool_not_allowed", "not a device of the signed-in human");
    }
    let view: RevokeDeviceView;
    if (this.deps.service) {
      if (!row) {
        // Ownership is checked against the service's list before the revocation.
        const own = (await this.list()).some((d) => d.id === deviceId);
        if (!own) throw new ForerunnerError("not_found", "device not found");
      }
      const body = await this.call<{ device: ServiceDevice; tokensRevoked: number }>(
        "POST",
        `/devices/${encodeURIComponent(deviceId)}/revoke`,
        {},
      );
      view = { device: this.fromService(body.device), tokensRevoked: body.tokensRevoked };
    } else {
      const current = row as DeviceRow;
      const revoked = current.revoked
        ? current
        : await this.deps.store.device.revoke(current.id, current.version);
      view = { device: this.fromRow(revoked), tokensRevoked: null };
    }
    await this.audit(
      DEVICE_AUDIT.revoked,
      `device=${deviceId} kind=${view.device.kind}`,
      view.tokensRevoked === null
        ? "row revoked in the shared store"
        : `revoked by the state service, ${view.tokensRevoked} session token(s) dropped`,
    );
    return view;
  }

  private fromRow(r: DeviceRow): DaemonDeviceView {
    return {
      id: r.id,
      name: r.name,
      platform: r.platform,
      kind: r.kind,
      pairedAt: r.paired_at,
      lastSeen: r.last_seen,
      revoked: r.revoked,
      revokedAt: r.revoked_at,
      current: r.id === this.deps.currentDeviceId(),
      version: r.version,
    };
  }

  private fromService(d: ServiceDevice): DaemonDeviceView {
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      kind: d.kind,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      revoked: d.revoked,
      revokedAt: d.revokedAt,
      current: d.id === this.deps.currentDeviceId(),
      version: d.version,
    };
  }

  private async audit(tool: string, input: string, result: string): Promise<void> {
    await this.deps.store.auditLog.append({
      tool,
      human_id: this.deps.humanId,
      input_summary: input,
      result_summary: result,
      allowed: true,
      occurred_at: this.deps.clock.nowIso(),
    });
  }

  /**
   * One admin call to the service. The token is read from the vault per call and never
   * logged; an error carries the service's status and code, never the body or the token.
   */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const service = this.deps.service as DeviceServiceConfig;
    const token = await service.adminToken();
    if (!token) {
      throw new ForerunnerError(
        "unavailable",
        "the state service admin token is not in the vault (FORERUNNER_STATE_API_ADMIN_TOKEN_REF, default secret:state_api_admin)",
      );
    }
    const doFetch = service.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${service.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.deps.currentDeviceId()
            ? { "x-forerunner-install": this.deps.currentDeviceId() as string }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ForerunnerError("unavailable", `state service unreachable: ${errorMessage(e)}`, {
        details: { path: path.split("?")[0] },
        cause: e,
      });
    }
    if (!res.ok) {
      let code: string | undefined;
      let message = "";
      try {
        const parsed = (await res.json()) as { code?: string; message?: string };
        code = parsed.code;
        message = parsed.message ?? "";
      } catch {
        // not JSON: the status is what we know
      }
      const details = { path: path.split("?")[0], status: res.status, code: code ?? null };
      if (res.status === 404) {
        throw new ForerunnerError("not_found", message || "not found", { details });
      }
      if (res.status === 400) {
        throw new ForerunnerError("validation", message || "rejected", { details });
      }
      throw new ForerunnerError(
        "unavailable",
        `state service answered ${res.status}${code ? ` ${code}` : ""}`,
        { details },
      );
    }
    return (await res.json()) as T;
  }
}
