import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Screen tests render whole pages through a fake daemon; loaded runners need more than 5 s.
    testTimeout: 20_000,
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    // CI's environment on any machine (no git identity, FORCE_COLOR=1): testenv/src/ci-env.ts.
    setupFiles: ["../../testenv/src/ci-env.ts", "./test/setup.ts"],
    // One temp folder per run, removed at its end (testenv/src/test-tmp.ts; testing.md, "Where
    // test temp files go"): the real daemons and git these tests start write there too.
    globalSetup: ["../../testenv/src/test-tmp-global-setup.ts"],
    passWithNoTests: true,
  },
});
