/**
 * Spoken approvals. The conversation agent reads back an action and waits for "yes"; this
 * decides whether a transcript line is a yes and hands back the exact line so the approval
 * is logged with it (spec O.7).
 *
 * The decision is conservative: approvals gate above-routine actions and spending, so a
 * question ("is that correct?"), a qualified answer ("fine, but how much?") or an instruction
 * that merely contains an affirmative-looking word ("correct the budget first") must never
 * pass. A false "no" costs one repeated question; a false "yes" costs money.
 */
import type { Clock } from "@forerunner/platform";

/** Unambiguous approvals (accents stripped, punctuation removed). */
const STRONG = [
  // English
  "yes",
  "yeah",
  "yep",
  "yup",
  "confirm",
  "confirmed",
  "approve",
  "approved",
  "go ahead",
  "do it",
  "proceed",
  "affirmative",
  "absolutely",
  "agreed",
  "i agree",
  "sounds good",
  "please do",
  "let s go",
  "lets go",
  // German
  "jawohl",
  "bestatigt",
  "bestatige",
  "ich bestatige",
  "einverstanden",
  "mach das",
  "mach es",
  "in ordnung",
  "los geht s",
  // French
  "oui",
  "ouais",
  "d accord",
  "confirme",
  "je confirme",
  "vas y",
  "allez y",
  "allons y",
  "c est bon",
  // Spanish
  "confirmo",
  "confirmado",
  "adelante",
  "dale",
  "de acuerdo",
  "correcto",
  "vamos",
  // Italian
  "va bene",
  "confermo",
  "confermato",
  "procedi",
  "andiamo",
  // Dutch
  "akkoord",
  "bevestig",
  "bevestigd",
  // Portuguese
  "sim",
];

/**
 * Words that are a "yes" on their own but also start instructions or acknowledgements
 * ("correct the budget", "ok, read me the plan", "das ist ja teuer"). They count only when
 * the whole line is short (at most AMBIGUOUS_MAX_WORDS words), e.g. "Correct.", "That's right",
 * "Fine by me".
 */
const AMBIGUOUS = [
  "ok",
  "okay",
  "sure",
  "correct",
  "fine",
  "right",
  // German
  "ja",
  "genau",
  "stimmt",
  "passt",
  // Spanish
  "si",
  "claro",
  "vale",
  // Italian
  "certo",
  // Dutch
  "oke",
  "prima",
  // Portuguese
  "pode",
];

const AMBIGUOUS_MAX_WORDS = 3;

/** Negations, stop words and hesitation: any of these wins over an affirmative. */
const NEGATIVE = [
  "no",
  "nope",
  "nah",
  "not",
  "don t",
  "dont",
  "do not",
  "cancel",
  "stop",
  "wait",
  "hold on",
  "never",
  "negative",
  "abort",
  "later",
  "maybe",
  "perhaps",
  "let me think",
  "nein",
  "nicht",
  "kein",
  "keine",
  "abbrechen",
  "stopp",
  "warte",
  "vielleicht",
  "non",
  "pas",
  "jamais",
  "annule",
  "annuler",
  "attends",
  "peut etre",
  "nee",
  "niet",
  "misschien",
  "nao",
  "nunca",
  "quizas",
  "quiza",
  "tal vez",
  "talvez",
  "annulla",
  "aspetta",
  "forse",
];

/** "yes, but ..." is not a yes. */
const QUALIFIERS = [
  "but",
  "however",
  "although",
  "except",
  "unless",
  "aber",
  "jedoch",
  "allerdings",
  "mais",
  "sauf",
  "pero",
  "sino",
  "ma",
  "maar",
  "mas",
];

/** A line that starts with one of these is a question, whatever else it contains. */
const INTERROGATIVE_LEADS = [
  // English
  "is that",
  "is it",
  "is this",
  "are you",
  "are we",
  "do you",
  "does",
  "did",
  "can you",
  "could you",
  "would",
  "should",
  "will",
  "what",
  "which",
  "how",
  "why",
  "when",
  "where",
  "who",
  // German
  "ist das",
  "ist es",
  "kannst du",
  "konnen wir",
  "soll ich",
  "sollen wir",
  "wie",
  "was",
  "welche",
  "welcher",
  "welches",
  "warum",
  "wann",
  "wo",
  "wer",
  // French
  "est ce",
  "quoi",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "combien",
  "pourquoi",
  "comment",
  "quand",
  "qui",
  // Spanish
  "que",
  "cual",
  "cuales",
  "cuanto",
  "cuanta",
  "cuantos",
  "como",
  "por que",
  "cuando",
  "donde",
  "quien",
  "es eso",
  "es esto",
  // Italian
  "cosa",
  "che",
  "quale",
  "quali",
  "quanto",
  "perche",
  "come",
  "dove",
  "chi",
  "e giusto",
  // Dutch
  "wat",
  "welke",
  "hoe",
  "hoeveel",
  "waarom",
  "wanneer",
  "waar",
  "is dat",
  "is het",
  "kun je",
  // Portuguese
  "o que",
  "qual",
  "quais",
  "onde",
  "quem",
];

/** Question words that make a line a question wherever they appear ("sure, what is it?"). */
const INTERROGATIVE_ANYWHERE = [
  "what",
  "which",
  "how much",
  "how many",
  "wie viel",
  "wieviel",
  "combien",
  "cuanto",
  "cuanta",
  "cuantos",
  "quanto",
  "quanta",
  "hoeveel",
];

export type ApprovalBlock = "negation" | "question" | "qualifier" | "ambiguous";

export interface ApprovalDecision {
  approved: boolean;
  /** The affirmative phrase found in the line, if any (also when the line was still refused). */
  matched: string | null;
  /** True when a negation, stop word or hesitation was present (always wins). */
  negated: boolean;
  /** Why an affirmative-looking line was refused; null when approved or when nothing matched. */
  blockedBy: ApprovalBlock | null;
  /** The exact transcript line, for the log. */
  line: string;
}

export function normalizeSpoken(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

function startsWithPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.startsWith(` ${phrase} `);
}

/** The earliest phrase of the list found in the line, longest on a tie ("i agree" over "agree"). */
function earliest(norm: string, phrases: readonly string[]): string | null {
  const padded = ` ${norm} `;
  let matched: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const p of phrases) {
    const at = padded.indexOf(` ${p} `);
    if (at < 0) continue;
    if (at < best || (at === best && matched !== null && p.length > matched.length)) {
      best = at;
      matched = p;
    }
  }
  return matched;
}

function isQuestion(raw: string, norm: string): boolean {
  if (raw.includes("?") || raw.includes("¿")) return true;
  if (INTERROGATIVE_LEADS.some((l) => startsWithPhrase(norm, l))) return true;
  return INTERROGATIVE_ANYWHERE.some((w) => hasPhrase(norm, w));
}

/** Decide whether a transcript line is a spoken "yes". */
export function expectYes(transcript: string): ApprovalDecision {
  const line = transcript;
  const norm = normalizeSpoken(transcript);
  const refuse = (blockedBy: ApprovalBlock | null, matched: string | null): ApprovalDecision => ({
    approved: false,
    matched,
    negated: blockedBy === "negation",
    blockedBy,
    line,
  });
  if (norm.length === 0) return refuse(null, null);

  const strong = earliest(norm, STRONG);
  const ambiguous = strong === null ? earliest(norm, AMBIGUOUS) : null;
  const matched = strong ?? ambiguous;

  if (NEGATIVE.some((n) => hasPhrase(norm, n))) return refuse("negation", matched);
  if (isQuestion(transcript, norm)) return refuse("question", matched);
  if (QUALIFIERS.some((q) => hasPhrase(norm, q))) return refuse("qualifier", matched);
  if (matched === null) return refuse(null, null);
  if (strong === null && norm.split(" ").length > AMBIGUOUS_MAX_WORDS) {
    return refuse("ambiguous", matched);
  }
  return { approved: true, matched, negated: false, blockedBy: null, line };
}

export interface SpokenApprovalRecord {
  turn: number;
  /** The transcript line exactly as recognised. */
  line: string;
  approved: boolean;
  matched: string | null;
  blockedBy: ApprovalBlock | null;
  at: string;
  /** What was being approved (action and estimated cost, as read back). */
  subject?: string;
}

/** Build the log entry stored next to the transcript when an approval is spoken. */
export function spokenApprovalRecord(
  turn: number,
  transcript: string,
  clock: Clock,
  subject?: string,
): SpokenApprovalRecord {
  const d = expectYes(transcript);
  return {
    turn,
    line: d.line,
    approved: d.approved,
    matched: d.matched,
    blockedBy: d.blockedBy,
    at: clock.nowIso(),
    ...(subject !== undefined ? { subject } : {}),
  };
}
