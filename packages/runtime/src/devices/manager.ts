import { type Clock, errorMessage, ForerunnerError } from "@forerunner/platform";
import type { DeviceRow, StateStore } from "@forerunner/state";
import type { DaemonDeviceView, PairingKind, PairingStartView, RevokeDeviceView } from "./types.ts";

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
 * The same holds when the service is configured but cannot be reached (down, hung past
 * `timeoutMs`, a refused or missing admin token): a row that is in this daemon's store (the
 * shared Postgres in hybrid mode) is revoked there, so a lost phone is never left working
 * because the service is out. Every revocation also writes the `change_log` row the
 * registry's `device.revoke` writes (source `ui`, irreversible), so the change log shows it.
 */

/** Where the state service is and the admin credential to call it with. */
export interface DeviceServiceConfig {
  /** Base URL of the state service, e.g. https://state.example.test. */
  baseUrl: string;
  /** Read at every call (the vault is the only holder); null when the secret is missing. */
  adminToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Abort a call the service has not answered after this long; `DEVICE_SERVICE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** How long one admin call to the state service may take before it is `unavailable`. */
export const DEVICE_SERVICE_TIMEOUT_MS = 15_000;

export interface DeviceManagerDeps {
  store: Pick<StateStore, "device" | "auditLog" | "changeLog">;
  /** The agent the change log row names as executor; null when there is none. */
  agentId?: string | null;
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
      const body = await this.call<{ devices: ServiceDevice[] }>("GET", `/devices?${q.toString()}`);
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
    let wasRevoked = row?.revoked ?? false;
    if (this.deps.service) {
      if (!row) {
        // Ownership is checked against the service's list before the revocation.
        const listed = (await this.list()).find((d) => d.id === deviceId);
        if (!listed) throw new ForerunnerError("not_found", "device not found");
        wasRevoked = listed.revoked;
      }
      try {
        const body = await this.call<{ device: ServiceDevice; tokensRevoked: number }>(
          "POST",
          `/devices/${encodeURIComponent(deviceId)}/revoke`,
          {},
        );
        view = {
          device: this.fromService(body.device),
          tokensRevoked: body.tokensRevoked,
          via: "service",
          serviceError: null,
        };
      } catch (e) {
        // A lost phone stays revocable while the service is out: the row in this daemon's
        // store is the one the service authenticates against (hybrid mode), so revoking it
        // there refuses the phone's next request as soon as the service answers again.
        if (!row || !(e instanceof ForerunnerError) || e.code !== "unavailable") throw e;
        view = {
          device: this.fromRow(await this.revokeInStore(row.id)),
          tokensRevoked: null,
          via: "store",
          serviceError: e.message,
        };
      }
    } else {
      view = {
        device: this.fromRow(await this.revokeInStore((row as DeviceRow).id)),
        tokensRevoked: null,
        via: "store",
        serviceError: null,
      };
    }
    await this.audit(
      DEVICE_AUDIT.revoked,
      `device=${deviceId} kind=${view.device.kind}`,
      view.via === "service"
        ? `revoked by the state service, ${view.tokensRevoked} session token(s) dropped`
        : view.serviceError
          ? `row revoked in the shared store; the state service failed: ${view.serviceError}`
          : "row revoked in the shared store",
    );
    if (!wasRevoked) await this.recordChange(view.device);
    return view;
  }

  /** Revoke the row in this daemon's store, re-read so a concurrent change is not lost. */
  private async revokeInStore(id: string): Promise<DeviceRow> {
    const current = await this.deps.store.device.mustGet(id);
    return current.revoked ? current : this.deps.store.device.revoke(current.id, current.version);
  }

  /**
   * The change log row of a revocation from Settings -> Devices, the same one the registry's
   * `device.revoke` writes for chat or voice (spec Q: nothing is UI-only): source `ui`, scope
   * `global`, before and after, irreversible (the device has to be paired again).
   */
  private async recordChange(device: DaemonDeviceView): Promise<void> {
    await this.deps.store.changeLog.record({
      human_id: this.deps.humanId,
      agent_id: this.deps.agentId ?? null,
      words_used: `Settings -> Devices: revoke ${device.name}`,
      commands: [{ name: "device.revoke", params: { device: device.id } }],
      before: { device_id: device.id, revoked: false },
      after: { device_id: device.id, revoked: true },
      scope: "global",
      project_id: null,
      undo_state: "irreversible",
      source: "ui",
      sentence: `Revoked the device ${device.name}; it must be paired again to reconnect.`,
      author_human: this.deps.humanId,
    });
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
    const timeoutMs = service.timeoutMs ?? DEVICE_SERVICE_TIMEOUT_MS;
    // A hung service must not hold the app's "Starting…" or "Revoking…" for minutes.
    const signal = AbortSignal.timeout(timeoutMs);
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
        signal,
      });
    } catch (e) {
      if (signal.aborted) {
        throw new ForerunnerError(
          "unavailable",
          `state service did not answer within ${timeoutMs} ms`,
          { details: { path: path.split("?")[0], timeoutMs }, cause: e },
        );
      }
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
    try {
      return (await res.json()) as T;
    } catch (e) {
      // A body cut off by the timeout or not JSON (a proxy's HTML page): the service is not
      // answering as itself.
      throw new ForerunnerError(
        "unavailable",
        signal.aborted
          ? `state service did not answer within ${timeoutMs} ms`
          : "state service answered with an unreadable body",
        { details: { path: path.split("?")[0], status: res.status }, cause: e },
      );
    }
  }
}
