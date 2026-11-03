import { defineConfig } from "vitest/config";

/**
 * The child run of `testenv/test/test-tmp.test.ts`: the same global setup as every vitest config
 * in the repository, and test files that leave what they make in the temp folder. The parent
 * starts it with TMPDIR, TMP and TEMP pointing at a folder of its own (the child's "system temp
 * folder") and checks that nothing is left there afterwards. Not part of any suite: `*.check.ts`
 * matches no project's include.
 */
export default defineConfig({
  test: {
    include: ["*.check.ts"],
    environment: "node",
    globalSetup: ["../../../src/test-tmp-global-setup.ts"],
    testTimeout: 60_000,
  },
});
