import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appDirs, type Clock, join, log } from "@forerunner/platform";
import type { KillScope, KillSwitch } from "./killswitch.ts";

/**
 * Cross-process kill switch: the CLI, the tray and the app write a request file into the
 * runtime directory; every running runtime polls it and stops the matching scope. Simple,
 * works on Windows and Linux, needs no socket permissions.
 */
export interface KillRequest {
  scope: KillScope | "all";
  reason: string;
  requestedAt: string;
  requestedBy: string;
}

export function killFilePath(runtimeDir: string = appDirs().runtime): string {
  return join(runtimeDir, "kill.json");
}

export function writeKillRequest(req: KillRequest, runtimeDir: string = appDirs().runtime): string {
  mkdirSync(runtimeDir, { recursive: true });
  const p = killFilePath(runtimeDir);
  writeFileSync(p, JSON.stringify(req, null, 2));
  return p;
}

export function readKillRequest(runtimeDir: string = appDirs().runtime): KillRequest | null {
  const p = killFilePath(runtimeDir);
  if (!existsSync(p)) return null;
  try {
    return parseKillRequest(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The request as the watcher may act on it. Anything that is not an object with a
 * `requestedAt` is no request (ignored, like unparseable JSON). A scope that is neither
 * `"all"` nor an object naming an agent or a session is read as `"all"`: the kill switch
 * would stop every registration for such a scope anyway but freeze nothing, so new work
 * would start at once; failing closed keeps "stopped" and "frozen" the same set.
 */
export function parseKillRequest(raw: unknown): KillRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestedAt !== "string" || r.requestedAt === "") return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  let scope: KillScope | "all" = "all";
  if (r.scope && typeof r.scope === "object" && !Array.isArray(r.scope)) {
    const s = r.scope as Record<string, unknown>;
    const agentId = str(s.agentId);
    const sessionId = str(s.sessionId);
    if (agentId || sessionId) {
      scope = { ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}) };
    }
  }
  return {
    scope,
    reason: str(r.reason) ?? "",
    requestedAt: r.requestedAt,
    requestedBy: str(r.requestedBy) ?? "unknown",
  };
}

/**
 * Remove the request so the next start does not apply it again. The daemon's kill switch calls
 * this on every `resume()` (its `onResume`, wired in `daemon/compose.ts`; U-019, U-032). A file
 * already gone is fine; any other failure throws, and the kill stays in force.
 */
export function clearKillRequest(runtimeDir: string = appDirs().runtime): void {
  rmSync(killFilePath(runtimeDir), { force: true });
}

export class KillFileWatcher {
  private cancel: (() => void) | null = null;
  private lastSeen: string | null = null;
  private readonly logger = log("killfile");

  constructor(
    private readonly kill: KillSwitch,
    private readonly clock: Clock,
    private readonly runtimeDir: string = appDirs().runtime,
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    if (this.cancel) return;
    const tick = async () => {
      await this.check();
      this.cancel = this.clock.setTimeout(tick, this.intervalMs);
    };
    this.cancel = this.clock.setTimeout(tick, this.intervalMs);
  }

  async check(): Promise<boolean> {
    const req = readKillRequest(this.runtimeDir);
    if (!req || req.requestedAt === this.lastSeen) return false;
    this.lastSeen = req.requestedAt;
    this.logger.warn("kill request received", {
      scope: req.scope,
      by: req.requestedBy,
      reason: req.reason,
    });
    await this.kill.stop(req.scope, `${req.requestedBy}: ${req.reason}`);
    return true;
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
