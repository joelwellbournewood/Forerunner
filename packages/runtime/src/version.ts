import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The app's version: the root package.json's, which `scripts/release-version.mjs --set` stamps
 * from the release tag in every release build (release.md "Versions and the changelog"), so the
 * daemon, `fr` and the artefacts report the version their tag names. `FORERUNNER_VERSION`
 * overrides it for one process (tests, the update harness).
 */
export const APP_VERSION: string = readAppVersion();

function readAppVersion(): string {
  try {
    const root = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const v = (JSON.parse(readFileSync(root, "utf8")) as { version?: unknown }).version;
    if (typeof v === "string" && v) return v;
  } catch {
    // A partial install without the root package.json still starts; its health check and
    // `fr doctor` then report 0.0.0 instead of every command crashing at import.
  }
  return "0.0.0";
}
