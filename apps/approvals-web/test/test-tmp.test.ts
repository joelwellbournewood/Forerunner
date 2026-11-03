import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ENV_RUN, isRunFolder, TEMP_VARS } from "../../../testenv/src/test-tmp.ts";

// This run's own temp folder, removed at its end (vitest.config.ts's globalSetup; testing.md,
// "Where test temp files go").
it("the approvals web suite runs in its run's own temp folder: TMPDIR, TMP and TEMP point at it", () => {
  const run = process.env[ENV_RUN];
  expect(
    run,
    "apps/approvals-web/vitest.config.ts names testenv/src/test-tmp-global-setup.ts",
  ).toBeTruthy();
  expect(tmpdir()).toBe(run);
  for (const k of TEMP_VARS) expect(process.env[k], k).toBe(run);
  expect(isRunFolder(run as string)).toBe(true);
});
