import type { APIRequestContext } from "@playwright/test";

/** The fake daemon's address and token, pinned by playwright.config.ts. */
export function daemonUrl(): string {
  return `http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_PORT}`;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` };
}

/** Put the fake daemon back to its fixtures; every spec starts from the same state. */
export async function resetDaemon(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${daemonUrl()}/__test/reset`, { headers: headers() });
  if (!res.ok()) throw new Error(`fake daemon reset failed: ${res.status()}`);
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** What the UI posted so far. */
export async function recordedCalls(request: APIRequestContext): Promise<RecordedCall[]> {
  const res = await request.get(`${daemonUrl()}/__test/calls`, { headers: headers() });
  return (await res.json()) as RecordedCall[];
}
