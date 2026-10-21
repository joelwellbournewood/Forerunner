/**
 * Inbound mail is untrusted data (S.25, T.4). This file turns a raw RFC 5322 message into an
 * InboundEmail: parsed with mailparser, body wrapped as data with wrapUntrusted and scanned for
 * injection, links and attachments returned as references for the sandbox browser (never
 * fetched or opened here), attachments saved only on request under a directory the caller
 * names, with safeSegment file names.
 *
 * The text helpers (quoted-text stripping, marker and thread detection) are the client-side
 * checks of the email-command rules; testenv/src/mail/commands.ts carries the same logic for
 * the stand-in server, and a test asserts both agree.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isInside, join, log, safeSegment } from "@forerunner/platform";
import { type InjectionReport, wrapUntrusted } from "@forerunner/runtime";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";

const logger = log("capabilities:email:inbound");

export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface AttachmentRef {
  index: number;
  /** Original file name, sanitised for display. */
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  /** Kept in memory until saveAttachments() writes it; never opened or executed here. */
  content?: Buffer;
  /** Set once saved; absolute path under the directory the caller named. */
  savedPath?: string;
  /** True when the attachment exceeded the size limit and its content was dropped. */
  truncated: boolean;
}

export type AuthMethodResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "other";

/** What the receiving provider wrote into Authentication-Results (RFC 8601). */
export interface ParsedAuthResults {
  authservId: string;
  dkim?: AuthMethodResult;
  dkimDomain?: string;
  spf?: AuthMethodResult;
  spfDomain?: string;
  dmarc?: AuthMethodResult;
  fromDomain?: string;
  /** Written by the testenv server and some hosts; absent from most providers. */
  aligned?: boolean;
}

export interface InboundEmail {
  /** Mailbox-side identifier (IMAP UID, stand-in id). */
  id: string;
  messageId: string | null;
  from: string | null;
  fromName: string;
  /** Every address in the From header; more than one is itself suspicious. */
  fromAll: string[];
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  receivedAt: string;
  inReplyTo: string | null;
  references: string[];
  /** Plain-text body (HTML converted when there is no text part). Data, not instructions. */
  text: string;
  /** The body wrapped as untrusted data for a model prompt. */
  untrusted: string;
  injection: InjectionReport;
  /** URLs found in the body, as references only. */
  links: string[];
  attachments: AttachmentRef[];
  /** The topmost Authentication-Results header, parsed; null when there is none. */
  authResults: ParsedAuthResults | null;
  /** Every Authentication-Results header in order, for verifiers that need the raw text. */
  authResultHeaders: string[];
  /** True when the message carries a DKIM-Signature header (verified or not). */
  hasDkimSignature: boolean;
  raw: string;
}

export interface ParseInboundOptions {
  maxAttachmentBytes?: number;
}

export interface InboundMeta {
  id: string;
  receivedAt: string;
}

function addressesOf(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const obj of list) {
    for (const entry of obj.value) {
      if (entry.address) out.push(entry.address.trim().toLowerCase());
      for (const member of entry.group ?? []) {
        if (member.address) out.push(member.address.trim().toLowerCase());
      }
    }
  }
  return out;
}

function referencesOf(value: ParsedMail["references"]): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((v) => v.split(/\s+/)).filter((v) => v.length > 0);
}

/** Crude HTML to text for messages without a plain part: tags out, a few entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)) {
    out.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...out];
}

/** Parse a raw message into untrusted, scanned data. Nothing in it is ever executed. */
export async function parseInboundEmail(
  raw: string,
  meta: InboundMeta,
  opts: ParseInboundOptions = {},
): Promise<InboundEmail> {
  const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true });
  const maxBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const fromAll = addressesOf(parsed.from);
  const from = fromAll[0] ?? null;
  const fromName = parsed.from?.value[0]?.name ?? "";
  let text = parsed.text ?? "";
  if (text.trim().length === 0 && typeof parsed.html === "string") text = htmlToText(parsed.html);
  text = text.replace(/\r\n|\r/g, "\n");
  const subject = parsed.subject ?? "";
  const scanInput = subject.length > 0 ? `Subject: ${subject}\n\n${text}` : text;
  const wrapped = wrapUntrusted(scanInput, "email", from ?? "unknown sender");
  const attachments: AttachmentRef[] = parsed.attachments.map((a, index) => {
    const content = a.content;
    const truncated = content.length > maxBytes;
    return {
      index,
      filename: safeSegment(a.filename ?? `attachment-${index + 1}`, `attachment-${index + 1}`),
      contentType: a.contentType,
      size: a.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      ...(truncated ? {} : { content }),
      truncated,
    };
  });
  const authResultHeaders = parsed.headerLines
    .filter((h) => h.key === "authentication-results")
    .map((h) => h.line.replace(/^authentication-results:\s*/i, ""));
  const hasDkimSignature = parsed.headerLines.some((h) => h.key === "dkim-signature");
  return {
    id: meta.id,
    messageId: parsed.messageId ? normalizeMessageId(parsed.messageId) : null,
    from,
    fromName,
    fromAll,
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject,
    date: parsed.date ? parsed.date.toISOString() : null,
    receivedAt: meta.receivedAt,
    inReplyTo: parsed.inReplyTo ? normalizeMessageId(parsed.inReplyTo) : null,
    references: referencesOf(parsed.references).map(normalizeMessageId),
    text,
    untrusted: wrapped.content,
    injection: wrapped.report,
    links: extractLinks(text),
    attachments,
    authResults: authResultHeaders[0] ? parseAuthResultsHeader(authResultHeaders[0]) : null,
    authResultHeaders,
    hasDkimSignature,
    raw,
  };
}

/**
 * Write the attachments of a message under `dir` (created when missing) with safe names and
 * return the saved refs. The files are written, never opened; a path outside `dir` is refused.
 */
export function saveAttachments(email: InboundEmail, dir: string): AttachmentRef[] {
  const saved: AttachmentRef[] = [];
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  for (const attachment of email.attachments) {
    if (!attachment.content) continue;
    let name = attachment.filename;
    let n = 1;
    while (used.has(name.toLowerCase())) {
      const dot = attachment.filename.lastIndexOf(".");
      name =
        dot > 0
          ? `${attachment.filename.slice(0, dot)}-${++n}${attachment.filename.slice(dot)}`
          : `${attachment.filename}-${++n}`;
    }
    used.add(name.toLowerCase());
    const target = join(dir, name);
    if (!isInside(dir, target)) continue;
    writeFileSync(target, attachment.content);
    attachment.savedPath = target;
    attachment.content = undefined;
    saved.push(attachment);
    logger.debug("attachment saved", { file: name, size: attachment.size });
  }
  return saved;
}

// ---------------------------------------------------------------------------------------------
// Authentication-Results (RFC 8601)

function methodResult(v: string | undefined): AuthMethodResult {
  switch (v) {
    case "pass":
    case "fail":
    case "softfail":
    case "neutral":
    case "none":
      return v;
    default:
      return "other";
  }
}

/** Parse the header value a provider wrote; comments are tolerated and read for alignment. */
export function parseAuthResultsHeader(value: string): ParsedAuthResults {
  const unfolded = value.replace(/\r?\n[ \t]/g, " ").trim();
  const segments = unfolded.split(";").map((s) => s.trim());
  let authservId = "";
  const firstToken = (segments[0] ?? "").split(/\s+/)[0] ?? "";
  if (!/^[a-z0-9-]+=/i.test(firstToken)) {
    segments.shift();
    authservId = firstToken;
  }
  const out: ParsedAuthResults = { authservId };
  for (const segment of segments) {
    if (!segment) continue;
    const comments = [...segment.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]?.trim() ?? "");
    const stripped = segment
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = stripped.split(" ");
    const [method, verdict] = (tokens[0] ?? "").split("=");
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf("=");
      if (eq > 0) props.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1).toLowerCase());
    }
    switch (method?.toLowerCase()) {
      case "dkim":
        // Several dkim= clauses may exist; keep the first passing one, else the first.
        if (out.dkim === undefined || (out.dkim !== "pass" && verdict === "pass")) {
          out.dkim = methodResult(verdict);
          const d = props.get("header.d") ?? props.get("header.i")?.replace(/^.*@/, "");
          if (d) out.dkimDomain = d;
          else delete out.dkimDomain;
        }
        break;
      case "spf": {
        out.spf = methodResult(verdict);
        const mailfrom = props.get("smtp.mailfrom");
        if (mailfrom) out.spfDomain = mailfrom.includes("@") ? mailfrom.split("@")[1] : mailfrom;
        break;
      }
      case "dmarc":
        out.dmarc = methodResult(verdict);
        if (props.has("header.from")) out.fromDomain = props.get("header.from");
        for (const c of comments) {
          const m = c.match(/dkim\.aligned=(yes|no)/);
          if (m) out.aligned = m[1] === "yes";
        }
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Command helpers: marker, thread, quoted text

export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}

/** The marker's bracketed form as a regex ("[FR-7k2q]", spaces inside allowed); null when empty. */
function markerPattern(marker: string, flags = ""): RegExp | null {
  const bare = marker.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (bare.length === 0) return null;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\s*${escaped}\\s*\\]`, flags);
}

/** True when the subject carries the private marker in brackets, e.g. "[FR-7k2q]". */
export function hasCommandMarker(subject: string | undefined, marker: string): boolean {
  if (!subject) return false;
  const re = markerPattern(marker);
  return re !== null && re.test(subject);
}

/** What the model sees in place of the owner's private command marker. */
export const COMMAND_MARKER_PLACEHOLDER = "[command marker]";

/**
 * `text` with every occurrence of the private command marker replaced by a placeholder. The
 * marker is the one factor of the command gate the owner can rotate (T.3), so it never enters
 * the model context: `email_read` and `email_list` output and the classifier's input go through
 * here. The audit rows, the sent log and a task's source, which the owner reads, keep it.
 */
export function hideCommandMarker(text: string, marker: string): string {
  const re = markerPattern(marker, "g");
  return re ? text.replace(re, COMMAND_MARKER_PLACEHOLDER) : text;
}

/** True when In-Reply-To or References names a message id the agent sent. */
export function isReplyToThread(
  message: { inReplyTo?: string | null; references?: string[] | string | null },
  threadIds: Iterable<string>,
): boolean {
  const known = new Set<string>();
  for (const id of threadIds) known.add(normalizeMessageId(id));
  if (known.size === 0) return false;
  const candidates: string[] = [];
  if (message.inReplyTo) candidates.push(...message.inReplyTo.split(/\s+/));
  if (Array.isArray(message.references)) {
    for (const ref of message.references) candidates.push(...ref.split(/\s+/));
  } else if (message.references) {
    candidates.push(...message.references.split(/\s+/));
  }
  return candidates.some((c) => c.length > 0 && known.has(normalizeMessageId(c)));
}

const HARD_CUT_LINES: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}$/i,
  /^-{2,}\s*Message d'origine\s*-{2,}$/i,
  /^-{2,}\s*Mensaje original\s*-{2,}$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^-{2,}\s*Weitergeleitete Nachricht\s*-{2,}$/i,
  /^-{2,}\s*Message transféré\s*-{2,}$/i,
  /^-{2,}\s*Mensaje reenviado\s*-{2,}$/i,
  /^Begin forwarded message:$/i,
  /^Anfang der weitergeleiteten Nachricht:$/i,
  /^Début du message réexpédié\s?:$/i,
  /^_{8,}$/,
];

const ATTRIBUTION_LINES: RegExp[] = [
  /^On .+ wrote:$/,
  /^Am .+ schrieb .+:$/,
  /^Le .+ a écrit\s?:$/,
  /^El .+ escribió\s?:$/,
  /^Il .+ ha scritto\s?:$/,
  /^Op .+ schreef .+:$/,
];
const ATTRIBUTION_STARTS = /^(On|Am|Le|El|Il|Op) /;
const ATTRIBUTION_ENDS = /(wrote|schrieb .+|a écrit\s?|escribió\s?|ha scritto\s?|schreef .+):$/;
const HEADER_FROM = /^(From|Von|De|Da)\s*:/i;
const HEADER_SENT = /^(Sent|Date|Gesendet|Datum|Envoyé|Enviado|Inviato)\s*:/i;
const HEADER_TO = /^(To|An|À|Para|A)\s*:/i;
const HEADER_SUBJECT = /^(Subject|Betreff|Objet|Asunto|Oggetto)\s*:/i;

function isQuoted(line: string): boolean {
  return /^\s*>/.test(line);
}
function isAttribution(line: string): boolean {
  const trimmed = line.trim();
  return ATTRIBUTION_LINES.some((re) => re.test(trimmed));
}
function isHardCut(line: string): boolean {
  const trimmed = line.trim();
  return HARD_CUT_LINES.some((re) => re.test(trimmed));
}
function isHeaderBlock(lines: string[], index: number): boolean {
  if (!HEADER_FROM.test(lines[index]?.trim() ?? "")) return false;
  const window = lines.slice(index + 1, index + 6).map((l) => l.trim());
  const sent = window.some((l) => HEADER_SENT.test(l));
  const to = window.some((l) => HEADER_TO.test(l));
  const subject = window.some((l) => HEADER_SUBJECT.test(l));
  return (sent ? 1 : 0) + (to ? 1 : 0) + (subject ? 1 : 0) >= 2;
}
function nextNonEmpty(lines: string[], from: number): string | undefined {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) return line;
  }
  return undefined;
}

/**
 * Remove quoted and forwarded sections from a plain-text body: ">" lines, "On ... wrote:"
 * attributions (and their translations), "Original Message" and "Forwarded message" blocks,
 * Outlook header blocks, and everything after a hard cut. What remains is what the sender
 * wrote; only that can carry a command.
 */
export function stripQuotedText(body: string): string {
  const lines = body.replace(/\r\n|\r/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isHardCut(line) || isHeaderBlock(lines, i)) break;
    if (isQuoted(line)) continue;
    let attribution = isAttribution(line);
    let consumed = 0;
    if (!attribution && ATTRIBUTION_STARTS.test(line.trim())) {
      const joined = `${line.trim()} ${(lines[i + 1] ?? "").trim()}`;
      if (ATTRIBUTION_ENDS.test(joined) && isAttribution(joined)) {
        attribution = true;
        consumed = 1;
      }
    }
    if (attribution) {
      const following = nextNonEmpty(lines, i + 1 + consumed);
      if (following === undefined || !isQuoted(following)) break;
      i += consumed;
      continue;
    }
    kept.push(line.replace(/\s+$/, ""));
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}
