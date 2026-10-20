import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppDirs, type Clock, errorMessage, join, log } from "@forerunner/platform";
import type { DeviceRow, StateStore } from "@forerunner/state";

/**
 * The PC daemon's presence on the shared state (ADR 0033 item 9, ADR 0041): one `device` row
 * of kind "desktop" per install, whose `last_seen` the daemon refreshes on a fixed interval.
 * The cloud runner's PC-wins rule (`services/cloud-runner/src/presence.ts`) reads that row:
 * a desktop seen within its window means the PC runs the agent's schedules and the runner
 * stays idle; a daemon that stopped heartbeating looks offline after the window and the
 * runner takes over. The row is also the device remote commands can be addressed to.
 *
 * The public key is an identifier generated once and kept next to the install's config
 * (the daemon talks to Postgres directly, ADR 0024, and never authenticates to the state
 * service with it); a row that exists under that key is reused, else one named like this
 * machine, else a fresh row is registered.
 */
export const DESKTOP_DEVICE_FILE_NAME = "desktop-device.json";

export interface RegisterDesktopDeviceOptions {
  store: Pick<StateStore, "device">;
  dirs: Pick<AppDirs, "config">;
  humanId: string;
  /** The device name shown in Settings → Devices (default: the host name). */
  name: string;
  /** windows, linux, ... */
  platform: string;
}

function readIdentity(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { publicKey?: unknown };
    return typeof parsed.publicKey === "string" && parsed.publicKey.length > 0
      ? parsed.publicKey
      : null;
  } catch {
    return null;
  }
}

function writeIdentity(dirs: Pick<AppDirs, "config">, file: string, publicKey: string): void {
  mkdirSync(dirs.config, { recursive: true });
  writeFileSync(file, JSON.stringify({ kind: "desktop", publicKey }, null, 2), { mode: 0o600 });
}

/** The daemon's own `desktop` device row, registered on first use and reused after. */
export async function registerDesktopDevice(
  opts: RegisterDesktopDeviceOptions,
): Promise<DeviceRow> {
  const { store, dirs, humanId } = opts;
  const file = join(dirs.config, DESKTOP_DEVICE_FILE_NAME);
  const known = readIdentity(file);
  if (known) {
    const existing = await store.device.byPublicKey(known);
    if (existing && !existing.revoked && existing.owner_human_id === humanId) return existing;
  }
  const named = (
    await store.device.list({ owner_human_id: humanId, kind: "desktop", name: opts.name })
  )
    .filter((d) => !d.revoked)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (named) {
    writeIdentity(dirs, file, named.public_key);
    return named;
  }
  const fresh = randomBytes(32).toString("base64");
  const row = await store.device.register({
    owner_human_id: humanId,
    name: opts.name,
    platform: opts.platform,
    public_key: fresh,
    kind: "desktop",
  });
  writeIdentity(dirs, file, fresh);
  return row;
}

export interface DesktopPresenceDeps {
  store: Pick<StateStore, "device">;
  clock: Clock;
  deviceId: string;
  /** Heartbeat interval; the runner's window (`FORERUNNER_RUNNER_PC_ONLINE_MS`) should be larger. */
  intervalMs: number;
}

/** Refreshes the desktop device row's `last_seen` every `intervalMs` while started. */
export class DesktopPresence {
  private readonly logger = log("daemon:presence");
  private cancel: (() => void) | null = null;
  private beats = 0;
  private lastSeen: string | null = null;

  constructor(private readonly deps: DesktopPresenceDeps) {}

  get stats(): { beats: number; lastSeen: string | null; running: boolean } {
    return { beats: this.beats, lastSeen: this.lastSeen, running: this.cancel !== null };
  }

  /** Stamp `last_seen` now (also called once at start, before the first interval). */
  async beat(): Promise<void> {
    const now = this.deps.clock.nowIso();
    try {
      await this.deps.store.device.seen(this.deps.deviceId, now);
      this.beats++;
      this.lastSeen = now;
    } catch (e) {
      this.logger.warn("desktop presence heartbeat failed", { error: errorMessage(e) });
    }
  }

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      await this.beat();
      if (this.cancel) this.cancel = this.deps.clock.setTimeout(tick, this.deps.intervalMs);
    };
    this.cancel = this.deps.clock.setTimeout(tick, this.deps.intervalMs);
    void this.beat();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
