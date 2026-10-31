import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The real shell port (`shellBiometric`) runs over a mocked Tauri bridge in the refusal cases.
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import {
  type BiometricAssertion,
  type BiometricPort,
  BiometricRefusedError,
  WebCryptoSigner,
} from "../src/api/state-signing.ts";
import { shellBiometric } from "../src/mobile/shell-bridge.ts";
import {
  createMobileHarness,
  type MobileHarness,
  postedCalls,
  renderMobile,
} from "./mobile-helpers.tsx";

describe("Inbox screen", () => {
  it("names the task and the project of a card (U-073)", async () => {
    const h = await createMobileHarness();
    renderMobile("/inbox", h);
    const requests = await screen.findAllByTestId("m-request");
    const merge = requests.find((r) => r.getAttribute("data-request-id") === "req_merge");
    expect(within(merge as HTMLElement).getByText("PharmaWatch")).toBeInTheDocument();
    expect(within(merge as HTMLElement).getByTestId("m-request-task")).toHaveTextContent(
      "Task: Write the feed parser",
    );
  });

  it("lists approvals first (blocking, then newest) and posts a signed option answer", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findByRole("heading", { name: "Inbox" });
    const requests = await screen.findAllByTestId("m-request");
    expect(requests.map((r) => r.getAttribute("data-request-id"))).toEqual([
      "req_merge",
      "req_cap",
      "req_name",
    ]);
    expect(requests[0]).toHaveAttribute("data-blocking", "true");
    expect(screen.getByTestId("m-blocking-count")).toHaveTextContent("1 blocking");
    await user.click(within(requests[0] as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(2));
    const call = postedCalls(h, "/requests/req_merge/answer")[0];
    expect(call).toMatchObject({
      signed: true,
      biometric: false,
      body: { version: 1, answer: "Approve" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("m-blocking-count")).toHaveTextContent("0 blocking"),
    );
    expect(screen.queryByTestId("m-inbox-badge")).toBeNull();
  });

  it("asks for biometrics on a high-risk request; confirm sends the flag, cancel sends nothing", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    const requests = await screen.findAllByTestId("m-request");
    const high = requests[1] as HTMLElement;
    expect(high).toHaveAttribute("data-risk", "high");
    expect(within(high).getByTestId("m-request-high")).toHaveTextContent(/fingerprint or face/);
    expect(within(high).getByTestId("m-request-card")).toHaveTextContent("From CHF 150 to CHF 250");
    await user.click(within(high).getByRole("button", { name: "Confirm" }));
    const dialog = await screen.findByTestId("m-biometric-dialog");
    expect(dialog).toHaveTextContent(/Simulated biometric prompt/);
    await user.click(screen.getByTestId("m-biometric-cancel"));
    await waitFor(() =>
      expect(within(high).getByTestId("m-request-error")).toHaveTextContent(
        /biometric confirmation/,
      ),
    );
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    await user.click(within(high).getByRole("button", { name: "Confirm" }));
    await screen.findByTestId("m-biometric-dialog");
    await user.click(screen.getByTestId("m-biometric-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(2));
    const call = postedCalls(h, "/requests/req_cap/answer")[0];
    expect(call).toMatchObject({
      signed: true,
      biometric: true,
      body: { version: 1, answer: "Confirm" },
    });
    expect(h.service.state.requests.find((r) => r.id === "req_cap")?.status).toBe("answered");
  });

  it("sends a free-text answer and marks a message read with a signed receipt", async () => {
    const h = await createMobileHarness();
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    const requests = await screen.findAllByTestId("m-request");
    const decision = requests[2] as HTMLElement;
    await user.type(within(decision).getByTestId("m-free-text"), "Call it Harbour");
    await user.click(within(decision).getByTestId("m-send-free-text"));
    await waitFor(() => expect(postedCalls(h, "/requests/req_name/answer")).toHaveLength(1));
    expect(postedCalls(h, "/requests/req_name/answer")[0]?.body).toEqual({
      version: 1,
      answer: "Call it Harbour",
    });
    const messages = screen.getAllByTestId("m-message");
    expect(messages[0]).toHaveAttribute("data-read", "false");
    await user.click(screen.getByTestId("m-mark-read"));
    await waitFor(() =>
      expect(screen.getAllByTestId("m-message")[0]).toHaveAttribute("data-read", "true"),
    );
    expect(postedCalls(h, "/messages/msg_handoff/receipt")[0]).toMatchObject({
      signed: true,
      body: { state: "read" },
    });
  });

  it("reloads when the live change feed reports a new request, with an in-app notice", async () => {
    const h = await createMobileHarness({ env: { live: true } });
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    await h.service.app.request("http://state.test/__test/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.service.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "req_new",
        why: "Deploy to staging?",
        blocking: true,
        risk: "medium",
      }),
    });
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(4), {
      timeout: 3000,
    });
    expect(screen.getAllByTestId("m-request")[0]).toHaveAttribute("data-request-id", "req_new");
    await waitFor(() =>
      expect(screen.getByTestId("m-push-notice")).toHaveTextContent(/Approval needed/),
    );
  });
});

/**
 * android.yml run 39952987240 (API 30 emulator, no fingerprint enrolled): after Confirm on the
 * high-risk card, `m-request-error` never appeared. Each case below drives the Inbox screen
 * with a biometric port that fails the way the real path can (brief candidates 1 to 5) and
 * asserts what the emulator smoke asserts: the refusal names the biometric step, it carries
 * the `m-request-error` test id inside the card that holds `m-request-high`, and no answer
 * leaves the phone. The harness polls the inbox every 40 ms, so every case also runs with the
 * card re-rendered underneath the refusal.
 */
describe("Inbox screen: a high-risk answer on a phone that cannot confirm is refused", () => {
  function port(assert: BiometricPort["assert"]): BiometricPort {
    return { available: async () => false, assert };
  }

  /** The card the runner's locator picks: the `m-request` that contains `m-request-high`. */
  function highCard(): HTMLElement {
    const cards = screen
      .getAllByTestId("m-request")
      .filter((c) => within(c).queryByTestId("m-request-high") !== null);
    expect(cards).toHaveLength(1);
    return cards[0] as HTMLElement;
  }

  async function confirmAndExpectRefusal(
    biometric: BiometricPort,
    options: { biometricTimeoutMs?: number; text?: RegExp } = {},
  ): Promise<{ h: MobileHarness; card: HTMLElement; error: HTMLElement }> {
    const h = await createMobileHarness({
      env: { biometric, biometricTimeoutMs: options.biometricTimeoutMs ?? 5_000 },
    });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    const card = highCard();
    expect(card).toHaveAttribute("data-request-id", "req_cap");
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    const error = await within(card).findByTestId("m-request-error", {}, { timeout: 4_000 });
    expect(error).toHaveTextContent(/biometric/i);
    if (options.text) expect(error).toHaveTextContent(options.text);
    // The same card (not a remount) holds exactly one refusal; the buttons are usable again.
    expect(card.isConnected).toBe(true);
    expect(highCard()).toBe(card);
    expect(within(card).getAllByTestId("m-request-error")).toHaveLength(1);
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Confirm" })).toBeEnabled(),
    );
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    expect(h.service.state.requests.find((r) => r.id === "req_cap")?.status).toBe("open");
    return { h, card, error };
  }

  it("candidate 1: a port that resolves null (status not available) shows the refusal", async () => {
    const assert = vi.fn(async (_reason: string): Promise<BiometricAssertion | null> => null);
    const { h } = await confirmAndExpectRefusal(port(assert), {
      text: /needs a biometric confirmation/,
    });
    expect(assert).toHaveBeenCalledTimes(1);
    expect(assert.mock.calls[0]?.[0]).toMatch(/^Confirm: Raise the monthly hard ceiling/);
    h.controller.close();
  });

  it("candidate 1, real shell port: assert_biometric resolves `asserted: false, reason: Biometrics not enrolled.`", async () => {
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "assert_biometric") {
        return {
          asserted: false,
          at: "2026-10-20T10:00:00.000Z",
          method: "unavailable",
          reason: "Biometrics not enrolled.",
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const { h } = await confirmAndExpectRefusal(shellBiometric, {
      text: /biometric confirmation \(Biometrics not enrolled\.\)/,
    });
    expect(bridge.invoke).toHaveBeenCalledWith("assert_biometric", {
      reason: expect.stringMatching(/^Confirm: /),
    });
    h.controller.close();
  });

  it("candidate 2: a rejection with the plugin's error object, a string, an Error, or a synchronous throw", async () => {
    const failures: Array<[BiometricPort["assert"], RegExp]> = [
      [
        async () => Promise.reject({ message: "not confirmed: user cancel", code: "userCancel" }),
        /not confirmed: user cancel/,
      ],
      [async () => Promise.reject("not confirmed: authentication failed"), /authentication failed/],
      [
        async () => Promise.reject(new BiometricRefusedError("Biometrics not enrolled.")),
        /Biometrics not enrolled\./,
      ],
      [
        () => {
          throw new TypeError("the plugin is not ready");
        },
        /the plugin is not ready/,
      ],
    ];
    for (const [assert, text] of failures) {
      const { h, card } = await confirmAndExpectRefusal(port(assert), { text });
      expect(card).toBeInTheDocument();
      h.controller.close();
      document.body.innerHTML = "";
    }
  });

  it("candidate 3: a prompt that never settles ends in the refusal after the bounded wait", async () => {
    const assert = vi.fn(() => new Promise<BiometricAssertion | null>(() => {}));
    const h = await createMobileHarness({
      env: { biometric: port(assert), biometricTimeoutMs: 300 },
    });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    const card = highCard();
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    // While the prompt is open: busy, no refusal yet, nothing sent.
    expect(within(card).getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(within(card).queryByTestId("m-request-error")).toBeNull();
    const error = await within(card).findByTestId("m-request-error", {}, { timeout: 3_000 });
    expect(error).toHaveTextContent(
      /needs a biometric confirmation \(the prompt did not answer within 300 ms\)/,
    );
    expect(within(card).getByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    h.controller.close();
  });

  it("candidate 3, simulated prompt: the bound closes the open dialog with the refusal", async () => {
    // The web build's visible stand-in waits for the human; when the bound runs out the card
    // refuses, and the dialog must not stay up asking to confirm what was already refused.
    const h = await createMobileHarness({ env: { biometricTimeoutMs: 300 } });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    const card = highCard();
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByTestId("m-biometric-dialog")).toHaveTextContent(
      /Simulated biometric prompt/,
    );
    const error = await within(card).findByTestId("m-request-error", {}, { timeout: 3_000 });
    expect(error).toHaveTextContent(/the prompt did not answer within 300 ms/);
    expect(screen.queryByTestId("m-biometric-dialog")).toBeNull();
    expect(h.controller.state.biometricPrompt).toBeNull();
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    // The card's buttons work again: a second Confirm opens a fresh dialog that can pass.
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    await user.click(await screen.findByTestId("m-biometric-confirm"));
    await waitFor(() => expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(1));
    expect(postedCalls(h, "/requests/req_cap/answer")[0]).toMatchObject({ biometric: true });
    h.controller.close();
  });

  it("candidate 3, default limit: the wait is bounded at 60 s, inside the smoke's 180 s", async () => {
    const { BIOMETRIC_TIMEOUT_MS } = await import("../src/mobile/store.tsx");
    expect(BIOMETRIC_TIMEOUT_MS).toBe(60_000);
    expect(BIOMETRIC_TIMEOUT_MS).toBeLessThan(180_000);
  });

  it("candidate 3, late success: an assertion that arrives after the limit is dropped and sends nothing", async () => {
    let late: (a: BiometricAssertion) => void = () => {};
    const signer = await WebCryptoSigner.generate();
    const assert = () =>
      new Promise<BiometricAssertion | null>((resolve) => {
        late = resolve;
      });
    const h = await createMobileHarness({
      env: { signer, biometric: port(assert), biometricTimeoutMs: 200 },
    });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    const card = highCard();
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    await within(card).findByTestId("m-request-error", {}, { timeout: 3_000 });
    late({
      asserted: true,
      at: "2026-10-20T10:00:00.000Z",
      method: "android-biometric",
      ticket: signer.tickets?.issue() ?? "",
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(0);
    expect(within(card).getByTestId("m-request-error")).toHaveTextContent(/biometric/);
    h.controller.close();
  });

  it("candidate 4: the refusal carries the m-request-error test id and survives inbox reloads", async () => {
    const { h, card, error } = await confirmAndExpectRefusal(port(async () => null));
    // A reload from the change feed or a Refresh re-renders the list; the card keeps its refusal.
    await h.controller.loadInbox();
    await h.controller.refresh();
    await new Promise((r) => setTimeout(r, 120)); // three poll cycles of the harness
    expect(highCard()).toBe(card);
    expect(within(card).getByTestId("m-request-error")).toBe(error);
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent(/biometric/i);
    h.controller.close();
  });

  it("candidate 5: the shell's IPC rejects with a permission error; the refusal names it, nothing is swallowed", async () => {
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async () => {
      throw "biometric.status not allowed. Permissions associated with this command: biometric:allow-status";
    });
    const { h } = await confirmAndExpectRefusal(shellBiometric, {
      text: /the shell's prompt failed: biometric\.status not allowed/,
    });
    h.controller.close();
  });

  it("happy path: an enrolled phone whose prompt passes sends the answer signed with the assertion", async () => {
    const signer = await WebCryptoSigner.generate();
    const assert = vi.fn(
      async (): Promise<BiometricAssertion> => ({
        asserted: true,
        at: "2026-10-20T10:00:00.000Z",
        method: "android-biometric",
        ticket: signer.tickets?.issue() ?? "",
      }),
    );
    const h = await createMobileHarness({ env: { signer, biometric: port(assert) } });
    const user = userEvent.setup();
    renderMobile("/inbox", h);
    await screen.findAllByTestId("m-request");
    await user.click(within(highCard()).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(postedCalls(h, "/requests/req_cap/answer")).toHaveLength(1));
    expect(postedCalls(h, "/requests/req_cap/answer")[0]).toMatchObject({
      signed: true,
      biometric: true,
      body: { version: 1, answer: "Confirm" },
    });
    await waitFor(() => expect(screen.getAllByTestId("m-request")).toHaveLength(2));
    expect(screen.queryByTestId("m-request-error")).toBeNull();
    h.controller.close();
  });
});
