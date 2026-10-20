import { defineConfig, devices } from "@playwright/test";

// Simulated users drive the real UI through Playwright (spec: internal test environment).
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../test-results/ui-report" }]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
