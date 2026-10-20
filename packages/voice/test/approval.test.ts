import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { expectYes, normalizeSpoken, spokenApprovalRecord } from "../src/approval.ts";

describe("expectYes", () => {
  it.each([
    ["Yes.", "yes"],
    ["yeah go ahead", "yeah"],
    ["OK, confirm.", "confirm"], // the unambiguous word is the one logged
    ["Confirmed", "confirmed"],
    ["Ja, mach das.", "mach das"],
    ["Jawohl!", "jawohl"],
    ["Oui, d'accord.", "oui"],
    ["Sí, adelante", "adelante"],
    ["Va bene, procedi.", "va bene"],
    ["Akkoord.", "akkoord"],
    ["Sim, pode.", "sim"],
    ["I agree, do it", "i agree"],
    ["Yes, approve the twelve franc run.", "yes"],
    ["Sure, go ahead and start the run.", "go ahead"],
    ["Sounds good to me.", "sounds good"],
  ])("accepts %j", (line, matched) => {
    const d = expectYes(line);
    expect(d.approved).toBe(true);
    expect(d.matched).toBe(matched);
    expect(d.negated).toBe(false);
    expect(d.blockedBy).toBeNull();
    expect(d.line).toBe(line);
  });

  it.each([
    ["Correct.", "correct"],
    ["That's correct", "correct"],
    ["Fine by me", "fine"],
    ["OK.", "ok"],
    ["Sure thing", "sure"],
    ["Ja.", "ja"],
    ["Genau.", "genau"],
    ["Sí.", "si"],
    ["Yes, that's right", "yes"],
  ])("accepts the ambiguous word in a short line %j", (line, matched) => {
    const d = expectYes(line);
    expect(d.approved).toBe(true);
    expect(d.matched).toBe(matched);
  });

  it.each([
    "No.",
    "Nope",
    "yes, but not now",
    "Nein, nicht jetzt.",
    "Non, annule.",
    "Wait, hold on",
    "Cancel that.",
    "Nee, niet doen.",
    "Não.",
    "Ok, stop.",
    "Maybe",
    "Perhaps later",
    "Right, let me think",
    "Ja, vielleicht",
    "Vamos a ver",
  ])("rejects %j as negated", (line) => {
    const d = expectYes(line);
    expect(d.approved).toBe(false);
    expect(d.negated).toBe(true);
    expect(d.blockedBy).toBe("negation");
  });

  // Instructions and questions that merely contain an affirmative-looking word (critic cases).
  it.each([
    ["Correct the budget first", "ambiguous"],
    ["Is that correct?", "question"],
    ["Is that correct", "question"],
    ["Sure, what is it exactly?", "question"],
    ["Sure what is it exactly", "question"],
    ["Fine, but how much does it cost?", "question"],
    ["Fine but how much does it cost", "question"],
    ["Sounds good, but which repo?", "question"],
    ["Sounds good but which repo", "question"],
    ["Yes?", "question"],
    ["Okay so what's the plan", "question"],
    ["Ist das richtig", "question"],
    ["Est-ce que c'est bon?", "question"],
    ["¿Correcto?", "question"],
    ["Yes, but first show me the diff", "qualifier"],
    ["Ja, aber erst den Plan zeigen", "qualifier"],
    ["Oui, mais pas tout de suite", "negation"],
    ["OK, read me the plan again", "ambiguous"],
    ["Fine, start with the cheaper one", "ambiguous"],
    ["Right now it is fine", "ambiguous"],
  ])("refuses %j (%s)", (line, blockedBy) => {
    const d = expectYes(line);
    expect(d.approved).toBe(false);
    expect(d.blockedBy).toBe(blockedBy);
  });

  // Deferrals, conditions and third parties: an affirmative word in a line that puts the
  // decision off or hands it to someone else is not a yes (critic cases).
  it.each([
    ["I need to confirm with my manager first", "deferral"],
    ["I'll approve it tomorrow", "deferral"],
    ["Approve it after the review", "deferral"],
    ["Let me confirm the number with Simone", "deferral"],
    ["Yes, run it tonight", "deferral"],
    ["Simone said yes", "deferral"],
    ["The client wants us to confirm by Friday", "deferral"],
    ["Einverstanden, zuerst den Plan zeigen", "deferral"],
    ["Oui, demain", "deferral"],
    ["Confirmo, primero el plan", "deferral"],
    ["Va bene, prima controllo", "deferral"],
    ["Akkoord, eerst het plan", "deferral"],
    ["Everything about this plan is great and I approve", "ambiguous"], // affirmative buried late
  ])("refuses %j (%s)", (line, blockedBy) => {
    const d = expectYes(line);
    expect(d.approved).toBe(false);
    expect(d.blockedBy).toBe(blockedBy);
    expect(d.matched).not.toBeNull(); // the affirmative was seen and still refused
  });

  it.each(["Replace the SIM", "Tell Dale about it", "Vamos a ver"])(
    "does not take %j for an approval in another language",
    (line) => {
      expect(expectYes(line).approved).toBe(false);
    },
  );

  it("gates words that are ordinary words elsewhere on the line start or the language", () => {
    expect(expectYes("Sim, pode.")).toMatchObject({ approved: true, matched: "sim" });
    expect(expectYes("Sim, pode.", { language: "pt-BR" })).toMatchObject({ approved: true });
    expect(expectYes("Sim, pode.", { language: "en" })).toMatchObject({
      approved: false,
      matched: null,
    });
    expect(expectYes("Replace the SIM").matched).toBeNull();
    expect(expectYes("Replace the SIM", { language: "pt" }).approved).toBe(false);
    expect(expectYes("Dale.")).toMatchObject({ approved: true, matched: "dale" });
    expect(expectYes("Tell Dale about it").matched).toBeNull();
    // Italian "prima" (first) blocks; Dutch "prima" (fine) approves only with the language set
    expect(expectYes("Prima.")).toMatchObject({ approved: false, blockedBy: "deferral" });
    expect(expectYes("Prima.", { language: "nl" })).toMatchObject({
      approved: true,
      matched: "prima",
    });
    // with the language known, Dutch "prima" is not even an affirmative in an Italian line
    expect(expectYes("Prima controllo.", { language: "it" })).toMatchObject({
      approved: false,
      matched: null,
    });
    expect(expectYes("Confermo, prima controllo.", { language: "it" })).toMatchObject({
      approved: false,
      matched: "confermo",
      blockedBy: "deferral",
    });
  });

  it.each(["What is the status?", "Maybe later we can look", "Tell me more", "", "   "])(
    "treats %j as not an approval",
    (line) => {
      expect(expectYes(line).approved).toBe(false);
    },
  );

  it("reports no block and no match for a plain statement", () => {
    expect(expectYes("Tell me more")).toEqual({
      approved: false,
      matched: null,
      negated: false,
      blockedBy: null,
      line: "Tell me more",
    });
  });

  it("normalises accents, case and punctuation", () => {
    expect(normalizeSpoken("  Bestätigt!!  ")).toBe("bestatigt");
    expect(expectYes("BESTÄTIGT.").approved).toBe(true);
  });

  it("does not match inside words", () => {
    expect(expectYes("yesterday was fine").approved).toBe(true); // "fine" matches, "yes" does not
    expect(expectYes("yesterday was fine").matched).toBe("fine");
    expect(expectYes("yesterday").approved).toBe(false);
    expect(expectYes("Simone agreed").matched).toBe("agreed");
  });

  it("builds a log record carrying the exact transcript line", () => {
    const clock = new SimulatedClock("2026-02-01T10:00:00Z");
    const rec = spokenApprovalRecord(
      3,
      "Yes, approve the 12 CHF run.",
      clock,
      "start session (est. 12 CHF)",
    );
    expect(rec).toEqual({
      turn: 3,
      line: "Yes, approve the 12 CHF run.",
      approved: true,
      matched: "yes",
      blockedBy: null,
      at: "2026-02-01T10:00:00.000Z",
      subject: "start session (est. 12 CHF)",
    });
    const refused = spokenApprovalRecord(4, "Is that correct?", clock);
    expect(refused).toMatchObject({ approved: false, matched: "correct", blockedBy: "question" });
    const deferred = spokenApprovalRecord(5, "Approve it after the review", clock);
    expect(deferred).toMatchObject({ approved: false, matched: "approve", blockedBy: "deferral" });
    const foreign = spokenApprovalRecord(6, "Sim.", clock, undefined, { language: "en" });
    expect(foreign).toMatchObject({ approved: false, matched: null, blockedBy: null });
  });
});
