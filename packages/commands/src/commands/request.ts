import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { quote } from "./shared.ts";

/**
 * request.answer (spec J human requests): answer an open request by id or id prefix. The
 * risk is the request's own risk, so a high-risk approval still needs a paired device.
 */
const params = z.object({
  /** Request id or a prefix of at least four characters. */
  request: z.string().min(4),
  answer: z.string().min(1),
});
export type RequestAnswerParams = z.infer<typeof params>;

async function findRequest(p: RequestAnswerParams, ctx: CommandContext): Promise<HumanRequestRow> {
  const direct = await ctx.store.humanRequest.get(p.request);
  if (direct) return direct;
  const open = await ctx.store.humanRequest.open({}, { limit: 200 });
  const mine = open.filter((r) => r.human_id === null || r.human_id === ctx.humanId);
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
    });
  },
  async run(p, ctx) {
    const r = await findRequest(p, ctx);
    await ctx.store.humanRequest.answer(r.id, r.version, p.answer, ctx.humanId);
    return {
      before: { request_id: r.id, status: r.status, answer: r.answer },
      after: { request_id: r.id, status: "answered", answer: p.answer },
      sentence: sentenceOf(r, p.answer),
      projectId: r.project_id,
    };
  },
};
