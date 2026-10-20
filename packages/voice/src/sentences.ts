/**
 * Incremental sentence splitter for streaming model text.
 *
 * Text arrives as deltas of any size. A sentence is emitted the moment it is known to be
 * complete, so TTS can start on sentence one while the model is still writing sentence two.
 * Handles abbreviations ("e.g.", "Dr."), initials ("J. Smith"), decimals ("3.5"), ordered
 * list markers ("1. First"), ellipses, closing quotes and brackets, newlines, and the Spanish
 * and French opening marks "¿" "¡" "«".
 */

const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);
const CLOSERS = new Set(['"', "”", "’", "'", "»", ")", "]", "}", "›"]);

const ABBREVIATIONS = new Set(
  [
    // English
    "e.g",
    "i.e",
    "etc",
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "sr",
    "jr",
    "st",
    "vs",
    "no",
    "fig",
    "approx",
    "inc",
    "ltd",
    "co",
    "corp",
    "dept",
    "est",
    "min",
    "max",
    "ca",
    "cf",
    "al",
    "ex",
    "p",
    "pp",
    "vol",
    "ed",
    "eds",
    "a.m",
    "p.m",
    "u.s",
    "u.k",
    "e.u",
    "ph.d",
    "misc",
    "resp",
    // German
    "z.b",
    "bzw",
    "usw",
    "nr",
    "evtl",
    "ggf",
    "inkl",
    "sog",
    "u.a",
    "vgl",
    "zzgl",
    "str",
    "d.h",
    "o.ä",
    "s.o",
    "s.u",
    "tel",
    // French
    "m",
    "mme",
    "mlle",
    "env",
    "éd",
    "p.ex",
    // Spanish
    "sra",
    "srta",
    "dra",
    "ud",
    "uds",
    "pág",
    "núm",
    "p.ej",
    // Italian
    "sig",
    "dott",
    "ecc",
    "es",
    "pag",
    // Dutch
    "bv",
    "dhr",
    "mevr",
    "enz",
    "bijv",
  ].map((w) => w.toLowerCase()),
);

export interface SentenceSplitterOptions {
  /** Extra abbreviations (without the trailing period). */
  abbreviations?: string[];
}

export class SentenceSplitter {
  private buffer = "";
  private scanFrom = 0;
  private readonly abbreviations: Set<string>;

  constructor(opts: SentenceSplitterOptions = {}) {
    this.abbreviations = new Set(ABBREVIATIONS);
    for (const a of opts.abbreviations ?? []) {
      this.abbreviations.add(a.replace(/\.$/, "").toLowerCase());
    }
  }

  /** Text accumulated but not yet emitted. */
  get pending(): string {
    return this.buffer;
  }

  /** Feed a delta. Returns every sentence completed by it, in order. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta.replace(/\r\n?/g, "\n");
    return this.scan();
  }

  /** End of stream: return whatever is left as the last sentence (or null when empty). */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    this.scanFrom = 0;
    return rest.length > 0 ? rest : null;
  }

  reset(): void {
    this.buffer = "";
    this.scanFrom = 0;
  }

  private scan(): string[] {
    const out: string[] = [];
    let i = this.scanFrom;
    while (i < this.buffer.length) {
      const ch = this.buffer[i] as string;

      if (ch === "\n") {
        const sentence = this.buffer.slice(0, i).trim();
        if (sentence) out.push(sentence);
        this.buffer = this.buffer.slice(i + 1);
        i = 0;
        continue;
      }

      if (!TERMINATORS.has(ch)) {
        i++;
        continue;
      }

      // Extend over a run of terminators ("...", "?!", "!!!").
      let j = i;
      while (j + 1 < this.buffer.length && TERMINATORS.has(this.buffer[j + 1] as string)) j++;
      // Then over closing quotes and brackets.
      let k = j;
      for (;;) {
        if (k + 1 < this.buffer.length && CLOSERS.has(this.buffer[k + 1] as string)) {
          k++;
          continue;
        }
        // French typography puts a space before the closing guillemet: « Non. »
        if (
          k + 2 < this.buffer.length &&
          isWhitespace(this.buffer[k + 1] as string) &&
          this.buffer[k + 2] === "»"
        ) {
          k += 2;
          continue;
        }
        break;
      }

      if (k + 1 >= this.buffer.length) {
        // Need the next character to decide ("3." may become "3.5"; "e.g." needs its space).
        this.scanFrom = i;
        return out;
      }
      const next = this.buffer[k + 1] as string;
      if (!isWhitespace(next)) {
        // Inside a token: decimal, URL, version number, "e.g" mid-way.
        i = k + 1;
        continue;
      }

      const run = this.buffer.slice(i, j + 1);
      if (run === ".") {
        const before = this.buffer.slice(0, i);
        if (this.isAbbreviationOrMarker(before)) {
          i = k + 1;
          continue;
        }
      } else if (/^[.…]+$/.test(run)) {
        // Ellipsis: a sentence boundary only when the continuation starts a new sentence.
        let m = k + 1;
        while (m < this.buffer.length && isWhitespace(this.buffer[m] as string)) m++;
        if (m >= this.buffer.length) {
          this.scanFrom = i;
          return out;
        }
        if (isLowercase(this.buffer[m] as string)) {
          i = k + 1;
          continue;
        }
      }

      const sentence = this.buffer.slice(0, k + 1).trim();
      if (sentence) out.push(sentence);
      this.buffer = this.buffer.slice(k + 1);
      i = 0;
    }
    this.scanFrom = this.buffer.length;
    return out;
  }

  /** `before` is the text up to (not including) a period followed by whitespace. */
  private isAbbreviationOrMarker(before: string): boolean {
    const m = before.match(/([\p{L}\p{N}][\p{L}\p{N}.]*)$/u);
    if (!m) return false;
    const word = m[1] as string;
    const lower = word.toLowerCase();
    if (this.abbreviations.has(lower)) return true;
    // Single-letter initials: "J. Smith", "a. first item".
    if (/^\p{L}$/u.test(word)) return true;
    // A numbered list marker at the start of the sentence: "1. First".
    if (/^\p{N}+$/u.test(word) && before.trim() === word) return true;
    // "U.S.A" style: letters separated by periods.
    if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return true;
    return false;
  }
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function isLowercase(ch: string): boolean {
  return /\p{Ll}/u.test(ch);
}

/** Split a complete text in one go (convenience for summaries and alerts). */
export function splitSentences(text: string, opts?: SentenceSplitterOptions): string[] {
  const s = new SentenceSplitter(opts);
  const out = s.push(text);
  const last = s.flush();
  if (last) out.push(last);
  return out;
}
