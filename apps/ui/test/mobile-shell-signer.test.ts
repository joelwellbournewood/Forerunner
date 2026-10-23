import { describe, expect, it, vi } from "vitest";

/**
 * The ShellSigner path (Android shell, `device_key_sign` / `assert_biometric`): the one-time
 * ticket the shell's prompt issues is the only thing that lets a `biometric=1` string be
 * signed. The Tauri bridge is mocked here; the shell side of the same rule is
 * `apps/mobile/src-tauri/src/commands.rs` (`a_biometric_signature_needs_the_prompts_ticket_once`).
 */
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createStateClient } from "../src/api/state-client.ts";
import {
  type BiometricAssertion,
  BiometricRefusedError,
  BiometricTicketError,
  canonicalRequest,
  fromBase64,
  utf8,
} from "../src/api/state-signing.ts";
import { ShellSigner, shellBiometric } from "../src/mobile/shell-bridge.ts";

const HIGH = async () =>
  utf8(
    await canonicalRequest({
      method: "POST",
      path: "/requests/req_cap/answer",
      body: JSON.stringify({ version: 1, answer: "Confirm" }),
      timestamp: "1760000000000",
      biometric: true,
    }),
  );

/** What the Rust shell does: sign anything, except a biometric=1 string without the ticket it issued. */
function fakeShell(issued: string | null) {
  let outstanding = issued;
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "device_key_sign") {
      const message = new TextDecoder().decode(fromBase64(String(args?.message)));
      if (message.endsWith("\nbiometric=1")) {
        const ticket = args?.ticket;
        if (typeof ticket !== "string" || !ticket) {
          throw "biometric ticket missing: a biometric=1 signature needs a successful prompt first";
        }
        if (ticket !== outstanding) throw "biometric ticket unknown or already used";
        outstanding = null;
      }
      return { signature: "c2ln" }; // not a real signature; the fake service is not involved here
    }
    if (cmd === "assert_biometric") {
      return issued
        ? {
            asserted: true,
            at: "2026-10-20T10:00:00.000Z",
            method: "android-biometric",
            ticket: issued,
          }
        : {
            asserted: false,
            at: "2026-10-20T10:00:00.000Z",
            method: "unavailable",
            reason: "cancelled",
          };
    }
    if (cmd === "device_key_public") return { publicKey: "cHVi" };
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe("ShellSigner: the biometric flag is bound to the shell's ticket", () => {
  it("refuses a literal assertion object without a ticket before any IPC", async () => {
    fakeShell("ticket-from-a-prompt");
    const signer = new ShellSigner();
    const forged = {
      asserted: true,
      at: "x",
      method: "forged-by-screen",
    } as unknown as BiometricAssertion;
    await expect(signer.sign(await HIGH(), { biometric: forged })).rejects.toBeInstanceOf(
      BiometricTicketError,
    );
    await expect(signer.sign(await HIGH())).rejects.toBeInstanceOf(BiometricTicketError);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("forwards the ticket to device_key_sign and maps the shell's refusal to BiometricTicketError", async () => {
    fakeShell("ticket-from-a-prompt");
    const signer = new ShellSigner();
    const high = await HIGH();
    const guessed = {
      asserted: true,
      at: "x",
      method: "forged-by-screen",
      ticket: "guessed",
    } as const satisfies BiometricAssertion;
    await expect(signer.sign(high, { biometric: guessed })).rejects.toThrow(
      /biometric ticket unknown/,
    );
    expect(bridge.invoke).toHaveBeenLastCalledWith("device_key_sign", {
      message: expect.any(String),
      ticket: "guessed",
    });
    const assertion = await shellBiometric.assert("Confirm");
    expect(assertion).toEqual({
      asserted: true,
      at: "2026-10-20T10:00:00.000Z",
      method: "android-biometric",
      ticket: "ticket-from-a-prompt",
    });
    expect(await signer.sign(high, { biometric: assertion })).toBe("c2ln");
    // Spent: the same assertion signs nothing else.
    await expect(signer.sign(high, { biometric: assertion })).rejects.toBeInstanceOf(
      BiometricTicketError,
    );
    // Strings without the flag never need a ticket.
    const low = utf8(
      await canonicalRequest({
        method: "POST",
        path: "/x",
        body: "",
        timestamp: "1",
        biometric: false,
      }),
    );
    expect(await signer.sign(low)).toBe("c2ln");
  });

  it("a shell outcome without a ticket is not an assertion, and the client never sends a forged flag", async () => {
    fakeShell(null);
    // The shell said why ("cancelled"): a refusal that keeps the reason, never an assertion.
    await expect(shellBiometric.assert("Confirm")).rejects.toMatchObject({
      name: "BiometricRefusedError",
      code: "biometric_refused",
      message: "cancelled",
    });
    bridge.invoke.mockImplementationOnce(async () => ({
      asserted: true,
      at: "t",
      method: "android-biometric",
    }));
    expect(await shellBiometric.assert("Confirm")).toBeNull();

    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createStateClient(
      { baseUrl: "http://state.test", token: "t" },
      new ShellSigner(),
      { fetch, now: () => 1_760_000_000_000 },
    );
    const forged = {
      asserted: true,
      at: "x",
      method: "forged-by-screen",
      ticket: "",
    } as const satisfies BiometricAssertion;
    await expect(
      client.answerRequest("req_cap", { version: 1, answer: "Confirm" }, { biometric: forged }),
    ).rejects.toMatchObject({ code: "biometric_required", status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

/**
 * What `assert_biometric` can do on a phone without an enrolled fingerprint (android.yml run
 * 39952987240): the shell resolves `asserted: false` with the plugin's reason, or the IPC
 * rejects (a permission or plugin error, as a string, an Error or a `{ message }` object).
 * Every shape is a refusal; none is an assertion, and none hangs or throws something else.
 */
describe("shellBiometric: every way the shell's prompt fails is a refusal with its reason", () => {
  const outcome = (o: unknown) => {
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async () => o);
  };
  const rejecting = (e: unknown) => {
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async () => {
      throw e;
    });
  };

  it("candidate 1: the plugin's status says not enrolled, and the shell passes the reason on", async () => {
    outcome({
      asserted: false,
      at: "2026-10-20T10:00:00.000Z",
      method: "unavailable",
      reason: "Biometrics not enrolled.",
    });
    await expect(shellBiometric.assert("Confirm")).rejects.toMatchObject({
      name: "BiometricRefusedError",
      message: "Biometrics not enrolled.",
    });
    expect(bridge.invoke).toHaveBeenCalledWith("assert_biometric", { reason: "Confirm" });
    // No reason, an empty reason, or a malformed answer: still no assertion.
    for (const o of [
      { asserted: false, at: "t", method: "unavailable" },
      { asserted: false, at: "t", method: "unavailable", reason: "   " },
      null,
      undefined,
      "asserted",
      { asserted: "true", ticket: "t" },
    ]) {
      outcome(o);
      expect(await shellBiometric.assert("Confirm"), JSON.stringify(o)).toBeNull();
    }
  });

  it("candidates 2 and 5: an IPC rejection of any shape (permission, plugin, Error) is a refusal naming it", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [
        "biometric.authenticate not allowed. Permissions associated with this command: biometric:allow-authenticate",
        /not allowed.*biometric:allow-authenticate/,
      ],
      [
        { message: "Biometrics not enrolled.", code: "biometryNotEnrolled" },
        /Biometrics not enrolled\./,
      ],
      [new Error("plugin biometric not found"), /plugin biometric not found/],
      [42, /42/],
    ];
    for (const [error, text] of cases) {
      rejecting(error);
      const refused = await shellBiometric.assert("Confirm").then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused, String(text)).toBeInstanceOf(BiometricRefusedError);
      expect((refused as Error).message).toMatch(/^the shell's prompt failed: /);
      expect((refused as Error).message).toMatch(text);
    }
  });
});
