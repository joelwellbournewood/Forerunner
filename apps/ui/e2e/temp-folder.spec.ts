import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { ENV_RUN, isRunFolder, TEMP_VARS } from "../../../testenv/src/test-tmp.ts";

// playwright.config.ts makes one temp folder per run in the runner process, before the web
// servers and the workers start, and removes it when the runner exits (testing.md, "Where test
// temp files go"). A worker, and the browser it launches, inherit it.
test("the browser tests run in the run's own temp folder: TMPDIR, TMP and TEMP point at it", () => {
  const run = process.env[ENV_RUN];
  expect(run, "apps/ui/playwright.config.ts calls startTestTmp()").toBeTruthy();
  expect(tmpdir()).toBe(run);
  for (const k of TEMP_VARS) expect(process.env[k], k).toBe(run);
  expect(isRunFolder(run as string)).toBe(true);
});
