import { describe, expect, it } from "vitest";
import {
  canonicalRequest as serviceCanonical,
  verifyRequestSignature as serviceVerify,
} from "../../../services/state-api/src/auth/crypto.ts";
import {
  type BiometricAssertion,
  BiometricTicketError,
  canonicalRequest,
  fromBase64,
  fromHex,
  needsBiometricTicket,
  noBiometric,
  pairingProofMessage,
  sha256Hex,
  simulatedBiometric,
  TICKET_TTL_MS,
  TicketBook,
  toBase64,
  toHex,
  utf8,
  verifySignature,
  WebCryptoSigner,
} from "../src/api/state-signing.ts";

/** RFC 8032, section 7.1, test 1 (empty message). Public test vector, not a credential. */
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // not-a-secret
const RFC_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_SIGNATURE =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

describe("canonical request string", () => {
  it("is byte for byte what the service signs", async () => {
    const parts = {
      method: "post",
      path: "/requests/req_1/answer?x=1",
      body: JSON.stringify({ version: 1, answer: "Approve" }),
      timestamp: "1760000000000",
      biometric: true,
    };
    expect(await canonicalRequest(parts)).toBe(serviceCanonical(parts));
    expect(await canonicalRequest({ ...parts, biometric: false })).toBe(
      serviceCanonical({ ...parts, biometric: false }),
    );
    expect(await canonicalRequest(parts)).toMatch(
      /^POST\n\/requests\/req_1\/answer\?x=1\n[0-9a-f]{64}\n1760000000000\nbiometric=1$/,
    );
  });

  it("hashes the body with SHA-256 like the service", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(utf8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("round-trips base64 and hex without Buffer", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(() => fromHex("abc")).toThrow(/odd/);
  });
});

describe("WebCryptoSigner", () => {
  it("reproduces the RFC 8032 vector from a seed and verifies with the service's code", async () => {
    const signer = await WebCryptoSigner.fromSeed(fromHex(RFC_SEED));
    expect(toHex(fromBase64(await signer.publicKey()))).toBe(RFC_PUBLIC);
    const signature = await signer.sign(new Uint8Array());
    expect(toHex(fromBase64(signature))).toBe(RFC_SIGNATURE);
    expect(await verifySignature(await signer.publicKey(), signature, new Uint8Array())).toBe(true);
    // The service verifies the same bytes for a signed request string.
    const parts = { method: "POST", path: "/x", body: "{}", timestamp: "1", biometric: false };
    const sig = await signer.sign(utf8(await canonicalRequest(parts)));
    expect(serviceVerify(await signer.publicKey(), sig, parts)).toBe(true);
    expect(serviceVerify(await signer.publicKey(), sig, { ...parts, biometric: true })).toBe(false);
  });

  it("generates a fresh key, signs, forgets, and exports a seed only when extractable", async () => {
    const signer = await WebCryptoSigner.generate({ extractable: true });
    const pub = await signer.publicKey();
    expect(fromBase64(pub)).toHaveLength(32);
    const seed = await signer.exportSeed();
    expect(seed).toHaveLength(32);
    const again = await WebCryptoSigner.fromSeed(seed);
    expect(await again.publicKey()).toBe(pub);
    const message = pairingProofMessage("ABCD2345");
    expect(await verifySignature(pub, await signer.sign(message), message)).toBe(true);
    await signer.forget();
    await expect(signer.sign(message)).rejects.toThrow(/forgotten/);
    const locked = await WebCryptoSigner.generate();
    await expect(locked.exportSeed()).rejects.toThrow();
  });

  it("rejects a bad signature and a wrong key", async () => {
    const a = await WebCryptoSigner.generate();
    const b = await WebCryptoSigner.generate();
    const msg = utf8("hello");
    const sig = await a.sign(msg);
    expect(await verifySignature(await b.publicKey(), sig, msg)).toBe(false);
    expect(await verifySignature(await a.publicKey(), "not base64!!", msg)).toBe(false);
  });
});

describe("biometric ports", () => {
  it("the null port never asserts; the simulated one is marked simulated and carries a ticket", async () => {
    expect(await noBiometric.available()).toBe(false);
    expect(await noBiometric.assert("x")).toBeNull();
    const tickets = new TicketBook(() => 1_700_000_000_000);
    const yes = simulatedBiometric(async () => true, { tickets, now: () => 1_700_000_000_000 });
    const assertion = await yes.assert("Confirm");
    expect(assertion).toMatchObject({
      asserted: true,
      at: "2023-11-14T22:13:20.000Z",
      method: "simulated",
    });
    expect(assertion?.ticket).toMatch(/^[0-9a-f]{32}$/);
    expect(tickets.outstanding).toBe(true);
    const no = simulatedBiometric(async () => false, { tickets });
    expect(await no.assert("Confirm")).toBeNull();
  });

  it("only a canonical string whose last line is biometric=1 needs a ticket", () => {
    expect(needsBiometricTicket(utf8("POST\n/requests/r/answer\nabc\n1\nbiometric=1"))).toBe(true);
    expect(needsBiometricTicket(utf8("POST\n/requests/r/answer\nabc\n1\nbiometric=0"))).toBe(false);
    expect(needsBiometricTicket(pairingProofMessage("ABCD2345"))).toBe(false);
    expect(needsBiometricTicket(utf8("POST\n/x\nbiometric=1\n1\nbiometric=0"))).toBe(false);
    expect(needsBiometricTicket(new Uint8Array())).toBe(false);
  });

  it("a ticket book redeems each ticket once, inside its TTL, and ignores wrong tickets", () => {
    let clock = 1_000;
    const book = new TicketBook(() => clock);
    expect(book.redeem(undefined)).toBe(false);
    expect(book.redeem("forged")).toBe(false);
    const ticket = book.issue();
    expect(book.redeem("forged")).toBe(false);
    expect(book.outstanding).toBe(true);
    clock += 5_000;
    expect(book.redeem(ticket)).toBe(true);
    expect(book.redeem(ticket)).toBe(false);
    const stale = book.issue();
    clock += TICKET_TTL_MS + 1;
    expect(book.redeem(stale)).toBe(false);
    const first = book.issue();
    const second = book.issue();
    expect(book.redeem(first)).toBe(false);
    expect(book.redeem(second)).toBe(true);
  });

  it("the WebCrypto signer signs a biometric=1 string only against the prompt's ticket, once", async () => {
    const signer = await WebCryptoSigner.generate();
    const high = utf8(
      await canonicalRequest({
        method: "POST",
        path: "/requests/req_cap/answer",
        body: "{}",
        timestamp: "1",
        biometric: true,
      }),
    );
    // A screen that fabricates the assertion object (what the critic's scratch test did).
    const forged = {
      asserted: true,
      at: "x",
      method: "forged-by-screen",
      ticket: "not-issued",
    } as const satisfies BiometricAssertion;
    await expect(signer.sign(high)).rejects.toBeInstanceOf(BiometricTicketError);
    await expect(signer.sign(high, { biometric: forged })).rejects.toBeInstanceOf(
      BiometricTicketError,
    );
    const port = simulatedBiometric(async () => true, { tickets: signer.tickets });
    const assertion = await port.assert("confirm");
    const sig = await signer.sign(high, { biometric: assertion });
    expect(await verifySignature(await signer.publicKey(), sig, high)).toBe(true);
    // The ticket is spent: the same assertion signs nothing else.
    await expect(signer.sign(high, { biometric: assertion })).rejects.toThrow(/one-time ticket/);
    // biometric=0 strings and the pairing proof never need one.
    const low = utf8(
      await canonicalRequest({
        method: "POST",
        path: "/x",
        body: "",
        timestamp: "1",
        biometric: false,
      }),
    );
    await signer.sign(low);
    await signer.sign(low, { biometric: forged });
    await signer.sign(pairingProofMessage("ABCD2345"));
  });
});
