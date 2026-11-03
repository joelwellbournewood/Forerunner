import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // One temp folder per run, removed at its end (testenv/src/test-tmp.ts; testing.md, "Where
    // test temp files go").
    globalSetup: ["../../testenv/src/test-tmp-global-setup.ts"],
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
