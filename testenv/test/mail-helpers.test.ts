import { SimulatedClock } from "@forerunner/platform";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { generateDkimKeyPair, signDkim, verifyDkim } from "../src/mail/dkim.ts";
import {
  FORWARDED_MARKER,
  forwardedCopy,
  quotedReply,
  rawBody,
  spoofedFrom,
} from "../src/mail/helpers.ts";
import { buildRawMessage, headerValue, splitMessage } from "../src/mail/message.ts";

const clock = new SimulatedClock("2026-03-01T10:00:00.000Z");

async function original(): Promise<string> {
  const keys = generateDkimKeyPair(1024);
  const raw = await buildRawMessage({
    from: "Alice <alice@example.test>",
    to: "agent@example.test",
    subject: "Ship it [FR-7k2q]",
    text: "Deploy 1.0 tonight.\n\nThanks,\nAlice",
    date: clock.now(),
    messageId: "<orig-1@example.test>",
  });
  return signDkim(
    { privateKeyPem: keys.privateKeyPem, domain: "example.test", selector: "s" },
    raw,
  );
}

describe("forwardedCopy", () => {
  it("builds a Gmail-style forward with a new From, Fwd: subject, quoted original and no DKIM", async () => {
    const raw = await forwardedCopy(await original(), "Mallory <mallory@other.test>", {
      text: "Look at this",
      clock,
    });
    const { headers } = splitMessage(raw);
    expect(headerValue(headers, "From")).toBe("Mallory <mallory@other.test>");
    expect(headerValue(headers, "To")).toBe("agent@example.test");
    expect(headerValue(headers, "Subject")).toBe("Fwd: Ship it [FR-7k2q]");
    expect(headerValue(headers, "DKIM-Signature")).toBeUndefined();
    expect(headerValue(headers, "Message-ID")).not.toBe("<orig-1@example.test>");
    const body = rawBody(raw);
    expect(body.startsWith("Look at this\n\n")).toBe(true);
    expect(body).toContain(FORWARDED_MARKER);
    expect(body).toContain("From: Alice <alice@example.test>");
    expect(body).toContain("Subject: Ship it [FR-7k2q]");
    expect(body).toContain("> Deploy 1.0 tonight.\n>\n> Thanks,\n> Alice");
    const verified = await verifyDkim(raw, async () => null);
    expect(verified.reason).toBe("no DKIM-Signature header");
  });

  it("accepts an explicit recipient and does not double the Fwd: prefix", async () => {
    const first = await forwardedCopy(await original(), "bob@example.test", {
      to: ["carol@example.test"],
      clock,
    });
    const second = await forwardedCopy(first, "dave@example.test", { clock });
    const { headers } = splitMessage(second);
    expect(headerValue(headers, "To")).toBe("carol@example.test");
    expect(headerValue(headers, "Subject")).toBe("Fwd: Ship it [FR-7k2q]");
  });
});

describe("spoofedFrom", () => {
  it("claims the address without any DKIM signature", async () => {
    const raw = await spoofedFrom("Alice <alice@example.test>", {
      to: "agent@example.test",
      subject: "Urgent [FR-7k2q]",
      text: "Wire the money.",
      clock,
    });
    const { headers } = splitMessage(raw);
    expect(headerValue(headers, "From")).toBe("Alice <alice@example.test>");
    expect(headerValue(headers, "DKIM-Signature")).toBeUndefined();
    expect(headerValue(headers, "Date")).toBe("Sun, 01 Mar 2026 10:00:00 +0000");
    expect(rawBody(raw).trim()).toBe("Wire the money.");
  });

  it("can carry a bogus signature that fails on the signature, not on the body hash", async () => {
    const keys = generateDkimKeyPair(1024);
    const raw = await spoofedFrom("alice@example.test", {
      to: "agent@example.test",
      text: "Wire the money.",
      bogusSignature: true,
      selector: "s",
      clock,
    });
    expect(raw.startsWith("DKIM-Signature: v=1;")).toBe(true);
    const result = await verifyDkim(raw, async () => keys.publicKeyPem);
    expect(result.pass).toBe(false);
    expect(result.domain).toBe("example.test");
    expect(result.reason).toBe("signature does not verify");
  });
});

describe("quotedReply", () => {
  it("threads the reply and quotes the original under an attribution line", async () => {
    const raw = await quotedReply(await original(), "yes, go ahead", { clock });
    const parsed = await simpleParser(raw);
    expect(parsed.from?.value[0]?.address).toBe("agent@example.test");
    expect(parsed.to && !Array.isArray(parsed.to) ? parsed.to.value[0]?.address : "").toBe(
      "alice@example.test",
    );
    expect(parsed.subject).toBe("Re: Ship it [FR-7k2q]");
    expect(parsed.inReplyTo).toBe("<orig-1@example.test>");
    expect(parsed.references).toBe("<orig-1@example.test>");
    const body = parsed.text ?? "";
    expect(body.startsWith("yes, go ahead\n\n")).toBe(true);
    expect(body).toMatch(
      /^On Sun, 01 Mar 2026 10:00:00 \+0000, Alice <alice@example.test> wrote:$/m,
    );
    expect(body).toContain("> Deploy 1.0 tonight.");
  });

  it("accumulates References across a thread and lets the caller pick the sender", async () => {
    const first = await quotedReply(await original(), "first", { clock });
    const second = await quotedReply(first, "second", { from: "alice@example.test", clock });
    const parsed = await simpleParser(second);
    expect(parsed.subject).toBe("Re: Ship it [FR-7k2q]");
    expect(parsed.from?.value[0]?.address).toBe("alice@example.test");
    expect(Array.isArray(parsed.references) ? parsed.references.length : 1).toBe(2);
    expect(parsed.references).toContain("<orig-1@example.test>");
  });
});
