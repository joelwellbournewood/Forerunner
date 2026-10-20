import type { APIRequestContext, Page } from "@playwright/test";

/**
 * The phone specs: the same bundle under `/m`, told by an injected `window.__FORERUNNER__`
 * that it runs in the Android shell (`platform: "android"`) with the fake state service's
 * address. Outside the Tauri shell the key is WebCrypto and the biometric prompt is the
 * simulated dialog; the fake service verifies every signature with the real crypto module.
 */
export function stateUrl(): string {
  return `http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_STATE_PORT}`;
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_STATE_TOKEN ?? ""}`,
    "Content-Type": "application/json",
  };
}

export async function resetState(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${stateUrl()}/__test/reset`, { headers: adminHeaders() });
  if (!res.ok()) throw new Error(`fake state service reset failed: ${res.status()}`);
}

/** What the desktop does: start a pairing and show the code. */
export async function startPairing(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${stateUrl()}/__test/pair`, {
    headers: adminHeaders(),
    data: { humanId: "human_j", kind: "phone" },
  });
  if (!res.ok()) throw new Error(`pairing start failed: ${res.status()}`);
  return ((await res.json()) as { code: string }).code;
}

export interface StateCall {
  method: string;
  path: string;
  body: unknown;
  signed: boolean;
  biometric: boolean;
  principal: string;
  deviceId: string | null;
}

export async function stateCalls(request: APIRequestContext): Promise<StateCall[]> {
  const res = await request.get(`${stateUrl()}/__test/calls`, { headers: adminHeaders() });
  return (await res.json()) as StateCall[];
}

export interface FakeState {
  devices: { id: string; revoked: boolean; name: string }[];
  remoteCommands: {
    id: string;
    command: string;
    status: string;
    params: Record<string, unknown>;
    result: unknown;
  }[];
  requests: { id: string; status: string; answer: unknown }[];
  sessions: { id: string; status: string; projectId: string | null }[];
}

export async function fakeState(request: APIRequestContext): Promise<FakeState> {
  const res = await request.get(`${stateUrl()}/__test/state`, { headers: adminHeaders() });
  return (await res.json()) as FakeState;
}

/** Make the page believe it is the Android shell pointed at the fake service. */
export async function injectAndroidShell(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url }) => {
      window.__FORERUNNER__ = {
        platform: "android",
        stateUrl: url,
        installId: "e2e-phone",
        shellVersion: "e2e",
        deviceName: "Playwright phone",
      };
    },
    { url: stateUrl() },
  );
}

/** Pair through the UI: code entry always works (no scanner in a browser). */
export async function pairPhone(page: Page, request: APIRequestContext): Promise<void> {
  const code = await startPairing(request);
  await page.goto("/m");
  await page.getByTestId("m-pair-code").fill(code);
  await page.getByTestId("m-pair-submit").click();
  await page.getByRole("heading", { name: "Projects" }).waitFor();
}
