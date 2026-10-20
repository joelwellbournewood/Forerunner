import { buildRawMessage, spoofedFrom } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthenticateFn,
  AuthResultsHeaderVerifier,
  domainsAligned,
  FAILED_VERDICT,
  MailauthVerifier,
  parseInboundEmail,
  StaticAuthVerifier,
} from "../src/email/index.ts";
import {
  AGENT,
  emailWorld,
  inboundOf,
  MARKER,
  OWNER,
  ownerSends,
  type World,
} from "./helpers/email-world.ts";

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

describe("AuthResultsHeaderVerifier over the testenv mail host", () => {
  it("passes mail the owner really sent: DKIM pass, aligned, SPF pass", async () => {
    world = await emailWorld();
    const stored = await ownerSends(world, { subject: "hello", text: "hi" });
    const verdict = await world.verifier.verify(await inboundOf(stored));
    expect(verdict).toMatchObject({
      dkim: "pass",
      aligned: true,
      dkimDomain: "example.test",
      spf: "pass",
      fromDomain: "example.test",
      source: "header",
    });
    expect(verdict.reason).toBeUndefined();
  });

  it("fails a spoofed From without a signature, and one with a bogus signature", async () => {
    world = await emailWorld();
    const unsigned = await spoofedFrom(OWNER, {
      to: AGENT,
      subject: `${MARKER} spoof`,
      text: "do it",
      clock: world.clock,
    });
    const [a] = await world.server.inject(unsigned, {
      skipSigning: true,
      fromIp: world.server.publicIp,
    });
    const v1 = await world.verifier.verify(await inboundOf(a!));
    expect(v1).toMatchObject({ dkim: "none", aligned: false, spf: "pass" });
    expect(v1.reason).toBe("dkim=none");

    const bogus = await spoofedFrom(OWNER, {
      to: AGENT,
      subject: `${MARKER} spoof`,
      text: "do it",
      bogusSignature: true,
      clock: world.clock,
    });
    const [b] = await world.server.inject(bogus, {
      skipSigning: true,
      fromIp: world.server.publicIp,
    });
    const v2 = await world.verifier.verify(await inboundOf(b!));
    expect(v2.dkim).toBe("fail");
    expect(v2.aligned).toBe(false);
    expect(v2.reason).toBe("dkim=fail");
  });

  it("fails a valid signature for a domain that is not aligned with From", async () => {
    world = await emailWorld();
    const [stored] = await world.server.inject(
      { from: OWNER, to: AGENT, subject: "x", text: "y" },
      { dkimAs: "evil.test", fromIp: world.server.publicIp },
    );
    const verdict = await world.verifier.verify(await inboundOf(stored!));
    expect(verdict.dkim).toBe("pass");
    expect(verdict.aligned).toBe(false);
    expect(verdict.reason).toContain("signed for evil.test");
  });

  it("fails SPF when the connecting address is not designated by the domain", async () => {
    world = await emailWorld();
    const [stored] = await world.server.inject({ from: OWNER, to: AGENT, subject: "x", text: "y" });
    const verdict = await world.verifier.verify(await inboundOf(stored!));
    expect(verdict.dkim).toBe("pass");
    expect(verdict.aligned).toBe(true);
    expect(verdict.spf).toBe("fail");
    expect(verdict.reason).toBe("spf=fail");
  });

  it("ignores an Authentication-Results header a sender forged, and one that is missing", async () => {
    const forged = await buildRawMessage({
      from: OWNER,
      to: AGENT,
      subject: "x",
      text: "y",
      date: Date.parse("2026-03-02T10:00:00.000Z"),
      headers: {
        "Authentication-Results":
          "mx.attacker.test; dkim=pass header.d=example.test; spf=pass smtp.mailfrom=example.test; dmarc=pass header.from=example.test (dkim.aligned=yes)",
      },
    });
    const email = await parseInboundEmail(forged, { id: "1", receivedAt: "2026-03-02T10:00:00Z" });
    const strict = new AuthResultsHeaderVerifier({ trustedAuthservIds: ["mx.example.test"] });
    const verdict = await strict.verify(email);
    expect(verdict).toMatchObject({ ...FAILED_VERDICT, fromDomain: "example.test" });
    expect(verdict.reason).toContain('untrusted authserv-id "mx.attacker.test"');
    // Trusting the topmost header is opt-in (a host that strips foreign headers), but even
    // then a claimed dkim=pass needs a DKIM-Signature header on the message.
    const lenient = new AuthResultsHeaderVerifier({ trustedAuthservIds: [] });
    const unsigned = await lenient.verify(email);
    expect(unsigned.dkim).toBe("none");
    expect(unsigned.reason).toContain("DKIM-Signature");
    // Same forged header, but naming the trusted authserv-id: still refused without a signature.
    const forgedTrusted = await buildRawMessage({
      from: OWNER,
      to: AGENT,
      subject: "x",
      text: "y",
      date: Date.parse("2026-03-02T10:00:00.000Z"),
      headers: {
        "Authentication-Results":
          "mx.example.test; dkim=pass header.d=example.test; spf=pass smtp.mailfrom=example.test; dmarc=pass header.from=example.test (dkim.aligned=yes)",
      },
    });
    const forgedVerdict = await strict.verify(
      await parseInboundEmail(forgedTrusted, { id: "3", receivedAt: "2026-03-02T10:00:00Z" }),
    );
    expect(forgedVerdict.dkim).toBe("none");
    expect(forgedVerdict.aligned).toBe(false);
    expect(forgedVerdict.reason).toContain("DKIM-Signature");
    // A really signed message delivered by the host passes the lenient verifier.
    world = await emailWorld();
    const real = await ownerSends(world, { subject: "signed", text: "hi" });
    expect((await lenient.verify(await inboundOf(real))).dkim).toBe("pass");

    const bare = await buildRawMessage({
      from: OWNER,
      to: AGENT,
      subject: "x",
      text: "y",
      date: Date.parse("2026-03-02T10:00:00.000Z"),
    });
    const none = await strict.verify(
      await parseInboundEmail(bare, { id: "2", receivedAt: "2026-03-02T10:00:00Z" }),
    );
    expect(none.reason).toBe("no Authentication-Results header");
  });

  it("refuses a From header with more than one address", async () => {
    const raw = await buildRawMessage({
      from: `${OWNER}, bob@example.test`,
      to: AGENT,
      subject: "x",
      text: "y",
      date: Date.parse("2026-03-02T10:00:00.000Z"),
    });
    const email = await parseInboundEmail(raw, { id: "1", receivedAt: "2026-03-02T10:00:00Z" });
    expect(email.fromAll).toHaveLength(2);
    const verdict = await new AuthResultsHeaderVerifier({ trustedAuthservIds: [] }).verify(email);
    expect(verdict.dkim).toBe("none");
    expect(verdict.reason).toContain("exactly one address");
  });

  it("domainsAligned is relaxed DMARC alignment", () => {
    expect(domainsAligned("example.test", "example.test")).toBe(true);
    expect(domainsAligned("mail.example.test", "example.test")).toBe(true);
    expect(domainsAligned("example.test", "mail.example.test")).toBe(true);
    expect(domainsAligned("notexample.test", "example.test")).toBe(false);
    expect(domainsAligned(undefined, "example.test")).toBe(false);
  });
});

describe("MailauthVerifier (production, authenticate() injected)", () => {
  const email = async () =>
    parseInboundEmail(
      await buildRawMessage({
        from: OWNER,
        to: AGENT,
        subject: "x",
        text: "y",
        date: Date.parse("2026-03-02T10:00:00.000Z"),
      }),
      { id: "1", receivedAt: "2026-03-02T10:00:00Z" },
    );

  it("passes when mailauth reports an aligned DKIM pass and SPF pass", async () => {
    const calls: Array<{ trustReceived: boolean; mta?: string }> = [];
    const authenticate: AuthenticateFn = async (_raw, opts) => {
      calls.push(opts);
      return {
        dkim: {
          results: [{ signingDomain: "example.test", status: { result: "pass", aligned: false } }],
        },
        spf: { status: { result: "pass" } },
      };
    };
    const verifier = new MailauthVerifier(authenticate, { mta: "mx.example.test" });
    const verdict = await verifier.verify(await email());
    expect(verdict).toMatchObject({
      dkim: "pass",
      aligned: true,
      dkimDomain: "example.test",
      spf: "pass",
      source: "mailauth",
    });
    expect(calls).toEqual([{ trustReceived: true, mta: "mx.example.test" }]);
  });

  it("fails on an unaligned signature, a failed SPF, and a verification error", async () => {
    const unaligned = new MailauthVerifier(async () => ({
      dkim: { results: [{ signingDomain: "evil.test", status: { result: "pass" } }] },
      spf: { status: { result: "pass" } },
    }));
    const v1 = await unaligned.verify(await email());
    expect(v1.dkim).toBe("pass");
    expect(v1.aligned).toBe(false);
    expect(v1.reason).toContain("aligned");

    const spfFail = new MailauthVerifier(async () => ({
      dkim: { results: [{ signingDomain: "example.test", status: { result: "pass" } }] },
      spf: { status: { result: "softfail" } },
    }));
    const v2 = await spfFail.verify(await email());
    expect(v2.spf).toBe("softfail");
    expect(v2.reason).toBe("spf=softfail");

    const noSig = new MailauthVerifier(async () => ({ dkim: { results: [] }, spf: false }));
    const v3 = await noSig.verify(await email());
    expect(v3).toMatchObject({ dkim: "none", aligned: false, spf: "none" });

    const broken = new MailauthVerifier(async () => {
      throw new Error("dns timeout");
    });
    const v4 = await broken.verify(await email());
    expect(v4.dkim).toBe("none");
    expect(v4.reason).toBe("verification error: dns timeout");
  });
});

describe("StaticAuthVerifier (tests of the gate's branches)", () => {
  it("returns the base verdict with per-message overrides", async () => {
    const raw = await buildRawMessage({
      from: OWNER,
      to: AGENT,
      subject: "x",
      text: "y",
      date: Date.parse("2026-03-02T10:00:00.000Z"),
      messageId: "<m1@example.test>",
    });
    const email = await parseInboundEmail(raw, { id: "1", receivedAt: "2026-03-02T10:00:00Z" });
    const verifier = new StaticAuthVerifier({ spf: "softfail" });
    expect(await verifier.verify(email)).toMatchObject({
      dkim: "pass",
      aligned: true,
      spf: "softfail",
      fromDomain: "example.test",
      source: "static",
    });
    verifier.byMessageId.set("m1@example.test", { dkim: "fail", aligned: false });
    expect(await verifier.verify(email)).toMatchObject({ dkim: "fail", aligned: false });
  });
});
