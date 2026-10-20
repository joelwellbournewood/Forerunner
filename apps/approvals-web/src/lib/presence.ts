import type { DeviceView, RemoteCommandView, SessionView } from "../api/types.ts";

/**
 * Is a PC there to execute remote commands? Chat and the kill switch are relayed to the
 * desktop runtime (spec R.4, ADR 0026), so the page says plainly when nothing can pick them
 * up. Three signals, any of which counts: a `desktop` device seen within `staleMs`, a
 * session running or paused on the `pc` runner, or a remote command a runner touched within
 * `staleMs`. Cloud activity is reported separately so a kill can reach the runner too.
 */
export interface PresenceInput {
  devices: readonly DeviceView[];
  sessions: readonly SessionView[];
  commands: readonly RemoteCommandView[];
  now: number;
  staleMs?: number;
}

export interface Presence {
  pcOnline: boolean;
  cloudActive: boolean;
  /** Plain words for the screen when nothing is online. */
  reason: string;
}

export const DEFAULT_STALE_MS = 5 * 60 * 1000;
const LIVE = new Set(["running", "paused"]);

function recent(iso: string | null, now: number, staleMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t <= staleMs;
}

export function pcPresence(input: PresenceInput): Presence {
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
  const desktopSeen = input.devices.some(
    (d) => d.kind === "desktop" && !d.revoked && recent(d.lastSeen, input.now, staleMs),
  );
  const pcSession = input.sessions.some((s) => s.runner === "pc" && LIVE.has(s.status));
  const pickedUp = input.commands.some(
    (c) => c.target === "pc" && c.status !== "pending" && recent(c.updatedAt, input.now, staleMs),
  );
  const cloudActive = input.sessions.some((s) => s.runner === "cloud" && LIVE.has(s.status));
  const pcOnline = desktopSeen || pcSession || pickedUp;
  return {
    pcOnline,
    cloudActive,
    reason: pcOnline
      ? ""
      : "No PC is online. Start the Forerunner desktop app on your PC; this page notices within a few seconds.",
  };
}
