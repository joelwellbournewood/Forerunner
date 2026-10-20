/**
 * Builders for the messages the email-command security tests need: a forwarded copy, a
 * spoofed From, and a reply that quotes the original. Each returns a raw message; hand it to
 * LocalMailServer.inject (with `skipSigning: true` for the spoof) or submit it over SMTP.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import { type ParsedMail, simpleParser } from "mailparser";
import { canonicalizeBodyRelaxed } from "./dkim.ts";
import {
  addressDomain,
  buildRawMessage,
  CRLF,
  prependHeader,
  rfc5322Date,
  splitMessage,
  toCrlf,
} from "./message.ts";
import type { StoredMessage } from "./server.ts";

export const FORWARDED_MARKER = "---------- Forwarded message ---------";

export type MessageLike = StoredMessage | ParsedMail | string;

interface TimeOptions {
  /** Date header; defaults to `clock.now()`. */
  date?: number | Date;
  /** Clock used when `date` is not given; the system clock by default. */
  clock?: Clock;
}

function whenMs(options: TimeOptions): number {
  if (options.date instanceof Date) return options.date.getTime();
  if (typeof options.date === "number") return options.date;
  return (options.clock ?? systemClock).now();
}

/** Resolve any accepted input to its parsed form. */
export async function toParsed(message: MessageLike): Promise<ParsedMail> {
  if (typeof message === "string") return simpleParser(toCrlf(message));
  if ("parsed" in message && "raw" in message) return message.parsed;
  return message;
}

function addressList(value: ParsedMail["to"]): string[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((o) => o.value.map((v) => v.address ?? "").filter(Boolean));
}

function displayAddress(value: ParsedMail["from"]): string {
  if (!value) return "";
  const first = value.value[0];
  if (!first) return value.text;
  return first.name ? `${first.name} <${first.address ?? ""}>` : (first.address ?? "");
}

function quote(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

export interface ForwardOptions extends TimeOptions {
  /** Recipient(s) of the forward; defaults to the original To. */
  to?: string | string[];
  /** Text the forwarder writes above the forwarded block. */
  text?: string;
}

/**
 * A realistic forward by `byAddress`: new From, "Fwd:" subject, the original quoted under a
 * "---------- Forwarded message ---------" block. The original DKIM-Signature is gone, so the
 * copy never verifies as the original author; `inject` signs it for the forwarder's domain.
 */
export async function forwardedCopy(
  message: MessageLike,
  byAddress: string,
  options: ForwardOptions = {},
): Promise<string> {
  const original = await toParsed(message);
  const to = options.to ?? addressList(original.to);
  if ((Array.isArray(to) ? to : [to]).length === 0) {
    throw new ForerunnerError("validation", "forwardedCopy: no recipient");
  }
  const subject = original.subject ?? "";
  const originalDate = original.date ? rfc5322Date(original.date.getTime()) : "(unknown date)";
  const body = [
    options.text ?? "",
    "",
    FORWARDED_MARKER,
    `From: ${displayAddress(original.from)}`,
    `Date: ${originalDate}`,
    `Subject: ${subject}`,
    `To: ${addressList(original.to).join(", ")}`,
    "",
    "",
    quote(original.text ?? ""),
    "",
  ].join("\n");
  return buildRawMessage({
    from: byAddress,
    to,
    subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
    text: body,
    date: whenMs(options),
  });
}

export interface SpoofOptions extends TimeOptions {
  to: string | string[];
  subject?: string;
  text: string;
  /**
   * Add a DKIM-Signature header for the claimed domain whose b= is random (the body hash is
   * correct, so verification fails on the signature itself, not on a missing key). Uses
   * `selector`, "spoofed" by default.
   */
  bogusSignature?: boolean;
  selector?: string;
  headers?: Record<string, string>;
}

/** An inbound message whose From claims `address` but carries no valid DKIM signature. */
export async function spoofedFrom(address: string, options: SpoofOptions): Promise<string> {
  const raw = await buildRawMessage({
    from: address,
    to: options.to,
    subject: options.subject ?? "Hello",
    text: options.text,
    date: whenMs(options),
    headers: options.headers,
  });
  if (!options.bogusSignature) return raw;
  const { body } = splitMessage(raw);
  const bodyHash = createHash("sha256")
    .update(canonicalizeBodyRelaxed(body), "utf8")
    .digest("base64");
  const fakeSignature = randomBytes(256).toString("base64");
  const value =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${addressDomain(address)}; ` +
    `s=${options.selector ?? "spoofed"}; h=from:to:subject:date:message-id; bh=${bodyHash}; b=${fakeSignature}`;
  return prependHeader(raw, "DKIM-Signature", value);
}

export interface QuotedReplyOptions extends TimeOptions {
  /** Sender of the reply; defaults to the first To address of the original. */
  from?: string;
  /** Recipient; defaults to the original From. */
  to?: string;
}

/** A reply whose body carries `text` above the original quoted Gmail-style ("On ... wrote:"). */
export async function quotedReply(
  message: MessageLike,
  text: string,
  options: QuotedReplyOptions = {},
): Promise<string> {
  const original = await toParsed(message);
  const from = options.from ?? addressList(original.to)[0];
  const to = options.to ?? addressList(original.from)[0];
  if (!from || !to) {
    throw new ForerunnerError("validation", "quotedReply: original has no usable From/To");
  }
  const subject = original.subject ?? "";
  const originalDate = original.date ? rfc5322Date(original.date.getTime()) : "an earlier date";
  const body = [
    text,
    "",
    `On ${originalDate}, ${displayAddress(original.from)} wrote:`,
    quote(original.text ?? ""),
    "",
  ].join("\n");
  const references = [
    ...(Array.isArray(original.references)
      ? original.references
      : original.references
        ? [original.references]
        : []),
    ...(original.messageId ? [original.messageId] : []),
  ];
  return buildRawMessage({
    from,
    to,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: body,
    date: whenMs(options),
    inReplyTo: original.messageId,
    references,
  });
}

/** The text of a raw message's first line block, for assertions in tests. */
export function rawBody(raw: string): string {
  return splitMessage(raw).body.split(CRLF).join("\n");
}
