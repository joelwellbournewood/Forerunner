import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalRequest,
  fromBase64,
  generateDeviceKey,
  importSigningKey,
  isEd25519Supported,
  pairingProofMessage,
  sha256Hex,
  signBytes,
  toBase64,
  toHex,
  utf8,
  verifyBytes,
} from "../src/api/crypto.ts";

describe("crypto", () => {
  it("base64 and hex round trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("sha256Hex matches node:crypto for strings and bytes", async () => {
    const body = '{"version":1,"answer":"Postgres"}';
    expect(await sha256Hex(body)).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await sha256Hex(utf8(""))).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("builds the canonical request string the service verifies", async () => {
    const body = '{"a":1}';
    const canonical = await canonicalRequest({
      method: "post",
      path: "/requests/r1/answer?x=1",
      body,
      timestamp: "1700000000000",
      biometric: false,
    });
    const bodyHash = createHash("sha256").update(body).digest("hex");
    expect(canonical).toBe(
      ["POST", "/requests/r1/answer?x=1", bodyHash, "1700000000000", "biometric=0"].join("\n"),
    );
    expect(canonical.split("\n")).toHaveLength(5);
  });

  it("signs with a generated key and verifies with the exported public key", async () => {
    expect(await isEd25519Supported()).toBe(true);
    const key = await generateDeviceKey();
    expect(fromBase64(key.publicKey)).toHaveLength(32);
    expect(key.privateJwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    const signingKey = await importSigningKey(key.privateJwk);
    const message = pairingProofMessage("ABCD2345");
    expect(new TextDecoder().decode(message)).toBe("pair:ABCD2345");
    const sig = await signBytes(signingKey, message);
    expect(fromBase64(sig)).toHaveLength(64);
    expect(await verifyBytes(key.publicKey, sig, message)).toBe(true);
    expect(await verifyBytes(key.publicKey, sig, utf8("pair:XXXX2345"))).toBe(false);
    const other = await generateDeviceKey();
    expect(await verifyBytes(other.publicKey, sig, message)).toBe(false);
    expect(await verifyBytes("not base64 at all!!", sig, message)).toBe(false);
  });
});
