import { readFileSync } from "node:fs";
import {
  type AppDirs,
  acquireExclusiveLock,
  ForerunnerError,
  type HeldLock,
  isForerunnerError,
  join,
} from "@forerunner/platform";

/**
 * One daemon per data folder (U-065). `fr daemon` takes an exclusive lock in the runtime folder
 * (where `daemon.json` lives) and in the data folder (the store, versions, dependencies) before
 * it composes anything, and holds both for as long as the process runs: the operating system
 * releases them when it ends, a crash included (`acquireExclusiveLock`). A second `fr daemon`
 * on the same folders is refused at once with a message saying what runs and what to do;
 * before, a daemon slow to answer could get a second one started beside it, both wrote the same
 * store, and whichever stopped first deleted the other's `daemon.json`.
 */
export const DAEMON_LOCK_FILE = "daemon.lock";

/** The pid `daemon.json` names, for the refusal's text; null when there is none to read. */
function recordedDaemonPid(runtimeDir: string): number | null {
  try {
    const pid = (
      JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8")) as {
        pid?: unknown;
      }
    ).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/** What a second `fr daemon` prints: what runs, on which data, and what to do. */
export function daemonLockedMessage(dirs: AppDirs): string {
  const pid = recordedDaemonPid(dirs.runtime);
  const who = pid
    ? `Another Forerunner background service (process ${pid}) is already running`
    : "Another Forerunner background service is already running";
  return `${who} on the data folder ${dirs.data}. Only one can run per data folder, so this one does not start. Quit Forerunner from the tray, or end that process, then start it again.`;
}

export async function acquireDaemonLock(dirs: AppDirs): Promise<HeldLock> {
  const folders = [...new Set([dirs.runtime, dirs.data])];
  const held: HeldLock[] = [];
  for (const folder of folders) {
    try {
      held.push(await acquireExclusiveLock(folder, DAEMON_LOCK_FILE));
    } catch (e) {
      for (const h of held) await h.release();
      if (isForerunnerError(e, "unavailable") && e.details.reason === "locked") {
        throw new ForerunnerError("unavailable", daemonLockedMessage(dirs), {
          details: { reason: "daemon_running", folder, lock: e.details.path },
          retryable: true,
          cause: e,
        });
      }
      throw e;
    }
  }
  return {
    path: held[0]?.path ?? join(dirs.runtime, DAEMON_LOCK_FILE),
    async release() {
      for (const h of held) await h.release();
    },
  };
}
