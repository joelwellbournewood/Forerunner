import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
    return JSON.parse(readFileSync(p, "utf8")) as KillRequest;
  } catch {
    return null;
  }
}

export function clearKillRequest(runtimeDir: string = appDirs().runtime): void {
  const p = killFilePath(runtimeDir);
  if (existsSync(p)) unlinkSync(p);
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
