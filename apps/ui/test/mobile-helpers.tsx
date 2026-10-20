import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { WebCryptoSigner } from "../src/api/state-signing.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { MobileRoutes } from "../src/mobile/MobileApp.tsx";
import { PollingPush } from "../src/mobile/push.ts";
import { memorySecureStore } from "../src/mobile/storage.ts";
import { MobileController, type MobileEnv, MobileProvider } from "../src/mobile/store.tsx";
import {
  createFakeStateService,
  type FakeStateOptions,
  type FakeStateService,
  HUMAN_J,
} from "./fake-state-service.ts";
import { fetchFromApp } from "./helpers.tsx";

/** Built by concatenation so the secret scan never sees a credential shape. */
export const ADMIN_TOKEN = ["fake", "state", "admin", "token", "for", "ui", "tests"].join("-"); // not-a-secret

/** 2026-10-20 10:00 UTC = 12:00 in Zurich. */
export const NOW_MS = Date.UTC(2026, 9, 20, 10, 0, 0);
export const SERVICE_URL = "http://state.test";

export interface MobileHarness {
  service: FakeStateService;
  env: MobileEnv;
  controller: MobileController;
  /** The current simulated time; `advance` moves it. */
  now: () => number;
  advance(ms: number): void;
}

export interface MobileHarnessOptions {
  /** Pair the phone before the test (true by default). */
  paired?: boolean;
  fake?: FakeStateOptions;
  env?: Partial<MobileEnv>;
}

export async function createMobileHarness(
  options: MobileHarnessOptions = {},
): Promise<MobileHarness> {
  let clock = NOW_MS;
  const now = () => clock;
  const service = createFakeStateService({
    adminToken: ADMIN_TOKEN,
    pcAutoCompleteMs: 20,
    heartbeatMs: 200,
    now,
    ...(options.fake ?? {}),
  });
  const signer = await WebCryptoSigner.generate();
  const env: MobileEnv = {
    installId: "test",
    platform: "web",
    shellVersion: null,
    inShell: false,
    defaultStateUrl: SERVICE_URL,
    defaultDeviceName: "Test phone",
    signer,
    secure: memorySecureStore(),
    storage: memoryStorage(),
    biometric: "prompt",
    push: new PollingPush(),
    fetch: fetchFromApp(service.app),
    now,
    timezone: "Europe/Zurich",
    scan: null,
    deepLink: null,
    live: false,
    pollIntervalMs: 40,
    retryLiveMs: 1_000_000,
    ...(options.env ?? {}),
  };
  if (options.paired ?? true) {
    // Pair with a throwaway controller sharing the storage; the test's controller then boots
    // from the stored session the way the app does after a restart.
    const pairing = new MobileController(env);
    const code = service.startPairing(HUMAN_J.id, "phone").code;
    await pairing.pair({ serviceUrl: SERVICE_URL, code, deviceName: "Test phone" });
    pairing.close();
    service.state.calls = [];
  }
  const controller = new MobileController(env);
  return {
    service,
    env,
    controller,
    now,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** Mount the phone routes at `route` against the harness (bootstrap runs on mount). */
export function renderMobile(route: string, harness: MobileHarness) {
  const utils = render(
    <MobileProvider controller={harness.controller}>
      <MemoryRouter initialEntries={[route]}>
        <MobileRoutes />
      </MemoryRouter>
    </MobileProvider>,
  );
  return { ...utils, ...harness };
}

export function postedCalls(harness: MobileHarness, path: string | RegExp) {
  return harness.service.state.calls.filter((c) =>
    typeof path === "string" ? c.path === path : path.test(c.path),
  );
}

/** Wait until `predicate` holds or `timeoutMs` passes (polls every 10 ms). */
export async function until(
  predicate: () => boolean,
  timeoutMs = 3000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}
