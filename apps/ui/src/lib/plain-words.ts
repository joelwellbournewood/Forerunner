/**
 * Plain words for what the app shows (U-074). The daemon's texts are written for every channel:
 * a voice read-back says "Say yes", an email card "reply yes to the email", a change sentence
 * ends in "Undo." for voice. In the app the person has buttons, so those hints are replaced or
 * dropped here; and the terms of the trade (tier, verdict, autonomy level) get their meaning.
 */

/** The voice and email hints a card or read-back carries, and what the app says instead. */
const IN_APP: Array<[RegExp, string]> = [
  [/\s*Say yes to confirm, or reply yes to the email\.?/g, ""],
  [/\s*Say yes to confirm\.?/g, ""],
  [/\s*reply yes to the email\.?/gi, ""],
  [/Say undo or tap Undo in the change log\.?/g, "Undo it from Changes."],
  [
    /Confirm in the app on a paired device; on the phone with biometric\.?/g,
    "Confirm on this device.",
  ],
];

/** A daemon text as the app shows it: no "say yes", "reply to the email" or "say undo". */
export function inAppText(text: string): string {
  let out = text;
  for (const [re, by] of IN_APP) out = out.replace(re, by);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * A change sentence without its spoken "Undo." (the app shows a button, or nothing when the
 * change cannot be undone here); `undo` says whether the sentence offered it.
 */
export function withoutUndoWord(text: string): { text: string; undo: boolean } {
  const m = /\s*\bUndo\.\s*$/.exec(text);
  if (!m) return { text, undo: false };
  return { text: text.slice(0, m.index).trimEnd(), undo: true };
}

/** How carefully the critic reviews a task of this risk tier (the tier in brackets). */
export function reviewLevel(tier: number | null | undefined): string {
  switch (tier) {
    case 0:
      return "checks only (tier 0)";
    case 1:
      return "light review (tier 1)";
    case 2:
      return "full review (tier 2)";
    case 3:
      return "full review and your sign-off (tier 3)";
    default:
      return "project default review";
  }
}

/** The critic's verdict on a task or a session, as a person reads it. */
export function verdictLabel(verdict: string | null | undefined): string {
  switch (verdict) {
    case "accept":
    case "pass":
      return "accepted";
    case "revise":
      return "sent back";
    case "escalate":
      return "sent back, stronger model";
    case "human":
      return "needs you";
    default:
      return verdict ?? "";
  }
}

const AUTONOMY: Record<number, { name: string; means: string }> = {
  0: { name: "Advisor", means: "plans and proposes only; you approve every action" },
  1: { name: "Assisted", means: "acts after you approve each session's plan" },
  2: { name: "Standard", means: "routine, reversible actions run; the rest asks you" },
  3: { name: "Trusted", means: "also merges reviewed pull requests" },
  4: { name: "Autopilot", means: "everything except destructive, money and credential actions" },
};

/** "Standard (level 2)" and what the level lets the agent do. */
export function autonomyLabel(level: number): { label: string; means: string } {
  const a = AUTONOMY[level];
  return a
    ? { label: `${a.name} (level ${level})`, means: a.means }
    : { label: `level ${level}`, means: "" };
}
