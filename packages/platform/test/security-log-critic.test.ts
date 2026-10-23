import { describe, expect, it } from "vitest";
import { isSecretKeyName, redact, redactDeep } from "../src/log.ts";

// Security critic (tier 2) findings on the redaction fix in `src/log.ts`: two sibling shapes
// of the fixed findings passed in clear. Both are fixed; the tests stay as the regression set.
const PW = ["hunter", "2", "deep", "blue", "xyz"].join(""); // not-a-secret
const RAW = ["QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo", "wMTIzNDU2Nzg5"].join(""); // not-a-secret

describe("logger: redaction gaps found by the critic", () => {
  // `URL_USERINFO` required a non-empty user (`[^\s:@/]+:`), so a connection string with an
  // empty user (`redis://:password@host`, the common Redis / Memorystore and `amqp://:pw@`
  // form) kept its password. The user part may now be empty.
  it("the password of a connection string with an empty user is masked", () => {
    const cases: [line: string, host: string][] = [
      [`redis://:${PW}@cache.internal:6379/0`, "cache.internal"],
      [`amqp://:${PW}@broker.internal:5672/vhost`, "broker.internal"],
      [`connect failed: rediss://:${PW}@cache.internal:6380`, "cache.internal"],
    ];
    for (const [line, host] of cases) {
      const out = redact(line);
      expect(out).not.toContain(PW);
      expect(out).toContain(host);
      expect(out).toMatch(/:\/\/:\[REDACTED\]@/);
    }
    // A URL without user-info is left alone (no false positive on host:port).
    expect(redact("GET https://cache.internal:6379/path?x=1")).toBe(
      "GET https://cache.internal:6379/path?x=1",
    );
  });

  // `KEY_SUFFIX` was case-sensitive while `SECRET_KEY_NAME` was not, so env-style upper-case
  // names (`PRIVATE_KEY`, `SIGNING_KEY`, `VAULT_KEY`, a dumped `process.env`) were not masked
  // although platform-notes.md says any `*_key` is.
  it("values under upper-case *_KEY names are masked", () => {
    const out = JSON.stringify(
      redactDeep({
        env: { PRIVATE_KEY: RAW, SIGNING_KEY: RAW, VAULT_KEY: RAW, KEY: RAW, "SESSION-KEY": RAW },
        SigningKey: RAW,
        Key: RAW,
      }),
    );
    expect(out).not.toContain(RAW);
  });

  // `CAMEL_KEY_SUFFIX` wanted exactly `Key`, so a camel-case name with the suffix in capitals
  // (`signingKEY`, `vaultKEY`: a hand-written env or config name) was not masked while
  // `signingKey` and `SIGNING_KEY` were. A `Key` or `KEY` after a lower-case letter or digit
  // is the credential suffix; `MONKEY` and `monkey` have no such case switch and stay.
  it("the key-name rule is case-insensitive, and a public key stays an identifier in every case", () => {
    for (const name of [
      "PRIVATE_KEY",
      "Private_Key",
      "private_key",
      "SigningKey",
      "signingKey",
      "signingKEY",
      "vaultKEY",
      "KEY",
      "key",
    ]) {
      expect(isSecretKeyName(name), name).toBe(true);
    }
    const camel = JSON.stringify(redactDeep({ signingKEY: RAW, nested: { vaultKEY: RAW } }));
    expect(camel).not.toContain(RAW);
    for (const name of ["PUBLIC_KEY", "public_key", "publicKey", "PublicKey", "PUBLICKEY"]) {
      expect(isSecretKeyName(name)).toBe(false);
    }
    // Words that merely end in "key" are not credentials.
    for (const name of ["monkey", "turkey", "hockey", "MONKEY", "TURKEY", "HOCKEY"]) {
      expect(isSecretKeyName(name), name).toBe(false);
    }
    const out = redactDeep({ PUBLIC_KEY: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicFixture" });
    expect(out.PUBLIC_KEY).toContain("ssh-ed25519");
  });

  // Review of 2026-10-23: an all-capitals name with no separator (`PRIVATEKEY`, `DEPLOYKEY`,
  // a hand-written env name) passed in clear although platform-notes.md says `*KEY` is masked
  // in any case. Such a name is masked now; `PUBLICKEY` stays an identifier, and the plain
  // words in capitals pinned above (`MONKEY`, `TURKEY`, `HOCKEY`) stay.
  it("an all-capitals *KEY name with no separator is masked, PUBLICKEY is not", () => {
    for (const name of ["PRIVATEKEY", "SIGNINGKEY", "DEPLOYKEY", "VAULT2KEY", "SSH_HOSTKEY"]) {
      expect(isSecretKeyName(name), name).toBe(true);
    }
    expect(isSecretKeyName("PUBLICKEY")).toBe(false);
    const out = JSON.stringify(
      redactDeep({ env: { PRIVATEKEY: RAW, DEPLOYKEY: RAW }, PUBLICKEY: "ssh-ed25519 Fixture" }),
    );
    expect(out).not.toContain(RAW);
    expect(out).toContain("ssh-ed25519 Fixture");
  });
});
