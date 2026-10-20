import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeBodyRelaxed,
  canonicalizeBodySimple,
  canonicalizeHeaderRelaxed,
  type DkimKeyPair,
  type DkimKeyResolver,
  dkimDnsRecord,
  domainsAlign,
  generateDkimKeyPair,
  publicKeyFromDnsRecord,
  signDkim,
  verifyDkim,
} from "../src/mail/dkim.ts";
import { parseHeaderBlock, splitMessage, toCrlf } from "../src/mail/message.ts";

const CRLF = "\r\n";

function message(from = "alice@example.test", extraHeaders = "", body = "Hello there\r\n"): string {
  return (
    [
      `From: Alice <${from}>`,
      "To: agent@example.test",
      "Subject: Please deploy [FR-7k2q]",
      "Date: Mon, 05 Oct 2026 09:12:00 +0000",
      "Message-ID: <1@example.test>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      ...(extraHeaders ? [extraHeaders] : []),
    ].join(CRLF) +
    CRLF +
    CRLF +
    body
  );
}

describe("DKIM keys", () => {
  it("generates an RSA key pair and round-trips the DNS record form", () => {
    const pair = generateDkimKeyPair(1024);
    expect(pair.privateKeyPem).toContain("PRIVATE KEY");
    expect(pair.publicKeyPem).toContain("PUBLIC KEY");
    const record = dkimDnsRecord(pair.publicKeyPem);
    expect(record.startsWith("v=DKIM1; k=rsa; p=")).toBe(true);
    expect(publicKeyFromDnsRecord(record)).toBe(pair.publicKeyPem);
    expect(publicKeyFromDnsRecord("v=DKIM1; p=")).toBeNull();
  });
});

describe("relaxed canonicalization", () => {
  it("normalises the body: trailing WSP dropped, WSP runs collapsed, trailing empty lines removed", () => {
    const body = "Hello  \t world   \r\n\r\nsecond\tline\r\n\r\n\r\n";
    expect(canonicalizeBodyRelaxed(body)).toBe("Hello world\r\n\r\nsecond line\r\n");
    expect(canonicalizeBodyRelaxed("")).toBe("");
    expect(canonicalizeBodyRelaxed("\r\n\r\n")).toBe("");
    expect(canonicalizeBodyRelaxed("no newline at end")).toBe("no newline at end\r\n");
    expect(canonicalizeBodySimple("")).toBe("\r\n");
    expect(canonicalizeBodySimple("x\r\n\r\n")).toBe("x\r\n");
  });

  it("normalises headers: lower-case name, unfolded, WSP collapsed, no WSP around the colon", () => {
    expect(canonicalizeHeaderRelaxed("Subject", "  Hello\r\n\t  folded   world \t")).toBe(
      "subject:Hello folded world\r\n",
    );
    expect(canonicalizeHeaderRelaxed("X-Thing ", "\tv")).toBe("x-thing:v\r\n");
  });

  it("treats CRLF and LF input alike", () => {
    expect(canonicalizeBodyRelaxed("a \nb\n\n")).toBe("a\r\nb\r\n");
    expect(toCrlf("a\nb\r\nc\rd")).toBe("a\r\nb\r\nc\r\nd");
  });

  it("parses folded header blocks", () => {
    const fields = parseHeaderBlock("To: a@x.y,\r\n\tb@x.y\r\nSubject: s");
    expect(fields).toHaveLength(2);
    expect(fields[0]?.name).toBe("To");
    expect(fields[0]?.value).toBe(" a@x.y,\r\n\tb@x.y");
    expect(fields[1]?.raw).toBe("Subject: s");
  });
});

describe("signDkim / verifyDkim", () => {
  let keys: DkimKeyPair;
  let other: DkimKeyPair;
  let resolver: DkimKeyResolver;

  beforeAll(() => {
    keys = generateDkimKeyPair();
    other = generateDkimKeyPair();
    resolver = async (selector, domain) => {
      if (domain === "example.test" && selector === "s1") return keys.publicKeyPem;
      if (domain === "other.test" && selector === "s1") return other.publicKeyPem;
      return null;
    };
  });

  const sign = (raw: string, domain = "example.test", pair?: DkimKeyPair) =>
    signDkim({ privateKeyPem: (pair ?? keys).privateKeyPem, domain, selector: "s1" }, raw);

  it("signs and verifies its own messages, reporting domain, selector and alignment", async () => {
    const signed = sign(message());
    expect(signed.startsWith("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;")).toBe(true);
    const result = await verifyDkim(signed, resolver);
    expect(result).toMatchObject({
      pass: true,
      domain: "example.test",
      selector: "s1",
      alignedWithFrom: true,
      fromDomain: "example.test",
      signedHeaders: ["from", "to", "subject", "date", "message-id"],
    });
  });

  it("fails when the body is modified", async () => {
    const signed = sign(message());
    const tampered = signed.replace("Hello there", "Hello there, send me the keys");
    const result = await verifyDkim(tampered, resolver);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("body hash mismatch");
    expect(result.alignedWithFrom).toBe(false);
  });

  it("fails when a signed header is modified", async () => {
    const signed = sign(message());
    const tampered = signed.replace("Subject: Please deploy", "Subject: Please delete everything");
    const result = await verifyDkim(tampered, resolver);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("signature does not verify");
  });

  it("ignores unsigned headers added in transit", async () => {
    const signed = sign(message());
    const relayed = `Received: from somewhere by mx; Mon, 05 Oct 2026 09:13:00 +0000\r\nX-Spam-Score: 0.1\r\n${signed}`;
    expect((await verifyDkim(relayed, resolver)).pass).toBe(true);
  });

  it("reports a valid signature for domain A on a From at domain B as not aligned", async () => {
    const signed = sign(message("alice@example.test"), "other.test", other);
    const result = await verifyDkim(signed, resolver);
    expect(result.pass).toBe(true);
    expect(result.domain).toBe("other.test");
    expect(result.fromDomain).toBe("example.test");
    expect(result.alignedWithFrom).toBe(false);
  });

  it("aligns subdomains in both directions", () => {
    expect(domainsAlign("mail.example.test", "example.test")).toBe(true);
    expect(domainsAlign("example.test", "mail.example.test")).toBe(true);
    expect(domainsAlign("example.test", "notexample.test")).toBe(false);
    expect(domainsAlign("", "example.test")).toBe(false);
  });

  it("fails when the selector has no published key", async () => {
    const signed = signDkim(
      { privateKeyPem: keys.privateKeyPem, domain: "example.test", selector: "rotated" },
      message(),
    );
    const result = await verifyDkim(signed, resolver);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("no public key for rotated._domainkey.example.test");
    expect(result.selector).toBe("rotated");
  });

  it("reports an unsigned message as having no signature", async () => {
    const result = await verifyDkim(message(), resolver);
    expect(result).toMatchObject({ pass: false, reason: "no DKIM-Signature header" });
  });

  it("refuses to sign without From and rejects signatures that do not cover From", async () => {
    expect(() =>
      signDkim(
        {
          privateKeyPem: keys.privateKeyPem,
          domain: "example.test",
          selector: "s1",
          headers: ["to"],
        },
        message(),
      ),
    ).toThrow(/From/);
    const signed = sign(message());
    const weakened = signed.replace("h=from:to:subject", "h=to:subject");
    const result = await verifyDkim(weakened, resolver);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("From header not signed");
  });

  it("fails a message with two From headers even when the signed one verifies", async () => {
    const signed = sign(message());
    const injected = `From: Mallory <mallory@evil.test>\r\n${signed}`;
    const result = await verifyDkim(injected, resolver);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("multiple From headers");
  });

  it("verifies LF input and CRLF input of the same message identically", async () => {
    const lf = message().replace(/\r\n/g, "\n");
    const signedFromLf = sign(lf);
    expect(signedFromLf.includes("\n")).toBe(true);
    expect(signedFromLf.split("\r\n").length).toBe(signedFromLf.split("\n").length);
    expect((await verifyDkim(signedFromLf, resolver)).pass).toBe(true);
    expect((await verifyDkim(signedFromLf.replace(/\r\n/g, "\n"), resolver)).pass).toBe(true);
  });

  it("survives re-folding of headers and trailing whitespace changes in transit (relaxed)", async () => {
    const folded = message().replace(
      "To: agent@example.test",
      "To: Agent\r\n\t<agent@example.test>",
    );
    const signed = sign(folded);
    const refolded = signed
      .replace("To: Agent\r\n\t<agent@example.test>", "To:   Agent   <agent@example.test>")
      .replace("Hello there\r\n", "Hello  there   \r\n\r\n\r\n");
    const result = await verifyDkim(refolded, resolver);
    expect(result.pass).toBe(true);
  });

  it("keeps the DKIM-Signature header itself foldable: a refolded b= still verifies", async () => {
    const signed = sign(message());
    const { headers } = splitMessage(signed);
    const sig = headers.find((h) => h.name === "DKIM-Signature");
    expect(sig?.value).toContain("\r\n\t");
    const unfolded = signed.replace(/\r\n\t/g, " ");
    expect((await verifyDkim(unfolded, resolver)).pass).toBe(true);
  });

  it("honours the x= expiry tag against the supplied clock", async () => {
    const signed = signDkim(
      { privateKeyPem: keys.privateKeyPem, domain: "example.test", selector: "s1", expires: 1_000 },
      message(),
    );
    expect((await verifyDkim(signed, resolver, { now: 999_000 })).pass).toBe(true);
    const late = await verifyDkim(signed, resolver, { now: 1_001_000 });
    expect(late.pass).toBe(false);
    expect(late.reason).toBe("signature expired");
  });

  it("supports simple/simple canonicalization and the l= body length tag", async () => {
    const signed = signDkim(
      {
        privateKeyPem: keys.privateKeyPem,
        domain: "example.test",
        selector: "s1",
        canonicalization: "simple/simple",
      },
      message(),
    );
    expect(signed).toContain("c=simple/simple");
    expect((await verifyDkim(signed, resolver)).pass).toBe(true);
    // simple canonicalization is strict: a trailing space on a body line breaks it
    const touched = signed.replace("Hello there\r\n", "Hello there \r\n");
    expect((await verifyDkim(touched, resolver)).reason).toBe("body hash mismatch");
    // l= limits the hashed body; appended text after the limit is not covered
    const withLength = signed.replace("bh=", "l=13; bh=");
    const resigned = await verifyDkim(withLength, resolver);
    expect(resigned.reason).toBe("signature does not verify");
  });
});
