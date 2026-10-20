import { describe, expect, it } from "vitest";
import { SentenceSplitter, splitSentences } from "../src/sentences.ts";

function streamed(text: string, size = 1): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  const last = s.flush();
  if (last) out.push(last);
  return out;
}

describe("SentenceSplitter", () => {
  it("emits a sentence as soon as its terminator and the following space arrive", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello there")).toEqual([]);
    expect(s.push(".")).toEqual([]); // could still be "3.5"-style
    expect(s.push(" How")).toEqual(["Hello there."]);
    expect(s.push(" are you? Fine!")).toEqual(["How are you?"]);
    expect(s.flush()).toBe("Fine!");
  });

  it("does not split on abbreviations, initials, decimals or list markers", () => {
    const text =
      "See e.g. the docs, i.e. page 3.5 by Dr. J. Smith at 10 a.m. in the U.S. office. Then go.";
    expect(splitSentences(text)).toEqual([
      "See e.g. the docs, i.e. page 3.5 by Dr. J. Smith at 10 a.m. in the U.S. office.",
      "Then go.",
    ]);
    expect(splitSentences("1. First item\n2. Second item")).toEqual([
      "1. First item",
      "2. Second item",
    ]);
    expect(splitSentences("Version 2.0.1 is out. Yes.")).toEqual(["Version 2.0.1 is out.", "Yes."]);
  });

  it("handles ellipses: continues on lowercase, splits before a capital", () => {
    expect(splitSentences("Well... maybe not. Hmm... Then again.")).toEqual([
      "Well... maybe not.",
      "Hmm...",
      "Then again.",
    ]);
    expect(splitSentences("Wait… what? Okay… Fine.")).toEqual(["Wait… what?", "Okay…", "Fine."]);
  });

  it("keeps closing quotes and brackets with the sentence", () => {
    expect(splitSentences('He said "Stop." Then he left (quietly). Done')).toEqual([
      'He said "Stop."',
      "Then he left (quietly).",
      "Done",
    ]);
    expect(splitSentences("“Really?” she asked. “Yes.”")).toEqual([
      "“Really?”",
      "she asked.",
      "“Yes.”",
    ]);
  });

  it("splits on newlines even without punctuation", () => {
    expect(splitSentences("First line\nSecond line\n\nThird")).toEqual([
      "First line",
      "Second line",
      "Third",
    ]);
    expect(splitSentences("Windows\r\nline endings. Ok")).toEqual([
      "Windows",
      "line endings.",
      "Ok",
    ]);
  });

  it("handles Spanish and French opening marks and guillemets", () => {
    expect(splitSentences("«Hola.» ¿Qué tal? ¡Muy bien! Gracias.")).toEqual([
      "«Hola.»",
      "¿Qué tal?",
      "¡Muy bien!",
      "Gracias.",
    ]);
    expect(splitSentences("Il a dit « Non. » Puis il est parti.")).toEqual([
      "Il a dit « Non. »",
      "Puis il est parti.",
    ]);
  });

  it("gives the same result whatever the delta size", () => {
    const text =
      "Status: all good. Two tasks remain, e.g. the build (see 1.2) and the docs... nothing urgent! ¿Algo más? No.";
    const whole = splitSentences(text);
    expect(streamed(text, 1)).toEqual(whole);
    expect(streamed(text, 3)).toEqual(whole);
    expect(streamed(text, 11)).toEqual(whole);
    expect(whole).toEqual([
      "Status: all good.",
      "Two tasks remain, e.g. the build (see 1.2) and the docs... nothing urgent!",
      "¿Algo más?",
      "No.",
    ]);
  });

  it("never emits empty sentences and flush() clears the buffer", () => {
    const s = new SentenceSplitter();
    expect(s.push("   \n\n  ")).toEqual([]);
    expect(s.push("Hi. ")).toEqual(["Hi."]);
    expect(s.flush()).toBeNull();
    expect(s.pending).toBe("");
  });

  it("accepts extra abbreviations", () => {
    const s = new SentenceSplitter({ abbreviations: ["Forerunner"] });
    expect(s.push("Ask Forerunner. it knows. Ok. ")).toEqual(["Ask Forerunner. it knows.", "Ok."]);
  });

  it("treats German abbreviations as non-terminal", () => {
    expect(splitSentences("Wir brauchen z.B. mehr Zeit, bzw. Geld. Alles klar.")).toEqual([
      "Wir brauchen z.B. mehr Zeit, bzw. Geld.",
      "Alles klar.",
    ]);
  });

  it("treats no/nr/vol/pp/fig as abbreviations only before a number", () => {
    expect(splitSentences("The answer is no. Two tasks remain. Ok.")).toEqual([
      "The answer is no.",
      "Two tasks remain.",
      "Ok.",
    ]);
    expect(splitSentences("See No. 5 and Fig. 3 in Vol. 2, pp. 10-12. Done.")).toEqual([
      "See No. 5 and Fig. 3 in Vol. 2, pp. 10-12.",
      "Done.",
    ]);
    expect(splitSentences("Die Antwort ist Nr. 7. Nein.")).toEqual([
      "Die Antwort ist Nr. 7.",
      "Nein.",
    ]);
    // Streaming: "no." waits for the next non-blank character, then decides.
    const s = new SentenceSplitter();
    expect(s.push("The answer is no.")).toEqual([]);
    expect(s.push(" ")).toEqual([]);
    expect(s.push("Two")).toEqual(["The answer is no."]);
    expect(s.flush()).toBe("Two");
    const n = new SentenceSplitter();
    expect(n.push("See no. ")).toEqual([]);
    expect(n.push("5. Then go.")).toEqual(["See no. 5."]);
    expect(n.flush()).toBe("Then go.");
    const text = "The answer is no. No. 5 is next. Nr. 7 too. Ok.";
    const whole = splitSentences(text);
    expect(whole).toEqual(["The answer is no.", "No. 5 is next.", "Nr. 7 too.", "Ok."]);
    expect(streamed(text, 1)).toEqual(whole);
    expect(streamed(text, 4)).toEqual(whole);
  });

  it("does not hold back sentences that end in short ordinary words", () => {
    expect(splitSentences("Ich mache es. Dann sehen wir weiter.")).toEqual([
      "Ich mache es.",
      "Dann sehen wir weiter.",
    ]);
    expect(splitSentences("Set it to max. Then wait a min. Ok.")).toEqual([
      "Set it to max.",
      "Then wait a min.",
      "Ok.",
    ]);
  });
});
