import type { SignoffAnswer } from "@forerunner/critic";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue } from "@forerunner/state";
import type { ModelWatchAnswer, ModelWatchDecision } from "../models/watch.ts";
import type { SpecialistAnswer } from "../registry/approval.ts";
import type { BlockedFindingsAnswer } from "../session/findings.ts";
import type { PlanAnswer } from "../session/plan-approval.ts";

/**
 * Answers to Inbox requests as the person gives them. The Inbox shows a request's options as
 * buttons (`optionLabel`) and a click sends that text back as the answer; every reader of an
 * answer (`isYes`, the sign-off and findings readers, the plan, intake and specialist readers)
 * is written against those strings. A path that answers for the person in another way (the
 * phone's Reviews tab) answers with the option it means, so the stored answer is exactly
 * what a click would have stored; and an answer route refuses a typed answer that a card
 * whose answer must be one of its options cannot act on (`acceptsAnswer`), before the request
 * is closed.
 *
 * The readers of the cards with their own words live here (and are re-exported where the
 * cards are filed and applied), so the answer routes, the UI's stand-in daemon and the syncs
 * read an answer with one function. This module imports nothing but types beyond
 * `@forerunner/platform`: the UI's tests load it in a browser environment.
 */

/**
 * What a request's option says on its button, and what a click sends back. Options are strings;
 * rows written before U-021 hold objects (`{ choice: "approve", … }`), which `String` turned into
 * "[object Object]". Such an option shows its `label` or `choice`, capitalised; `isYes` reads
 * "Approve" as yes and "Deny" as no.
 */
export function optionLabel(option: unknown): string {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    const o = option as { label?: unknown; choice?: unknown };
    const text =
      typeof o.label === "string" ? o.label : typeof o.choice === "string" ? o.choice : "";
    if (text) return text.charAt(0).toUpperCase() + text.slice(1);
    return JSON.stringify(option);
  }
  return String(option);
}

/** An answer word the way the readers compare it: trimmed, lower case, one space between words. */
export function normalAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

// ---------------------------------------------------------------------------------------
// The readers of the cards with their own words

/**
 * Card keys (`change_card.key`) of the cards read below. Each equals the constant its producer
 * files the card with (`SIGNOFF_KEY` in `@forerunner/critic`, `BLOCKED_FINDINGS_KEY`,
 * `PLAN_KEY_PREFIX`, `INTAKE_KEY_PREFIX`, `SPECIALIST_KEY_PREFIX`,
 * `MODEL_WATCH_REQUEST_PREFIX`); `request-answers.test.ts` asserts it, so a renamed key fails
 * there instead of letting its answers through unchecked.
 */
export const ANSWER_CARD_KEYS = {
  signoff: "critic:signoff",
  blockedFindings: "findings:blocked",
  planPrefix: "plan:",
  intakePrefix: "intake:",
  specialistPrefix: "specialist:",
  modelWatchPrefix: "model_watch:",
  /**
   * Cards whose readers act only on their options and live outside this module: the rebase
   * conflict (`REBASE_CONFLICT_KEY`, `@forerunner/capabilities`) and the merge left open
   * (`MERGE_LEFT_OPEN_KEY`, `loop/merge.ts`), both `decision` cards read in
   * `session/pr-answers.ts` (U-028), and the session review (`SESSION_REVIEW_KEY`,
   * `@forerunner/critic`, U-033). They take one of their options and nothing else, not even
   * the yes / no words of two-option approvals, which their readers do not read.
   */
  optionOnly: ["githost:rebase_conflict", "merge:left_open", "critic:session_review"],
} as const;

/** The word of an inbox answer: the string itself, or the `choice` / `answer` of an object. */
export function answerWord(answer: JsonValue | null): string | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).choice ?? (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  return normalAnswer(raw);
}

/** The answer of a critic sign-off request (`session/findings.ts`) as one of its options, or null. */
export function signoffAnswer(answer: JsonValue | null): SignoffAnswer | null {
  const v = answerWord(answer);
  if (v === null) return null;
  if (/^(accept|accepted|approve|approved|sign off|signed off|signoff)$/.test(v)) return "accept";
  if (/^(revise|revised|rework|retry|redo|changes)$/.test(v)) return "revise";
  if (/^(cancel|cancelled|canceled|drop)$/.test(v)) return "cancel";
  return null;
}

/** The answer of a blocked-findings request (`session/findings.ts`) as one of its options, or null. */
export function blockedFindingsAnswer(answer: JsonValue | null): BlockedFindingsAnswer | null {
  const v = answerWord(answer);
  if (v === null) return null;
  if (/^(rework|revise|retry|redo)$/.test(v)) return "rework";
  if (/^(accept|accepted|resolve|resolved|close)$/.test(v)) return "accept";
  if (/^(cancel|cancelled|canceled|drop)$/.test(v)) return "cancel";
  return null;
}

/** The answer of an intake request (`session/intake.ts`) as one of its options, or null. */
export function intakeAnswer(answer: JsonValue | null): "approve" | "reject" | null {
  const v = answerWord(answer);
  if (v === null) return null;
  if (/^(approve|approved|accept|accepted|yes|ok|apply|go)$/.test(v)) return "approve";
  if (/^(reject|rejected|no|decline|declined|deny|denied|drop|cancel)$/.test(v)) return "reject";
  return null;
}

/** The `option`, `choice` or `answer` of an answer, trimmed and lower case. */
function optionWord(answer: JsonValue | null): string | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).option ??
          (answer as JsonObject).choice ??
          (answer as JsonObject).answer)
        : null;
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

/** The answer of a session plan request (`session/plan-approval.ts`) as one of its options, or null. */
export function planAnswer(answer: JsonValue | null): PlanAnswer | null {
  const v = optionWord(answer);
  if (v === null) return null;
  if (/^(approve|approved|yes|run|go|ok)$/.test(v)) return "approve";
  if (/^(reject|rejected|no|deny|denied|cancel|drop)$/.test(v)) return "reject";
  return null;
}

/** The answer of a specialist proposal (`registry/approval.ts`) as one of the options, or null. */
export function specialistAnswer(answer: JsonValue | null): SpecialistAnswer | null {
  const v = optionWord(answer);
  if (v === null) return null;
  if (/^(approve|approved|yes|activate|ok)$/.test(v)) return "approve";
  if (/^(reject|rejected|no|deny|denied|withdraw|drop)$/.test(v)) return "reject";
  return null;
}

/**
 * The decision of a model watch answer (`models/watch.ts`, `answerFromHumanRequest`): a word
 * the decision starts with, or an object's `decision` / `choice` / `answer` with the
 * recommendations to adopt; null when it is not readable.
 */
export function modelWatchAnswerOf(raw: JsonValue | null): Omit<ModelWatchAnswer, "by"> | null {
  const decisionOf = (s: string): ModelWatchDecision | null => {
    const t = s.trim().toLowerCase();
    if (/^(adopt|yes|approve|approved|ok)\b/.test(t)) return "adopt";
    if (/^(evaluate|run (the )?eval(uation)?s?)\b/.test(t)) return "evaluate";
    if (/^(ignore|no|reject|dismiss)\b/.test(t)) return "ignore";
    if (/^(remind|later|next week|snooze)\b/.test(t)) return "remind";
    return null;
  };
  if (typeof raw === "string") {
    const decision = decisionOf(raw);
    return decision ? { decision } : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { decision?: unknown; choice?: unknown; answer?: unknown; adopt?: unknown };
    const chosen = o.decision ?? o.choice ?? o.answer;
    if (typeof chosen !== "string") return null;
    const decision = decisionOf(chosen);
    if (!decision) return null;
    const adopt = Array.isArray(o.adopt)
      ? o.adopt.filter((x): x is string => typeof x === "string")
      : undefined;
    return { decision, ...(adopt ? { adopt } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// A review verdict from the phone (U-027)

/** Options that approve what a review approves: the task's work stands. */
const APPROVING = /^(approve|approved|accept|accepted|yes|ok|confirm|confirmed|apply|sign off)$/;

/**
 * Options that reject what a review rejects, best first. Sending the work back (the sign-off's
 * "revise", the findings card's "rework": the findings become the next brief's constraints) is
 * what a rejected review means; "cancel" ends the task and is never a review's reject.
 */
const REJECTING: readonly RegExp[] = [
  /^(revise|rework|redo|retry)$/,
  /^(reject|rejected)$/,
  /^(deny|denied|no|decline|declined)$/,
];

/**
 * The option a review verdict from the phone's Reviews tab answers the task's open approval
 * request with (U-027): Approve is the option that accepts the work (`accept`, `yes`,
 * `approve`), Reject the one that sends it back (`revise`, `rework`, else `reject`, `deny`,
 * `no`). The answer is the option's text as the Inbox shows it, so every reader reads it as
 * the click on that button. A request without options takes the verdict's own word ("approve"
 * reads as yes, "reject" as no). Null: no option means the verdict, so the request is left
 * open for the Inbox.
 */
export function reviewVerdictOption(
  request: Pick<HumanRequestRow, "options">,
  verdict: "approve" | "reject",
): string | null {
  const labels = request.options.map(optionLabel);
  if (labels.length === 0) return verdict;
  if (verdict === "approve") return labels.find((l) => APPROVING.test(normalAnswer(l))) ?? null;
  for (const re of REJECTING) {
    const hit = labels.find((l) => re.test(normalAnswer(l)));
    if (hit !== undefined) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Which answers a request can act on (U-034)

/** The parts of a request (a row, or the Inbox's view of one) that say what it can act on. */
export interface AnswerTarget {
  kind: string;
  options: readonly unknown[];
  /** The request's `change_card` (an object whose `key` names the card), or anything else. */
  change_card: unknown;
}

/**
 * A card with its own reader: the reader decides, so the route accepts exactly what the sync
 * that applies the answer will act on (a case, spaces, the reader's own words: "approved",
 * "redo", "withdraw").
 */
const READERS: ReadonlyArray<{
  matches: (key: string) => boolean;
  read: (answer: JsonValue) => unknown;
}> = [
  { matches: (k) => k === ANSWER_CARD_KEYS.signoff, read: signoffAnswer },
  { matches: (k) => k === ANSWER_CARD_KEYS.blockedFindings, read: blockedFindingsAnswer },
  { matches: (k) => k.startsWith(ANSWER_CARD_KEYS.planPrefix), read: planAnswer },
  { matches: (k) => k.startsWith(ANSWER_CARD_KEYS.intakePrefix), read: intakeAnswer },
  { matches: (k) => k.startsWith(ANSWER_CARD_KEYS.specialistPrefix), read: specialistAnswer },
  { matches: (k) => k.startsWith(ANSWER_CARD_KEYS.modelWatchPrefix), read: modelWatchAnswerOf },
];

/**
 * The words every reader of a two-option approval (`isYes` for the hooks, extensions, shared
 * secrets and updates; the mirror's and the remote commands' readers) reads the same way: a yes
 * for the first option, a no for the second. Words only some of them take ("ok", "y") are left
 * out, so an accepted word never means one thing to one card and another to the next.
 */
const TWO_OPTION_WORDS = /^(yes|approve|approved|no|deny|denied|reject|rejected)$/;

/** The word an answer carries: the string, or an object's `choice` / `option` / `answer`. */
function answerText(answer: unknown): string | null {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const o = answer as Record<string, unknown>;
    const word = o.choice ?? o.option ?? o.answer;
    return typeof word === "string" ? word : null;
  }
  return null;
}

/**
 * Whether a request can act on this answer, and if not the options to choose from (U-034).
 * Before this a typed answer that matched no option closed the card, and the sync then recorded
 * `unrecognized_answer`: the task sat in review or `needs_human` with no card left to answer.
 *
 * - A card with its own reader (sign-off, blocked findings, session plan, intake, specialist
 *   proposal, model watch: `READERS`) takes what that reader takes.
 * - A card of `ANSWER_CARD_KEYS.optionOnly` (the U-028 pull-request cards, the U-033 session
 *   review) takes one of its options.
 * - Any other approval with options takes one of its options (case, surrounding spaces and
 *   `_`/`-` do not matter), and a two-option approval also the words of `TWO_OPTION_WORDS`.
 * - Everything else takes free text: a request without options, a decision (a question whose
 *   answer may be the person's own words; the decision log records it), info, a credential
 *   (the unlock card's answer is the wrapped key).
 */
export function acceptsAnswer(
  request: AnswerTarget,
  answer: unknown,
): { ok: true } | { ok: false; options: string[]; message: string } {
  const labels = request.options.map(optionLabel);
  const refuse = () => {
    const given = answerText(answer)?.trim() ?? "";
    const quoted = given
      ? `"${given.slice(0, 80)}" is not an answer this request can act on. `
      : "";
    return {
      ok: false as const,
      options: labels,
      message: `${quoted}Choose one of: ${labels.join(", ")}.`,
    };
  };
  if (labels.length === 0) return { ok: true };
  const card = request.change_card;
  const key =
    card && typeof card === "object" && !Array.isArray(card)
      ? (card as { key?: unknown }).key
      : undefined;
  const reader = typeof key === "string" ? READERS.find((r) => r.matches(key)) : undefined;
  if (reader) {
    const read = answer === undefined ? null : reader.read(answer as JsonValue);
    return read === null || read === undefined ? refuse() : { ok: true };
  }
  // An approval asks for one of its options, and so does a decision whose reader reads only
  // its options; any other decision, info or credential takes the answer as given.
  const optionOnly =
    typeof key === "string" && (ANSWER_CARD_KEYS.optionOnly as readonly string[]).includes(key);
  if (request.kind !== "approval" && !optionOnly) return { ok: true };
  const text = answerText(answer);
  if (text === null) return refuse();
  const word = normalAnswer(text);
  if (labels.some((l) => normalAnswer(l) === word)) return { ok: true };
  // The shared yes / no words are for approvals; an option-only decision's reader does not
  // read them.
  if (!optionOnly && labels.length === 2 && TWO_OPTION_WORDS.test(word)) return { ok: true };
  return refuse();
}

/** `details.reason` of the refusal; the daemon answers it 400, as the state service does. */
export const NOT_AN_OPTION = "not_an_option";

/** `acceptsAnswer` as a refusal: a `validation` error naming the options; the request stays open. */
export function assertAnswerAccepted(
  request: AnswerTarget & { id?: string },
  answer: unknown,
): void {
  const check = acceptsAnswer(request, answer);
  if (check.ok) return;
  throw new ForerunnerError("validation", check.message, {
    details: {
      reason: NOT_AN_OPTION,
      options: check.options,
      ...(request.id ? { requestId: request.id } : {}),
    },
  });
}
