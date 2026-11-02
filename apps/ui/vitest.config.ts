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
    passWithNoTests: true,
  },
});
