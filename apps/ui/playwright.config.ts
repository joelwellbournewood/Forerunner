import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests drive the real UI against the fake daemon (test/fake-daemon.ts). Two web
 * servers start before the run: the fake daemon on a free 127.0.0.1 port and the Vite dev
 * server on another, with VITE_DAEMON_URL / VITE_DAEMON_TOKEN pointing at the fake. Ports and
 * the token are chosen once in the runner process and pinned through the environment, because
 * Playwright loads this file again in every worker. Headless, one worker, under two minutes.
 */

function freePort(): number {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim());
}

process.env.FORERUNNER_UI_FAKE_PORT ||= String(freePort());
process.env.FORERUNNER_UI_PORT ||= String(freePort());
process.env.FORERUNNER_UI_FAKE_TOKEN ||= randomBytes(16).toString("hex");
// The phone specs (e2e/mobile-*.spec.ts) run the same bundle under /m against a fake shared
// state service (test/fake-state-service.ts) with the real request-signature checks.
process.env.FORERUNNER_UI_FAKE_STATE_PORT ||= String(freePort());
process.env.FORERUNNER_UI_FAKE_STATE_TOKEN ||= randomBytes(16).toString("hex");

const daemonUrl = `http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_PORT}`;
const stateUrl = `http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_STATE_PORT}`;
const baseURL = `http://127.0.0.1:${process.env.FORERUNNER_UI_PORT}`;
const token = process.env.FORERUNNER_UI_FAKE_TOKEN;
const stateToken = process.env.FORERUNNER_UI_FAKE_STATE_TOKEN;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  globalTimeout: 360_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../test-results/ui-report" }]],
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "pnpm exec tsx test/fake-daemon.ts",
      url: `${daemonUrl}/health`,
      env: {
        FAKE_DAEMON_PORT: String(process.env.FORERUNNER_UI_FAKE_PORT),
        FAKE_DAEMON_TOKEN: token,
        FAKE_DAEMON_EVENT_DELAY_MS: "400",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm exec tsx test/fake-state-service.ts",
      url: `${stateUrl}/health`,
      env: {
        FAKE_STATE_PORT: String(process.env.FORERUNNER_UI_FAKE_STATE_PORT),
        FAKE_STATE_ADMIN_TOKEN: stateToken,
        FAKE_STATE_PC_MS: "300",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${process.env.FORERUNNER_UI_PORT} --strictPort --host 127.0.0.1`,
      url: baseURL,
      env: { VITE_DAEMON_URL: daemonUrl, VITE_DAEMON_TOKEN: token },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
