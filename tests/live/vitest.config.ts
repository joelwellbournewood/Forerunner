import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * The live harness has its own vitest project: it is not in the root `vitest.config.ts` and
 * not in CI. Every live case is `it.skipIf`'d (visibly) unless `FORERUNNER_LIVE=1`, which the
 * `test:live` script sets through `--mode live`. One vitest invocation is one *run* for the
 * spend ledger: the run id is minted here, once, and handed to every test file through the
 * environment, so the per-run cap (`FORERUNNER_LIVE_RUN_CAP_USD`) covers all files together.
 * Files run one after another, in path order, so the cheap phase 1 half and the timing table
 * come before the calibration and the ledger is never written from two workers at once.
 */
class PathOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig(({ mode }) => {
  const live = mode === "live" || process.env.FORERUNNER_LIVE === "1";
  // Tooling, not runtime code: the config loader runs under plain Node, where the platform
  // package's Clock cannot be imported, so the run id is minted from the wall clock here.
  const run = process.env.FORERUNNER_LIVE_RUN ?? new Date().toISOString();
  return {
    test: {
      name: "live",
      include: ["test/**/*.test.ts"],
      exclude: ["**/node_modules/**"],
      environment: "node",
      env: { ...(live ? { FORERUNNER_LIVE: "1" } : {}), FORERUNNER_LIVE_RUN: run },
      fileParallelism: false,
      sequence: { sequencer: PathOrderSequencer },
      testTimeout: 1_800_000,
      hookTimeout: 600_000,
    },
  };
});
