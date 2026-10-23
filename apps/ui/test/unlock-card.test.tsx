import { randomBytes } from "node:crypto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { UnlockAnswer } from "../src/lib/runner-unlock.ts";
import { keyHolderBridge, NO_KEYRING_REASON, noKeyringBridge } from "../src/lib/runner-unlock.ts";
import { storageKey } from "../src/lib/storage.ts";
import { InboxPage } from "../src/pages/InboxPage.tsx";
import { ME } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp, renderWith } from "./helpers.tsx";
import { keyEncodings, runnerChallenge, unlockRequest } from "./runner-challenge.ts";

/**
 * The desktop inbox's cloud runner unlock card (spec S.12, ADR 0068). The fake daemon plays the
 * daemon that holds the OS keyring: it wraps the runner's key to the challenge, and the test
 * unwraps the answer the way the runner does. The key must never reach the DOM or any call the
 * UI makes, beyond the wrapped answer.
 */
const RUNNER = "runner-eu";
const WINDOW_KEY = storageKey(null, `runnerUnlockWindow.${ME.id}`);

function setup(opts: { withKey?: boolean; ttlMs?: number } = {}) {
  const key = randomBytes(32);
  const harness = createHarness(
    opts.withKey === false ? {} : { runnerKeys: { [RUNNER]: key.toString("base64") } },
  );
  const challenge = runnerChallenge(RUNNER, opts.ttlMs);
  const request = unlockRequest(challenge.card, { projectId: "proj_atlas", projectName: "Atlas" });
  harness.daemon.state.requests.push(request);
  return { key, harness, challenge, request };
}

function answerOf(harness: Harness, requestId: string): unknown {
  const calls = postedCalls(harness, `/requests/${requestId}/answer`);
  expect(calls).toHaveLength(1);
  return (calls[0]?.body as { answer: unknown } | undefined)?.answer;
}

function expectNoKeyAnywhere(key: Buffer, harness: Harness) {
  const surfaces = [document.body.innerHTML, JSON.stringify(harness.daemon.state.calls)].join("\n");
  for (const enc of keyEncodings(key)) expect(surfaces).not.toContain(enc);
}

async function card() {
  return within(await screen.findByTestId("unlock-card"));
}

beforeEach(() => {
  localStorage.clear();
});

describe("desktop unlock card", () => {
  it("shows the runner, the project, when it was filed and the challenge's age, with the choices", async () => {
    const { harness } = setup();
    renderApp("/inbox", harness);
    const c = await card();
    expect(c.getByTestId("unlock-runner")).toHaveTextContent(RUNNER);
    expect(c.getByTestId("unlock-project")).toHaveTextContent("Atlas");
    expect(c.getByTestId("unlock-filed").textContent).not.toBe("");
    expect(c.getByTestId("unlock-age")).toHaveTextContent(/2 min old · expires in 10 min/);
    await c.findByTestId("unlock-actions");
    expect(c.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Unlock once",
      "Unlock and allow for 1 h",
      "Unlock and allow for 8 h",
      "Unlock and allow for 24 h",
      "Unlock and clear the window",
      "Deny",
    ]);
    // The generic option buttons and the free-text box do not answer an unlock.
    const li = screen.getByTestId("unlock-card").closest("li") as HTMLElement;
    expect(within(li).queryByTestId("option")).not.toBeInTheDocument();
    expect(within(li).queryByTestId("free-text")).not.toBeInTheDocument();
  });

  it("unlock once sends the key wrapped to the challenge; the key is in neither the DOM nor a call", async () => {
    const user = userEvent.setup();
    const { key, harness, challenge, request } = setup();
    renderApp("/inbox", harness);
    await user.click(await screen.findByTestId("unlock-once"));
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    const answer = answerOf(harness, request.id) as UnlockAnswer;
    expect(answer.challengeId).toBe(challenge.card.challengeId);
    expect("autoUnlockUntil" in answer).toBe(false);
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    // The page names the request; the daemon reads the challenge from its own store.
    expect(postedCalls(harness, "/runner-unlock/wrap").map((c) => c.body)).toEqual([
      { requestId: request.id },
    ]);
    expectNoKeyAnywhere(key, harness);
    await waitFor(() => expect(screen.queryByTestId("unlock-card")).not.toBeInTheDocument());
    expect(localStorage.getItem(WINDOW_KEY)).toBeNull();
  });

  it("sets the window with the answer, then clears it with the next one", async () => {
    const user = userEvent.setup();
    const { key, harness, challenge, request } = setup();
    renderApp("/inbox", harness);
    const before = Date.now();
    await user.click(await screen.findByTestId("unlock-window-8"));
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    const answer = answerOf(harness, request.id) as UnlockAnswer;
    const until = Date.parse(answer.autoUnlockUntil as string);
    expect(until).toBeGreaterThanOrEqual(before + 8 * 3_600_000);
    expect(until).toBeLessThan(Date.now() + 8 * 3_600_000 + 1_000);
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expect(localStorage.getItem(WINDOW_KEY)).toBe(answer.autoUnlockUntil);

    // The runner restarts (its cached key is gone): inside the window the next challenge is
    // answered without a choice, once, leaving the window as it is.
    const next = runnerChallenge(RUNNER);
    const second = unlockRequest(next.card, { id: "req_unlock_second" });
    harness.daemon.state.requests.push(second);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${second.id}/answer`)).toHaveLength(1),
    );
    const auto = answerOf(harness, second.id) as UnlockAnswer;
    expect("autoUnlockUntil" in auto).toBe(false);
    expect(next.unwrap(auto).equals(key)).toBe(true);
    expect(await screen.findByTestId("unlock-notice")).toHaveTextContent("automatically");
    expectNoKeyAnywhere(key, harness);
  });

  it("unlock and clear the window sends null and drops this device's record", async () => {
    const user = userEvent.setup();
    const { key, harness, challenge, request } = setup();
    // A record whose window already ended: no auto-answer, the card asks.
    localStorage.setItem(WINDOW_KEY, new Date(Date.now() - 1_000).toISOString());
    renderApp("/inbox", harness);
    await user.click(await screen.findByTestId("unlock-clear"));
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    const cleared = answerOf(harness, request.id) as UnlockAnswer;
    expect(cleared.autoUnlockUntil).toBeNull();
    expect(challenge.unwrap(cleared).equals(key)).toBe(true);
    expect(localStorage.getItem(WINDOW_KEY)).toBeNull();
    expectNoKeyAnywhere(key, harness);
  });

  it("deny answers deny and never asks the keyring to wrap", async () => {
    const user = userEvent.setup();
    const { harness, request } = setup();
    renderApp("/inbox", harness);
    await user.click(await screen.findByTestId("unlock-deny"));
    await waitFor(() => expect(answerOf(harness, request.id)).toBe("deny"));
    expect(postedCalls(harness, "/runner-unlock/wrap")).toHaveLength(0);
  });

  it("answers the next challenge automatically inside the window this device set, with a notice", async () => {
    const { key, harness, challenge, request } = setup();
    localStorage.setItem(WINDOW_KEY, new Date(Date.now() + 3_600_000).toISOString());
    renderApp("/inbox", harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    const answer = answerOf(harness, request.id) as UnlockAnswer;
    // Once, leaving the window as it is.
    expect("autoUnlockUntil" in answer).toBe(false);
    expect(challenge.unwrap(answer).equals(key)).toBe(true);
    expect(await screen.findByTestId("unlock-notice")).toHaveTextContent(
      `Unlocked cloud runner "${RUNNER}" automatically`,
    );
    expectNoKeyAnywhere(key, harness);
  });

  it("auto-answers on any page, not only the inbox, including a challenge filed while it sits there", async () => {
    const { key, harness, challenge, request } = setup();
    localStorage.setItem(WINDOW_KEY, new Date(Date.now() + 3_600_000).toISOString());
    renderApp("/", harness);
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    expect(screen.queryByTestId("unlock-card")).not.toBeInTheDocument();
    expect(challenge.unwrap(answerOf(harness, request.id) as UnlockAnswer).equals(key)).toBe(true);
    expect(await screen.findByTestId("unlock-notice")).toHaveTextContent(
      `Unlocked cloud runner "${RUNNER}" automatically`,
    );

    // The runner restarts while the app stays on the home page: the streamed blocking count
    // brings the new challenge and it is answered too.
    const next = runnerChallenge(RUNNER);
    const second = unlockRequest(next.card, { id: "req_unlock_on_home" });
    harness.daemon.state.requests.push(second);
    // The provider turns `inbox.changed` on /events into this dispatch (as in inbox.test.tsx).
    harness.store.dispatch({ type: "blockingCount", count: 7 });
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${second.id}/answer`)).toHaveLength(1),
    );
    expect(next.unwrap(answerOf(harness, second.id) as UnlockAnswer).equals(key)).toBe(true);
    expectNoKeyAnywhere(key, harness);
  });

  it("does not auto-answer after the window ended", async () => {
    const { harness, request } = setup();
    localStorage.setItem(WINDOW_KEY, new Date(Date.now() - 60_000).toISOString());
    renderApp("/inbox", harness);
    await (await card()).findByTestId("unlock-actions");
    await new Promise((r) => setTimeout(r, 50));
    expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(0);
    expect(screen.queryByTestId("unlock-notice")).not.toBeInTheDocument();
  });

  it("is read-only with the reason when this computer has no key for the runner", async () => {
    const { harness } = setup({ withKey: false });
    renderApp("/inbox", harness);
    const c = await card();
    expect(await c.findByTestId("unlock-readonly")).toHaveTextContent(
      `has no key for runner "${RUNNER}"`,
    );
    expect(c.queryByRole("button")).not.toBeInTheDocument();
  });

  it("an expired challenge offers no unlock", async () => {
    const { harness } = setup({ ttlMs: -1 });
    renderApp("/inbox", harness);
    const c = await card();
    expect(c.getByTestId("unlock-age")).toHaveTextContent(/expired/);
    await waitFor(() => expect(c.queryByText("Checking the keyring…")).not.toBeInTheDocument());
    expect(c.queryByTestId("unlock-actions")).not.toBeInTheDocument();
  });
});

describe("desktop unlock card over the bridge contract", () => {
  function mounted(bridge: Parameters<typeof InboxPage>[0]) {
    const { harness, challenge, request } = setup({ withKey: false });
    harness.store.dispatch({ type: "me", me: ME });
    renderWith(<InboxPage {...bridge} />, harness);
    return { harness, challenge, request };
  }

  it("a key holder bridge hands the key out for the call only and the UI zeroes it", async () => {
    const user = userEvent.setup();
    const key = randomBytes(32);
    const handedOut: Uint8Array[] = [];
    const bridge = keyHolderBridge({
      kind: "test",
      backend: "fake-keyring",
      key: async () => {
        const copy = new Uint8Array(key);
        handedOut.push(copy);
        return copy;
      },
      missingReason: () => "no key",
    });
    const { harness, challenge, request } = mounted({ runnerKeys: bridge });
    await user.click(await screen.findByTestId("unlock-once"));
    await waitFor(() =>
      expect(postedCalls(harness, `/requests/${request.id}/answer`)).toHaveLength(1),
    );
    expect(challenge.unwrap(answerOf(harness, request.id) as UnlockAnswer).equals(key)).toBe(true);
    // Every copy the bridge handed out (status check and wrap) was zeroed after use.
    expect(handedOut.length).toBeGreaterThanOrEqual(2);
    for (const copy of handedOut) expect(copy.every((b) => b === 0)).toBe(true);
    expectNoKeyAnywhere(key, harness);
  });

  it("a shell without a keyring shows the card read-only with the reason", async () => {
    mounted({ runnerKeys: noKeyringBridge(NO_KEYRING_REASON) });
    const c = await card();
    expect(await c.findByTestId("unlock-readonly")).toHaveTextContent("no OS keyring");
    expect(c.queryByRole("button")).not.toBeInTheDocument();
  });
});
