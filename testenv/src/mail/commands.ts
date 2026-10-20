/**
 * Client-side helpers for the email-command rules (spec: Security -> Email commands). The
 * cloud runner's mail watcher uses them to decide whether a message carries the owner's
 * command marker, whether it is a reply in a thread the agent started, and which part of the
 * body the owner actually wrote. Quoted and forwarded text is data, never an instruction.
 */
import type { ParsedMail } from "mailparser";

/** True when the subject carries the private marker in brackets, e.g. "[FR-7k2q]". */
export function extractCommandMarker(subject: string | undefined, marker: string): boolean {
  if (!subject) return false;
  const bare = marker.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (bare.length === 0) return false;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\s*${escaped}\\s*\\]`).test(subject);
}

export interface ThreadRefs {
  inReplyTo?: string | undefined;
  references?: string | string[] | undefined;
}

/** Normalise a Message-ID for comparison: strip angle brackets and surrounding whitespace. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}

/** True when In-Reply-To or References names one of `threadIds` (ids the agent sent). */
export function isReplyToThread(
  message: ThreadRefs | ParsedMail,
  threadIds: Iterable<string>,
): boolean {
  const known = new Set<string>();
  for (const id of threadIds) known.add(normalizeMessageId(id));
  if (known.size === 0) return false;
  const candidates: string[] = [];
  if (message.inReplyTo) candidates.push(...splitIds(message.inReplyTo));
  if (Array.isArray(message.references)) {
    for (const ref of message.references) candidates.push(...splitIds(ref));
  } else if (message.references) {
    candidates.push(...splitIds(message.references));
  }
  return candidates.some((c) => known.has(normalizeMessageId(c)));
}

function splitIds(value: string): string[] {
  return value.split(/\s+/).filter((v) => v.length > 0);
}

// ---------------------------------------------------------------------------------------------
// stripQuotedText

/** A line after which everything is quoted or forwarded material. */
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

/** "On <date>, <person> wrote:" and its translations; may be wrapped over two lines. */
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

/** Outlook-style pasted header block: From, then Sent/Date, To and Subject within a few lines. */
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
 * attributions (and their translations), "-----Original Message-----" and "Forwarded message"
 * blocks, Outlook header blocks, and everything that follows a hard cut. Interleaved answers
 * between ">" lines are kept.
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
