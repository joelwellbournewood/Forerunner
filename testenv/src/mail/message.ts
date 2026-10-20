/**
 * Raw RFC 5322 message helpers shared by the DKIM signer, the mail server and the test
 * helpers. Everything works on CRLF-normalised strings (UTF-8); see testing.md "Mail server"
 * for the encoding caveat.
 */
import { ForerunnerError } from "@forerunner/platform";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";

export const CRLF = "\r\n";

/** Normalise every line ending (CRLF, LF or lone CR) to CRLF. Idempotent. */
export function toCrlf(raw: string): string {
  return raw.replace(/\r\n|\n|\r/g, CRLF);
}

/** One header field as it appears in the message. `value` keeps folding (CRLF + WSP). */
export interface HeaderField {
  name: string;
  value: string;
  /** The full field text, "Name: value", without the terminating CRLF. */
  raw: string;
}

export interface SplitMessage {
  /** Header block without the blank separator line and without a trailing CRLF. */
  headerBlock: string;
  headers: HeaderField[];
  /** Everything after the first empty line; "" when the message has no body. */
  body: string;
}

/** Split a CRLF-normalised message into its header block and body. */
export function splitMessage(raw: string): SplitMessage {
  const normalised = toCrlf(raw);
  const sepIndex = normalised.indexOf(`${CRLF}${CRLF}`);
  let headerBlock: string;
  let body: string;
  if (sepIndex === -1) {
    headerBlock = normalised.endsWith(CRLF) ? normalised.slice(0, -CRLF.length) : normalised;
    body = "";
  } else {
    headerBlock = normalised.slice(0, sepIndex);
    body = normalised.slice(sepIndex + CRLF.length * 2);
  }
  return { headerBlock, headers: parseHeaderBlock(headerBlock), body };
}

/** Parse a header block into fields, keeping folded continuation lines on their field. */
export function parseHeaderBlock(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  if (block.length === 0) return fields;
  const lines = toCrlf(block).split(CRLF);
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const raw = current.join(CRLF);
    const colon = raw.indexOf(":");
    if (colon === -1) {
      fields.push({ name: raw.trim(), value: "", raw });
    } else {
      fields.push({ name: raw.slice(0, colon).trim(), value: raw.slice(colon + 1), raw });
    }
    current = null;
  };
  for (const line of lines) {
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && current) {
      current.push(line);
    } else {
      flush();
      current = [line];
    }
  }
  flush();
  return fields;
}

/** All fields with this name (case-insensitive), in message order (top to bottom). */
export function headersNamed(fields: HeaderField[], name: string): HeaderField[] {
  const lower = name.toLowerCase();
  return fields.filter((f) => f.name.toLowerCase() === lower);
}

/** Unfolded, whitespace-trimmed value of the first field with this name. */
export function headerValue(fields: HeaderField[], name: string): string | undefined {
  const field = headersNamed(fields, name)[0];
  return field === undefined ? undefined : unfold(field.value).trim();
}

/** Remove folding (CRLF followed by whitespace becomes a single space). */
export function unfold(value: string): string {
  return value.replace(/\r\n([ \t])/g, "$1").replace(/\r\n/g, "");
}

/** Prepend a header field. `value` may already contain folding; it must not end with CRLF. */
export function prependHeader(raw: string, name: string, value: string): string {
  return `${name}: ${value}${CRLF}${toCrlf(raw)}`;
}

/** Remove every field with this name from the header block. */
export function removeHeaders(raw: string, name: string): string {
  const { headers, body } = splitMessage(raw);
  const lower = name.toLowerCase();
  const kept = headers.filter((f) => f.name.toLowerCase() !== lower).map((f) => f.raw);
  return `${kept.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** Fold a long header value at `limit` columns, continuing lines with a tab. */
export function foldHeaderValue(value: string, limit = 76): string {
  const out: string[] = [];
  let line = "";
  for (const part of value.split(/\s+/)) {
    if (part.length === 0) continue;
    if (line.length > 0 && line.length + part.length + 1 > limit) {
      out.push(line);
      line = part;
    } else {
      line = line.length === 0 ? part : `${line} ${part}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out.join(`${CRLF}\t`);
}

/** Lower-cased addresses found in a header value (groups flattened). */
export function parseAddresses(headerValueText: string | undefined): string[] {
  if (!headerValueText) return [];
  const out: string[] = [];
  const walk = (entries: ReturnType<typeof addressparser>) => {
    for (const entry of entries) {
      if (entry.group) walk(entry.group);
      else if (entry.address) out.push(entry.address.trim().toLowerCase());
    }
  };
  walk(addressparser(unfold(headerValueText)));
  return out;
}

/** Domain part of an address, lower-cased; "" when there is none. */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/>$/, "");
}

/** Lower-cased bare address from "Name <addr>" or "addr". Throws on garbage. */
export function normalizeAddress(input: string): string {
  const [first] = parseAddresses(input);
  if (!first?.includes("@")) {
    throw new ForerunnerError("validation", `not an email address: ${input}`);
  }
  return first;
}

/** RFC 5322 date, always in UTC ("Tue, 20 Oct 2026 01:01:25 +0000"). */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export interface BuildAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface BuildMessageOptions {
  from: string;
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Date header; milliseconds since the epoch (from a Clock) or a Date. Required so no code path reaches for Date.now(). */
  date: number | Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: BuildAttachment[];
  /** Extra headers, verbatim. */
  headers?: Record<string, string>;
}

/** Build a raw RFC 5322 message with nodemailer's MailComposer, CRLF-normalised. */
export async function buildRawMessage(options: BuildMessageOptions): Promise<string> {
  const date = typeof options.date === "number" ? new Date(options.date) : options.date;
  const references = Array.isArray(options.references)
    ? options.references.join(" ")
    : options.references;
  const composer = new MailComposer({
    from: options.from,
    to: options.to,
    cc: options.cc,
    subject: options.subject,
    text: options.text,
    html: options.html,
    date,
    messageId: options.messageId,
    inReplyTo: options.inReplyTo,
    references,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
    headers: options.headers,
  });
  const built = await composer.compile().build();
  return toCrlf(built.toString("utf8"));
}
