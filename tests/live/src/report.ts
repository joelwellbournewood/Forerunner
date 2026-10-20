import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, safeSegment } from "@forerunner/platform";

/**
 * Where a live run leaves its evidence files (the JSON reports the gate rows cite):
 * `FORERUNNER_LIVE_REPORT_DIR` when set, else a fresh temp directory whose path is printed.
 */
export const REPORT_DIR_VAR = "FORERUNNER_LIVE_REPORT_DIR";
export const LIVE_VAR = "FORERUNNER_LIVE";
export const RUN_VAR = "FORERUNNER_LIVE_RUN";

export function liveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_VAR] === "1";
}

/** The reason every live case prints when it is skipped. */
export const SKIP_REASON =
  "skipped: FORERUNNER_LIVE is not set (live model calls are opt-in: pnpm --filter @forerunner/live test:live)";

export function runIdFromEnv(env: NodeJS.ProcessEnv = process.env, fallback: string): string {
  const run = env[RUN_VAR]?.trim();
  return run && run !== "" ? run : fallback;
}

export function reportDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[REPORT_DIR_VAR]?.trim();
  if (configured) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  return mkdtempSync(join(tmpdir(), "fr-live-report-"));
}

export function writeReport(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeSegment(name, "report")}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

export function usd(n: number): string {
  return `USD ${n.toFixed(4)}`;
}
