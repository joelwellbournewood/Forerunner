import { defineConfig } from "vitest/config";

// Three projects:
//  unit        - no network, fake provider only, runs on every PR on Windows and Linux
//  integration - needs the stand-ins (local Postgres, mail server, fake git host, Docker where available)
//  e2e         - the nine scenarios; live models inside the testing budget share
// Each runs with CI's environment on any machine (testenv/src/ci-env.ts): no git identity and
// FORCE_COLOR=1, as ci.yml has.
const setupFiles = ["testenv/src/ci-env.ts"];

export default defineConfig({
  test: {
    passWithNoTests: true,
    // One temp folder per run for all three projects (testenv/src/test-tmp.ts; testing.md,
    // "Where test temp files go"): TMPDIR, TMP and TEMP point into it before any worker starts,
    // and the run removes it at its end. Named here, at the root, it runs once per vitest run
    // whatever `--project` picks (vitest runs the root's global setup for every project).
    globalSetup: ["testenv/src/test-tmp-global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            "services/*/test/**/*.test.ts",
            "testenv/test/**/*.test.ts",
            "evals/test/**/*.test.ts",
            "scripts/**/*.test.ts",
            "apps/mobile/e2e/**/*.test.ts",
          ],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
          environment: "node",
          setupFiles,
          testTimeout: 20_000,
          // Suites that compose the whole runtime in beforeAll have exceeded the 10 s default on cold Windows runners.
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "packages/*/test/**/*.integration.test.ts",
            "services/*/test/**/*.integration.test.ts",
            "testenv/test/**/*.integration.test.ts",
          ],
          environment: "node",
          setupFiles,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/scenarios/**/*.test.ts"],
          environment: "node",
          setupFiles,
          testTimeout: 1_800_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**", "services/*/src/**"],
    },
  },
});
