import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { notesPersons, quote } from "./shared.ts";

/**
 * fixup-l4-selftasks-carried: what the model is told of `note` (model-facing: the exact text is
 * asserted, packages/commands/test/selftasks-carried.test.ts).
 */
export const ANSWER_NOTE_DESCRIPTION =
  "Only with an option that takes a note (Try again, Send it back): words the person gave for the next attempt, quoted as they said them; leave it out when they gave none.";

/**
 * request.answer (spec J human requests): answer an open request by id or id prefix. The
 * risk is the request's own risk, so a high-risk approval still needs a paired device.
 */
const params = z.object({
  /** Request id or a prefix of at least four characters. */
  request: z.string().min(4),
  answer: z.string().min(1),
  /**
   * The note an option that takes one carries to the task's next brief (`{ choice, note }`, as
   * the Inbox sends it); a move said in chat carries its note here (`moveAsCardAnswer`).
   */
  note: z.string().trim().max(2000).optional().describe(ANSWER_NOTE_DESCRIPTION),
});
export type RequestAnswerParams = z.infer<typeof params>;

/**
 * Whether a request is a change waiting for its yes (the executor's pending card, filed with
 * its command, decision and email token): never what an answer by reference means. Request ids
 * are time-ordered, so the read-back of an answer filed a moment after the card it answers
 * shares its first characters; before, the yes to "answer 01a19caa" then found both and was
 * refused with "several open requests start with 01a19caa" (phase E bench walk).
 */
function isPendingChange(r: HumanRequestRow): boolean {
  const card = r.change_card as Record<string, unknown> | null;
  return (
    !!card &&
    typeof card === "object" &&
    typeof card.command === "string" &&
    (card.decision === "needs_yes" || card.decision === "needs_device")
  );
}

async function findRequest(p: RequestAnswerParams, ctx: CommandContext): Promise<HumanRequestRow> {
  const direct = await ctx.store.humanRequest.get(p.request);
  if (direct) return direct;
  const open = await ctx.store.humanRequest.open({}, { limit: 200 });
  const mine = open.filter(
    (r) => (r.human_id === null || r.human_id === ctx.humanId) && !isPendingChange(r),
  );
  const matches = mine.filter((r) => r.id.startsWith(p.request));
  if (matches.length === 1) return matches[0] as HumanRequestRow;
  if (matches.length > 1) {
    throw new ForerunnerError("validation", `several open requests start with ${p.request}`, {
      details: { candidates: matches.map((m) => m.id) },
    });
  }
  throw new ForerunnerError("not_found", `no open request ${p.request}`);
}

function sentenceOf(r: HumanRequestRow, answer: string): string {
  return `Answered ${quote(r.why, 60)} with ${quote(answer)}.`;
}

/** Normalised as the answer readers compare words: case, spaces, `_` and `-` do not matter. */
const word = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

/**
 * The one-line read-back of an answer said in chat or voice (design §3.9): the option as its
 * button says it, the card as the Inbox names it, and what the option does: "Approve and start
 * (Plan for "Bakery": 3 tasks)? Writes these 3 tasks and starts working on them now." An answer
 * that is no option (free text) reads 'Answer "<title>" with "<words>"?'.
 */
async function askOf(
  r: HumanRequestRow,
  answer: string,
  ctx: CommandContext,
  note: string | null = null,
): Promise<string> {
  const words = await ctx.ports.cardWords?.(r).catch(() => null);
  if (!words) return `Answer ${quote(r.why, 60)} with ${quote(answer)}?`;
  const option = words.choices.find((c) => word(c.label) === word(answer));
  if (!option) return `Answer ${quote(words.title, 80)} with ${quote(answer)}?`;
  const ask = `${option.label} (${words.title})?${option.explain ? ` ${option.explain}` : ""}`;
  // l4-chat-final (L4h-left-1): the person's own words are theirs and not read back to them; a
  // note the model made up is, so the yes covers it.
  return note && !notesPersons(ctx, note) ? `${ask} ${noteForBrief(note)}` : ask;
}

/** 'Note for its next brief: "…"', as a move's read-back shows a note the model passed. */
function noteForBrief(note: string): string {
  return `Note for its next brief: ${quote(note)}${/[.!?]$/.test(note) ? "" : "."}`;
}

/**
 * fixup-l4-selftasks-carried: the note an answer carries, when its option takes one (the card's
 * words say `input: "note"`); null otherwise, so an option that takes none keeps no note.
 */
async function noteOf(
  r: HumanRequestRow,
  p: RequestAnswerParams,
  ctx: CommandContext,
): Promise<string | null> {
  const note = p.note?.trim();
  if (!note) return null;
  const words = await ctx.ports.cardWords?.(r).catch(() => null);
  const option = words?.choices.find((c) => word(c.label) === word(p.answer));
  return option?.input === "note" ? note : null;
}

export const requestAnswer: CommandDef<RequestAnswerParams> = {
  name: "request.answer",
  description: "Answer an open human request with one of its options or free text.",
  params,
  risk: async (p, ctx) => (await findRequest(p, ctx)).risk,
  maxRisk: "high",
  scope: "project",
  reversible: false,
  undoStrategy: "an answer stands; a new request supersedes it",
  async plan(p, ctx) {
    const r = await findRequest(p, ctx);
    if (r.status !== "open") {
      throw new ForerunnerError("validation", `request ${r.id} is ${r.status}`, {
        details: { id: r.id },
      });
    }
    // U-034: a word the card cannot act on is refused here, before a confirmation is asked
    // for, with the card's options in the reason; the request stays open.
    ctx.ports.checkAnswer?.(r, p.answer);
    const project = r.project_id ? await ctx.store.project.get(r.project_id) : undefined;
    return buildCard({
      command: "request.answer",
      what: `the request ${quote(r.why, 60)}`,
      oldValue: "open",
      newValue: quote(p.answer),
      scope: r.project_id ? "project" : "global",
      risk: r.risk,
      sentence: sentenceOf(r, p.answer),
      reversible: false,
      projectId: r.project_id,
      projectName: project?.name ?? null,
      ask: await askOf(r, p.answer, ctx, await noteOf(r, p, ctx)),
    });
  },
  async run(p, ctx) {
    const r = await findRequest(p, ctx);
    if (r.status === "open") ctx.ports.checkAnswer?.(r, p.answer);
    // An option with a note is answered as the Inbox answers it (`{ choice, note }`), so the
    // card's handler queues the note for the task's next brief (`answerNote`).
    const note = await noteOf(r, p, ctx);
    await ctx.store.humanRequest.answer(
      r.id,
      r.version,
      note ? { choice: p.answer, note } : p.answer,
      ctx.humanId,
    );
    await ctx.ports.requestAnswered?.(r.id);
    // What came of it, as the card's Done line says it ("Plan approved: 3 tasks written;
    // working on them."), once the answer was applied; else the plain sentence.
    const after = await ctx.store.humanRequest.get(r.id);
    const done = after ? await ctx.ports.cardWords?.(after).catch(() => null) : null;
    const sentence = done?.outcome ?? sentenceOf(r, p.answer);
    return {
      before: { request_id: r.id, status: r.status, answer: r.answer },
      after: { request_id: r.id, status: "answered", answer: p.answer },
      sentence,
      projectId: r.project_id,
    };
  },
};
