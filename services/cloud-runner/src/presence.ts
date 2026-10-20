import type { Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";

/**
 * "A PC daemon that is online wins" (ADR 0033). The cloud runner starts scheduled sessions only
 * while no PC daemon of the human is online. Two signals decide, either is enough:
 *
 *  1. a non-revoked `device` row of the human with kind "desktop" whose `last_seen` is within
 *     `pcOnlineMs` (the PC daemon heartbeats its device row; the state service also stamps
 *     `last_seen` on every request a device makes);
 *  2. an active `session` row (running or paused) of the agent with runner "pc": the PC is
 *     working right now, whatever its heartbeat says.
 *
 * Email-triggered and remote (target "cloud") sessions are not subject to the rule: the runner
 * is the mailbox watcher and the phone addressed it explicitly. The one-active-session-per-agent
 * check in the shared store still stops any overlap.
 */
export interface PresenceVerdict {
  pcOnline: boolean;
  reason: "desktop_seen" | "pc_session" | "none";
  deviceId?: string;
  sessionId?: string;
  checkedAt: string;
}

export interface PcPresenceDeps {
  store: Pick<StateStore, "device" | "session">;
  clock: Clock;
  humanId: string;
  agentId: string;
  pcOnlineMs: number;
}

export class PcPresence {
  private last: PresenceVerdict | null = null;

  constructor(private readonly deps: PcPresenceDeps) {}

  /** The last verdict without a query (for the health view). */
  get lastVerdict(): PresenceVerdict | null {
    return this.last;
  }

  async check(now: number = this.deps.clock.now()): Promise<PresenceVerdict> {
    const checkedAt = new Date(now).toISOString();
    const devices = await this.deps.store.device.list({
      owner_human_id: this.deps.humanId,
      kind: "desktop",
      revoked: false,
    });
    const threshold = now - this.deps.pcOnlineMs;
    for (const d of devices) {
      if (d.last_seen && Date.parse(d.last_seen) >= threshold) {
        this.last = { pcOnline: true, reason: "desktop_seen", deviceId: d.id, checkedAt };
        return this.last;
      }
    }
    const active = await this.deps.store.session.active(this.deps.agentId);
    const pc = active.find((s) => s.runner === "pc");
    if (pc) {
      this.last = { pcOnline: true, reason: "pc_session", sessionId: pc.id, checkedAt };
      return this.last;
    }
    this.last = { pcOnline: false, reason: "none", checkedAt };
    return this.last;
  }
}
