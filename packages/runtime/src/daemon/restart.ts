import type { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppDirs, type Clock, errorMessage, join, log } from "@forerunner/platform";
import type { Restarter, RestartRequest } from "../update/ports.ts";

/**
 * The daemon's "Update and restart" (spec M, ADR 0015). The daemon cannot relaunch itself and
 * never spawns a shell; it writes a restart request next to `daemon.json` and exits with
 * `RESTART_EXIT_CODE`. The shells (the desktop sidecar supervisor, the Android service, the
 * `fr daemon` wrapper scripts) treat that exit code as "relaunch into the version named by
 * `current.json`"; any other code is a crash. The request file tells them why and from
 * which version, and is removed by the shell once it has acted on it.
 */
export const RESTART_EXIT_CODE = 86;
export const RESTART_REQUEST_FILE = "restart.json";

export interface RestartRequestFile extends RestartRequest {
  schema: 1;
  requestedAt: string;
  pid: number;
  exitCode: number;
}

export function restartRequestPath(dirs: AppDirs): string {
  return join(dirs.runtime, RESTART_REQUEST_FILE);
}

/** The pending restart request, or null when none exists or it is unreadable. */
export function readRestartRequest(dirs: AppDirs): RestartRequestFile | null {
  const file = restartRequestPath(dirs);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RestartRequestFile>;
    if (parsed.schema !== 1 || typeof parsed.targetVersion !== "string") return null;
    return parsed as RestartRequestFile;
  } catch {
    return null;
  }
}

export interface DaemonRestarterDeps {
  dirs: AppDirs;
  clock: Clock;
  /** `restart` is emitted with the request before the process exits (the server stops first). */
  events?: EventEmitter;
  /** Ends the process; injectable so tests record the code instead of exiting. */
  exit: (code: number) => void;
}

export class DaemonRestarter implements Restarter {
  private readonly logger = log("daemon:restart");
  readonly requests: RestartRequestFile[] = [];

  constructor(private readonly deps: DaemonRestarterDeps) {}

  async restart(req: RestartRequest): Promise<void> {
    const record: RestartRequestFile = {
      schema: 1,
      reason: req.reason,
      targetVersion: req.targetVersion,
      fromVersion: req.fromVersion,
      requestedAt: this.deps.clock.nowIso(),
      pid: process.pid,
      exitCode: RESTART_EXIT_CODE,
    };
    const file = restartRequestPath(this.deps.dirs);
    try {
      mkdirSync(this.deps.dirs.runtime, { recursive: true });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows has no POSIX modes; the runtime directory is under the user's profile.
      }
    } catch (e) {
      this.logger.error("could not write the restart request", { file, error: errorMessage(e) });
      throw e;
    }
    this.requests.push(record);
    this.logger.info("restart requested", {
      reason: record.reason,
      from: record.fromVersion,
      to: record.targetVersion,
      exitCode: RESTART_EXIT_CODE,
    });
    this.deps.events?.emit("restart", record);
    this.deps.exit(RESTART_EXIT_CODE);
  }
}

/**
 * The production `exit`: give the HTTP response and the log a moment to flush, then exit with
 * the code. `fr daemon` installs its own that also stops the server and closes the store.
 */
export function processExit(delayMs = 500): (code: number) => void {
  return (code) => {
    setTimeout(() => process.exit(code), delayMs);
  };
}
