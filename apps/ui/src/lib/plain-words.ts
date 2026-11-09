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
  // W15B-24: the short form a read-back with one question ends in (the daemon's executor.ts);
  // the person is in the app already. Voice and the phone keep the daemon's words.
  [/Confirm in the app on a paired device\.?/g, "Confirm on this device."],
];

/** A daemon text as the app shows it: no "say yes", "reply to the email" or "say undo". */
export function inAppText(text: string): string {
  let out = text;
  for (const [re, by] of IN_APP) out = out.replace(re, by);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * A specialist's line as the app shows it (W15B-17): code ticks, bold, emphasis, a heading or
 * list marker dropped, a link as its words and its address, so "Can `developer.mozilla.org` be
 * added?" reads "Can developer.mozilla.org be added?". Only for what is shown: an answer sent
 * keeps the question as it was asked.
 */
export function withoutMarks(text: string): string {
  return text
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, "$1$2")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, words: string, href: string) =>
      words === href ? words : `${words} (${href})`,
    )
    .replace(/(^|[\s(])[*_]([^*_\s][^*_\n]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^\s*#+\s+/, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
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
    // Design §2, §5 rule 6: the level in words, never "tier N". Tier 0 is reviewed as the
    // light review (ADR 0104).
    case 0:
    case 1:
      return "light review";
    case 2:
      return "full review";
    case 3:
      return "full review and your sign-off";
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
  // merge-in-app (the owner's decision of 2026-11-02): merging is its own per-project setting,
  // "Who merges accepted work"; level 3 no longer merges.
  3: {
    name: "Trusted",
    means: "also changes tasks and docs, starts costly sessions and deploys to staging",
  },
  4: { name: "Autopilot", means: "everything except destructive, money and credential actions" },
};

/**
 * The five autonomy levels by name with what each lets the agent do (design §2: "Autonomy lives
 * in Settings with its name"): the one list every autonomy control in Settings offers.
 */
export const AUTONOMY_LEVELS: readonly { level: number; name: string; means: string }[] = [
  0, 1, 2, 3, 4,
].map((level) => ({ level, ...(AUTONOMY[level] as { name: string; means: string }) }));

/** "Standard (level 2)" and what the level lets the agent do. */
export function autonomyLabel(level: number): { label: string; means: string } {
  const a = AUTONOMY[level];
  return a
    ? { label: `${a.name} (level ${level})`, means: a.means }
    : { label: `level ${level}`, means: "" };
}
