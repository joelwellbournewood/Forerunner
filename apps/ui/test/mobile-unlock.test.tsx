import { randomBytes } from "node:crypto";
import { runnerKeySecureStoreKey } from "@forerunner/vault/runner-unlock";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { UnlockAnswer } from "../src/lib/runner-unlock.ts";
import { secureStoreRunnerKeys } from "../src/lib/runner-unlock.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { memorySecureStore, mobileKey } from "../src/mobile/storage.ts";
import {
  createMobileHarness,
  type MobileHarness,
  NOW_MS,
  postedCalls,
  renderMobile,
} from "./mobile-helpers.tsx";
import { keyEncodings, runnerChallenge, unlockRequest } from "./runner-challenge.ts";

/**
 * The phone's cloud runner unlock card (spec S.12, ADR 0068): the key comes out of the shell's
 * Keystore-wrapped secure store (a memory store stands in) for the one call and is wrapped with
 * WebCrypto; the answer is high risk, so it is device-signed and sent only after the biometric
 * prompt; the window is set or cleared with the answer; inside the window this phone set, the
 * next challenge is answered without a choice (the fingerprint still); a browser without a
 * keyring shows the card read-only.
 */
const RUNNER = "runner-eu";
const WINDOW_KEY = mobileKey("test", "runnerUnlockWindow");

async function setup(opts: { withKey?: boolean; keyring?: boolean; windowUntil?: string } = {}) {
  const key = randomBytes(32);
  const secure = memorySecureStore();
  if (opts.withKey !== false)
    await secure.set(runnerKeySecureStoreKey(RUNNER), key.toString("base64"));
  const storage = memoryStorage();
  if (opts.windowUntil) storage.set(WINDOW_KEY, opts.windowUntil);
  const h = await createMobileHarness({
    env: {
      secure,
      storage,
      ...(opts.keyring === false ? {} : { runnerKeys: secureStoreRunnerKeys(secure) }),
    },
  });
  const challenge = runnerChallenge(RUNNER, 10 * 60_000, NOW_MS);
  const request = unlockRequest(challenge.card, { now: NOW_MS });
  h.service.state.requests.push(request);
  return { key, h, challenge, request };
}

function answerCall(h: MobileHarness, requestId: string) {
  const calls = postedCalls(h, `/requests/${requestId}/answer`);
  expect(calls).toHaveLength(1);
  return calls[0] as { signed: boolean; biometric: boolean; body: { answer: unknown } };
}

function expectNoKeyAnywhere(key: Buffer, h: MobileHarness) {
  const surfaces = [document.body.innerHTML, JSON.stringify(h.service.state.calls)].join("\n");
  for (const enc of keyEncodings(key)) expect(surfaces).not.toContain(enc);
}

async function confirmBiometric(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId("m-biometric-dialog");
  await user.click(screen.getByTestId("m-biometric-confirm"));
}

describe("phone unlock card", () => {
  it("shows the runner, the time and the challenge's age; unlock once sends the wrapped key after the fingerprint", async () => {
    const { key, h, challenge, request } = await setup();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    const card = within(await screen.findByTestId("m-unlock-card"));
    expect(card.getByTestId("m-unlock-runner")).toHaveTextContent(RUNNER);
    expect(card.getByTestId("m-unlock-age")).toHaveTextContent(/2 min old · expires in 10 min/);
    const li = screen.getByTestId("m-unlock-card").closest("li") as HTMLElement;
    expect(within(li).getByTestId("m-request-high")).toHaveTextContent(/fingerprint or face/);
    expect(within(li).queryByTestId("m-option")).toBeNull();
    expect(within(li).queryByTestId("m-free-text")).toBeNull();

    await user.click(await card.findByTestId("m-unlock-once"));
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    const call = answerCall(h, request.id);
    expect(call).toMatchObject({ signed: true, biometric: true });
    const answer = call.body.answer as UnlockAnswer;
    expect("autoUnlockUntil" in answer).toBe(false);
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expectNoKeyAnywhere(key, h);
    expect(h.controller.state.unlockWindowUntil).toBeNull();
  });

  it("a cancelled fingerprint sends nothing and keeps the card", async () => {
    const { h, request } = await setup();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await user.click(await screen.findByTestId("m-unlock-once"));
    await screen.findByTestId("m-biometric-dialog");
    await user.click(screen.getByTestId("m-biometric-cancel"));
    expect(await screen.findByTestId("m-unlock-error")).toHaveTextContent(/biometric/);
    expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(0);
    expect(screen.getByTestId("m-unlock-card")).toBeInTheDocument();
  });

  it("sets the window with the answer and remembers it on the phone; clear sends null", async () => {
    const { key, h, challenge, request } = await setup();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await user.click(await screen.findByTestId("m-unlock-window-24"));
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    const answer = answerCall(h, request.id).body.answer as UnlockAnswer;
    expect(answer.autoUnlockUntil).toBe(new Date(NOW_MS + 24 * 3_600_000).toISOString());
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expect(h.controller.state.unlockWindowUntil).toBe(answer.autoUnlockUntil);
    expect(h.env.storage.get(WINDOW_KEY)).toBe(answer.autoUnlockUntil);
  });

  it("unlock and clear the window sends null and drops the phone's record", async () => {
    const { key, h, challenge, request } = await setup({
      windowUntil: new Date(NOW_MS - 1_000).toISOString(),
    });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await user.click(await screen.findByTestId("m-unlock-clear"));
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    const answer = answerCall(h, request.id).body.answer as UnlockAnswer;
    expect(answer.autoUnlockUntil).toBeNull();
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expect(h.env.storage.get(WINDOW_KEY)).toBeNull();
    expect(h.controller.state.unlockWindowUntil).toBeNull();
  });

  it("deny answers deny (still confirmed with the fingerprint)", async () => {
    const { h, request } = await setup();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await user.click(await screen.findByTestId("m-unlock-deny"));
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    expect(answerCall(h, request.id)).toMatchObject({ biometric: true, body: { answer: "deny" } });
  });

  it("inside the window this phone set, answers the next challenge without a choice and says so", async () => {
    const { key, h, challenge, request } = await setup({
      windowUntil: new Date(NOW_MS + 3_600_000).toISOString(),
    });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    // No button pressed: the prompt opens on its own (ADR 0045's rule is not relaxed).
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    const answer = answerCall(h, request.id).body.answer as UnlockAnswer;
    expect("autoUnlockUntil" in answer).toBe(false);
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expect(await screen.findByTestId("m-unlock-notice")).toHaveTextContent(
      `Unlocked cloud runner "${RUNNER}" automatically`,
    );
    expectNoKeyAnywhere(key, h);
  });

  it("answers inside the window on any screen, not only the inbox", async () => {
    const { key, h, challenge, request } = await setup({
      windowUntil: new Date(NOW_MS + 3_600_000).toISOString(),
    });
    const user = userEvent.setup();
    renderMobile("/", h);
    await confirmBiometric(user);
    await waitFor(() => expect(postedCalls(h, `/requests/${request.id}/answer`)).toHaveLength(1));
    expect(screen.queryByTestId("m-unlock-card")).toBeNull();
    const call = answerCall(h, request.id);
    expect(call).toMatchObject({ signed: true, biometric: true });
    expect(challenge.unwrap(call.body.answer as UnlockAnswer).equals(key)).toBe(true);
    expect(await screen.findByTestId("m-unlock-notice")).toHaveTextContent(
      `Unlocked cloud runner "${RUNNER}" automatically`,
    );
    expectNoKeyAnywhere(key, h);
  });

  it("is read-only in a browser without a keyring, and on a phone without the runner's key", async () => {
    const browser = await setup({ keyring: false });
    const first = renderMobile("/inbox", browser.h);
    expect(await screen.findByTestId("m-unlock-readonly")).toHaveTextContent("no OS keyring");
    expect(
      within(screen.getByTestId("m-unlock-card")).queryByRole("button"),
    ).not.toBeInTheDocument();
    first.unmount();
    browser.h.controller.close();

    const phone = await setup({ withKey: false });
    renderMobile("/inbox", phone.h);
    expect(await screen.findByTestId("m-unlock-readonly")).toHaveTextContent(
      `This phone holds no vault key for runner "${RUNNER}"`,
    );
  });
});
