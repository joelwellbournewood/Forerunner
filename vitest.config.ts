import { defineConfig } from "vitest/config";

// Three projects:
//  unit        - no network, fake provider only, runs on every PR on Windows and Linux
//  integration - needs the stand-ins (local Postgres, mail server, fake git host, Docker where available)
//  e2e         - the nine scenarios; live models inside the testing budget share
export default defineConfig({
  test: {
    passWithNoTests: true,
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
