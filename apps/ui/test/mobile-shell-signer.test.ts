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
    expect(await shellBiometric.assert("Confirm")).toBeNull();
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
