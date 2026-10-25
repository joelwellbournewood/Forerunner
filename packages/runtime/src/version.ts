import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The app's version: the root package.json's, which `scripts/release-version.mjs --set` stamps
 * from the release tag in every release build (release.md "Versions and the changelog"), so the
 * daemon, `fr` and the artefacts report the version their tag names. `FORERUNNER_VERSION`
 * overrides it for one process (tests, the update harness).
 */
export const APP_VERSION: string = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;
