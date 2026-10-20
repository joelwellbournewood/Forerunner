/**
 * Spoken approvals. The conversation agent reads back an action and waits for "yes"; this
 * decides whether a transcript line is a yes and hands back the exact line so the approval
 * is logged with it (spec O.7).
 *
 * The decision is conservative: approvals gate above-routine actions and spending, so a
 * question ("is that correct?"), a qualified answer ("fine, but how much?"), a deferral or a
 * hand-off ("approve it after the review", "let me confirm with my manager") or an instruction
 * that merely contains an affirmative-looking word ("correct the budget first") must never
 * pass. A false "no" costs one repeated question; a false "yes" costs money.
 */
import type { Clock } from "@forerunner/platform";

/**
 * A phrase in normalised form. `only` names the language (BCP-47 prefix) the phrase belongs to
 * when it is also an ordinary word elsewhere: "sim" is a SIM card in English, "dale" a name,
 * "prima" is Dutch for "fine" and Italian for "first". See `applies()` for the gate.
 */
interface Phrase {
  phrase: string;
  only?: string;
}

type Entry = string | Phrase;

function asPhrase(e: Entry): Phrase {
  return typeof e === "string" ? { phrase: e } : e;
}

/** Unambiguous approvals (accents stripped, punctuation removed). */
const STRONG: Phrase[] = (
  [
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
    { phrase: "dale", only: "es" },
    "de acuerdo",
    "correcto",
    { phrase: "vamos", only: "es" },
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
    { phrase: "sim", only: "pt" },
  ] as Entry[]
).map(asPhrase);

/**
 * Words that are a "yes" on their own but also start instructions or acknowledgements
 * ("correct the budget", "ok, read me the plan", "das ist ja teuer"). They count only when
 * the whole line is short (at most AMBIGUOUS_MAX_WORDS words), e.g. "Correct.", "That's right",
 * "Fine by me".
 */
const AMBIGUOUS: Phrase[] = (
  [
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
    { phrase: "prima", only: "nl" },
    // Portuguese
    { phrase: "pode", only: "pt" },
  ] as Entry[]
).map(asPhrase);

const AMBIGUOUS_MAX_WORDS = 3;

/**
 * An unambiguous affirmative must open the line or come close to it: it may start at word
 * index STRONG_MAX_START at the latest, unless the whole line has at most SHORT_LINE_WORDS
 * words. "Everything about this plan is great and I approve" is not a plain yes.
 */
const STRONG_MAX_START = 3;
const SHORT_LINE_WORDS = 5;

/** Negations, stop words and hesitation: any of these wins over an affirmative. */
const NEGATIVE: Phrase[] = (
  [
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
    "a ver",
    "annulla",
    "aspetta",
    "forse",
  ] as Entry[]
).map(asPhrase);

/** "yes, but ..." is not a yes. */
const QUALIFIERS: Phrase[] = (
  [
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
  ] as Entry[]
).map(asPhrase);

/**
 * Deferrals, conditions and hand-offs: the line puts the decision off ("tomorrow", "after the
 * review", "first"), makes it someone else's ("my manager", "Simone said") or announces a step
 * before it ("let me", "I need to"). Any of these refuses, whatever affirmative is present.
 */
const DEFERRAL: Phrase[] = (
  [
    // English
    "first",
    "tomorrow",
    "tonight",
    "after",
    "afterwards",
    "before",
    "until",
    "till",
    "next week",
    "next month",
    "let me",
    "i need to",
    "i have to",
    "i must",
    "ask",
    "check",
    "said",
    "says",
    "told",
    "tell",
    "thinks",
    "wants",
    "my manager",
    "my boss",
    // German
    "zuerst",
    "erst",
    "erstmal",
    "morgen",
    "heute abend",
    "nachher",
    "danach",
    "spater",
    "vorher",
    "bevor",
    "nachste woche",
    "lass mich",
    "ich muss",
    "frag",
    "fragen",
    "sagt",
    "sagte",
    "meint",
    "prufen",
    "prufe",
    "mein chef",
    "meine chefin",
    // French
    "d abord",
    "demain",
    "ce soir",
    "apres",
    "avant",
    "jusqu a",
    "laisse moi",
    "laissez moi",
    "je dois",
    "il faut",
    "demande",
    "demander",
    "dit",
    "veut",
    "mon chef",
    "ma cheffe",
    "semaine prochaine",
    "plus tard",
    // Spanish
    "primero",
    "manana",
    "esta noche",
    "despues",
    "antes",
    "hasta",
    "dejame",
    "deja me",
    "tengo que",
    "debo",
    "pregunta",
    "preguntar",
    "dice",
    "dijo",
    "quiere",
    "mi jefe",
    "mi jefa",
    "proxima semana",
    "mas tarde",
    "luego",
    // Italian
    { phrase: "prima", only: "it" },
    "domani",
    "stasera",
    "dopo",
    "poi",
    "fino a",
    "fammi",
    "devo",
    "chiedi",
    "chiedere",
    "ha detto",
    "vuole",
    "il mio capo",
    "la mia capa",
    "piu tardi",
    // Dutch
    "eerst",
    "vanavond",
    "daarna",
    "laat me",
    "laat mij",
    "ik moet",
    "vraag",
    "zegt",
    "zei",
    "mijn baas",
    "volgende week",
    // Portuguese
    "primeiro",
    "amanha",
    "hoje a noite",
    "depois",
    "ate",
    "deixa me",
    "deixe me",
    "preciso",
    "tenho que",
    "perguntar",
    "disse",
    "diz",
    "quer",
    "meu chefe",
    "minha chefe",
  ] as Entry[]
).map(asPhrase);

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

export type ApprovalBlock = "negation" | "question" | "qualifier" | "deferral" | "ambiguous";

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

export interface ExpectYesOptions {
  /**
   * The session's language (BCP-47, e.g. "pt-BR"). Words that are ordinary words in another
   * language ("sim", "dale", "prima") count anywhere only in their own language; without a
   * language they count only when they open the line. See `applies()`.
   */
  language?: string;
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

/**
 * Whether a language-gated phrase counts at word `index`. Never when the session language is
 * known to be another one. For a blocking list (negations, deferrals) it then counts anywhere:
 * refusing is the safe side. For an affirmative list it must open the line: "Sim, pode." is a
 * yes, "Replace the SIM" is not, and the same holds in Portuguese ("Pode trocar o SIM").
 */
function applies(
  entry: Phrase,
  index: number,
  language: string | undefined,
  affirmative: boolean,
): boolean {
  if (!entry.only) return true;
  if (language !== undefined && !language.toLowerCase().startsWith(entry.only)) return false;
  return affirmative ? index === 0 : true;
}

/** Index of the first occurrence of `entry` as whole words, honouring the language gate. */
function indexOfPhrase(
  words: readonly string[],
  entry: Phrase,
  language: string | undefined,
  affirmative: boolean,
): number {
  const tokens = entry.phrase.split(" ");
  for (let i = 0; i + tokens.length <= words.length; i++) {
    if (tokens.every((t, j) => words[i + j] === t) && applies(entry, i, language, affirmative)) {
      return i;
    }
  }
  return -1;
}

function hasAny(words: readonly string[], list: readonly Phrase[], language?: string): boolean {
  return list.some((e) => indexOfPhrase(words, e, language, false) >= 0);
}

/** The earliest phrase of the list found in the line, longest on a tie ("i agree" over "agree"). */
function earliest(
  words: readonly string[],
  list: readonly Phrase[],
  language: string | undefined,
): { phrase: string; index: number } | null {
  let best: { phrase: string; index: number } | null = null;
  for (const e of list) {
    const at = indexOfPhrase(words, e, language, true);
    if (at < 0) continue;
    if (
      best === null ||
      at < best.index ||
      (at === best.index && e.phrase.length > best.phrase.length)
    ) {
      best = { phrase: e.phrase, index: at };
    }
  }
  return best;
}

function isQuestion(raw: string, norm: string): boolean {
  if (raw.includes("?") || raw.includes("¿")) return true;
  if (INTERROGATIVE_LEADS.some((l) => startsWithPhrase(norm, l))) return true;
  return INTERROGATIVE_ANYWHERE.some((w) => hasPhrase(norm, w));
}

/** Decide whether a transcript line is a spoken "yes". */
export function expectYes(transcript: string, opts: ExpectYesOptions = {}): ApprovalDecision {
  const line = transcript;
  const norm = normalizeSpoken(transcript);
  const language = opts.language;
  const refuse = (blockedBy: ApprovalBlock | null, matched: string | null): ApprovalDecision => ({
    approved: false,
    matched,
    negated: blockedBy === "negation",
    blockedBy,
    line,
  });
  if (norm.length === 0) return refuse(null, null);
  const words = norm.split(" ");

  const strong = earliest(words, STRONG, language);
  const ambiguous = strong === null ? earliest(words, AMBIGUOUS, language) : null;
  const found = strong ?? ambiguous;
  const matched = found?.phrase ?? null;

  if (hasAny(words, NEGATIVE, language)) return refuse("negation", matched);
  if (isQuestion(transcript, norm)) return refuse("question", matched);
  if (hasAny(words, QUALIFIERS, language)) return refuse("qualifier", matched);
  if (found === null) return refuse(null, null);
  if (strong === null && words.length > AMBIGUOUS_MAX_WORDS) {
    return refuse("ambiguous", matched);
  }
  if (hasAny(words, DEFERRAL, language)) return refuse("deferral", matched);
  if (strong !== null && strong.index > STRONG_MAX_START && words.length > SHORT_LINE_WORDS) {
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
  opts: ExpectYesOptions = {},
): SpokenApprovalRecord {
  const d = expectYes(transcript, opts);
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
