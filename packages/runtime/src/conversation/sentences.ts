/**
 * Complete sentences of a chat reply (the real-audio run of 2026-10-26): a reply that ends at
 * the model's `max_tokens` stops mid-sentence ("...one of the three options: adopt,"), and
 * neither the speaker nor the transcript may present that fragment as a finished answer.
 *
 * `SentenceGate` passes streamed text on one complete sentence at a time (the voice loop's own
 * splitter decides what a sentence is, abbreviations and decimals included) and holds the
 * unfinished rest until the model call ends: a call that ended normally releases it, a call
 * cut off at `max_tokens` drops it. `completeSentencesOf` applies the same rule to a whole text.
 */
import { SentenceSplitter } from "@forerunner/voice/sentences";

/** Ends with a sentence terminator, optionally followed by closing quotes or brackets. */
const SENTENCE_END = /[.!?…。！？]["”’'»)\]}›]*$/u;

export class SentenceGate {
  private readonly splitter = new SentenceSplitter();
  /** Text given and not passed on yet: always the splitter's pending text, less leading space. */
  private held = "";
  private started = false;

  constructor(private readonly out: (text: string) => void) {}

  /**
   * Feed a streamed delta. Every sentence it completes is passed on exactly as written, with the
   * whitespace after it (the boundary the consumer's own splitter needs to see the sentence end
   * at once, rather than when the next sentence ends). The first delta always produces a call:
   * an empty piece when no sentence is complete yet, so a consumer that stamps the model's first
   * token on its first piece (the voice loop's `modelFirstTokenMs`) still stamps it then.
   */
  push(delta: string): void {
    if (!delta) return;
    const unsent = this.held + delta.replace(/\r\n?/g, "\n");
    this.splitter.push(delta);
    // The splitter's pending text is a suffix of what was not passed on (the part already
    // passed on is at most its leading whitespace); keep only its non-blank part back.
    const keep = Math.min(this.splitter.pending.trimStart().length, unsent.length);
    const ready = unsent.slice(0, unsent.length - keep);
    this.held = unsent.slice(unsent.length - keep);
    if (ready || !this.started) this.out(ready);
    this.started = true;
  }

  /**
   * The model call ended. The held rest is passed on unless the call was `cut` off at
   * `max_tokens` and the rest is not a whole sentence (a cut that fell right after a period
   * keeps its sentence).
   */
  end(cut: boolean): void {
    const rest = this.held;
    this.held = "";
    this.splitter.reset();
    if (!rest) return;
    if (!cut || SENTENCE_END.test(rest.trimEnd())) this.out(rest);
  }
}

/** The text up to its last complete sentence, trimmed; "" when it has none. */
export function completeSentencesOf(text: string): string {
  const parts: string[] = [];
  const gate = new SentenceGate((t) => parts.push(t));
  gate.push(text);
  gate.end(true);
  return parts.join("").trim();
}

// --- d1109-selftasks-chat: "fix the tasks" (design §5: one to three plain sentences) ----------

/** Without Claude: the check is a planning call. */
// fixup-l4-selftasks-chat (L4-selftasks-127; design §5 rule 8): it says what to do, and where
// ("Which Claude does the work" is under Settings, Basics). Before: "Fixing the tasks needs
// Claude." and nothing else.
export const FIX_NEEDS_CLAUDE = "Fixing the tasks needs Claude: connect it in Settings, Basics.";

/** The waiting line while the check runs (design §3.9: what chat is doing while you wait). */
export function fixCheckingStep(project: string): string {
  return `Checking the tasks of ${project}…`;
}

/** A second "fix the tasks" while one check of the project runs: no second check. */
export function fixBusyReply(project: string): string {
  return `The agent is checking the tasks of ${project} now; ask again in a moment.`;
}

/** The check's cap does not fit the room the project's budget or the month cap leaves. */
export function fixNoRoomReply(level: "project" | "month" | "plan"): string {
  if (level === "month") return "Fixing the tasks would pass your monthly cap; nothing changed.";
  if (level === "plan")
    return "Fixing the tasks would pass the share of your subscription Forerunner may use; nothing changed.";
  return "Fixing the tasks would pass this project's budget; nothing changed.";
}

/** SC-14: the person's credential policy holds the check (no call, nothing booked). */
export function fixHeldReply(stopped: string): string {
  return `Fixing the tasks waits for Claude: ${stopped}. Nothing changed.`;
}

/** The changes were made at once (Standard and up): each row below has its Undo. */
export function fixChangedReply(count: number, project: string): string {
  return `I changed ${count} ${count === 1 ? "task" : "tasks"} of ${project}.`;
}

/** The check found nothing to change. */
export function fixNoChangeReply(project: string): string {
  return `The tasks of ${project} look right; nothing changed.`;
}

/** The call ended without a reply (booked; nothing changed). */
export function fixFailedReply(project: string): string {
  return `Checking the tasks of ${project} did not work: Claude did not answer. Nothing changed.`;
}

/** The reply could not be read (booked; nothing changed). */
export function fixUnreadableReply(project: string): string {
  return `The agent's answer about the tasks of ${project} could not be read; nothing changed.`;
}

/** Talk without a project on screen: which project's tasks. */
export function fixWhichProject(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const list =
    shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
  return `Which project: ${list}${names.length > 3 ? ` (or another of your ${names.length})` : ""}?`;
}

/** No project to fix at all. */
export const FIX_NO_PROJECT = "There is no project whose tasks I could fix yet.";

/**
 * The one read-back of several changes (Advisor, Assisted, a set that asks first, or a turn that
 * read a record): 'Make these 3 changes to the tasks of Quote page? Split "Style the page" into
 * "A" and "B"; add "Check the links".' One change reads as its own question.
 */
export function fixAsk(project: string, changes: readonly string[]): string {
  const list = changes.map((c) => c.trim().replace(/[.?]+$/, "")).filter(Boolean);
  if (list.length === 1) return `${list[0]}?`;
  const lower = (c: string) => (/^[A-Z][a-z]/.test(c) ? `${c[0]?.toLowerCase()}${c.slice(1)}` : c);
  const [first, ...rest] = list as [string, ...string[]];
  return `Make these ${list.length} changes to the tasks of ${project}? ${[first, ...rest.map(lower)].join("; ")}.`;
}

/** What the check left out, in one sentence ('Left out: split "X": it is running, so …'). */
export function fixLeftOut(refused: readonly { what: string; reason: string }[]): string {
  if (!refused.length) return "";
  const [one] = refused;
  const more = refused.length > 1 ? ` (and ${refused.length - 1} more)` : "";
  return `Left out${more}: ${one?.what.replace(/[.\s]+$/, "")}: ${one?.reason.replace(/[.\s]+$/, "")}.`;
}

/** The line under the reply: what the check cost ("Checking the tasks cost CHF 0.03."). */
export function fixCostFooter(money: string): string {
  return `Checking the tasks cost ${money}.`;
}
