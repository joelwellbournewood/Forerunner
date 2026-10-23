import type { JsonObject, ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandDef, SpeakPortResult } from "../types.ts";
import { resolveProject } from "./shared.ts";

/**
 * summary.speak (spec A.6 "readable aloud", L.6 "TTS for summaries"): read a project's cached
 * one-screen summary aloud. The text is built here from the project row (one source for the
 * daemon's `GET /projects/:id/summary` and for the spoken form), the voice is the runtime's
 * `speak` port over the voice provider registry. In a voice session the sentence *is* the
 * summary, so the loop that answers the human speaks it; by chat or from the UI the port
 * speaks it through the desktop's audio path and the sentence echoes the text so the screen
 * shows what is being read. Without a usable voice provider the text is the reply, so "read
 * me the summary" always answers. Low risk, no confirmation, nothing to undo.
 */

/** The fields of a project row the spoken summary reads. */
export type SpokenSummaryProject = Pick<ProjectRow, "name" | "goal" | "stage" | "summary_cache">;

interface SummaryCache {
  last_session?: { summary?: string };
  next_steps?: string[];
  open_questions?: number;
}

/** Plain text for TTS: name, goal, stage, last session, the next three steps, questions, spend. */
export function spokenProjectSummary(
  p: SpokenSummaryProject,
  spendUsdMicro: number,
  chfPerUsd: number,
): string {
  const s = (p.summary_cache ?? {}) as SummaryCache;
  const next = Array.isArray(s.next_steps) ? s.next_steps.filter((x) => typeof x === "string") : [];
  const open = typeof s.open_questions === "number" ? s.open_questions : 0;
  const last = s.last_session?.summary;
  return [
    `${p.name}.`,
    `Goal: ${p.goal}.`,
    `Stage: ${p.stage}.`,
    last ? `Last session: ${last}` : "No session yet.",
    next.length ? `Next: ${next.slice(0, 3).join("; ")}.` : "",
    `${open} open question${open === 1 ? "" : "s"}.`,
    `Spent ${(Math.round(spendUsdMicro * chfPerUsd) / 1e6).toFixed(2)} francs.`,
  ]
    .filter(Boolean)
    .join(" ");
}

const params = z.object({ project: z.string().optional() });
export type SummarySpeakParams = z.infer<typeof params>;

async function textOf(ctx: Parameters<CommandDef<SummarySpeakParams>["run"]>[1], p: ProjectRow) {
  const spend = await ctx.store.costLedger.sum({ projectId: p.id });
  const chf = await ctx.ports.chfPerUsd(ctx.clock.nowIso());
  return spokenProjectSummary(p, spend.usd_micro, chf);
}

export const summarySpeak: CommandDef<SummarySpeakParams> = {
  name: "summary.speak",
  description:
    "Read a project's one-screen summary aloud through the voice provider; the text is the reply when voice is unavailable.",
  params,
  risk: "low",
  scope: "project",
  reversible: false,
  undoStrategy: "nothing to undo; stop the playback in the app",
  async plan(p, ctx) {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    return buildCard({
      command: "summary.speak",
      what: `the summary of ${project.name}`,
      oldValue: "",
      newValue: "read aloud",
      scope: "project",
      risk: "low",
      sentence: `Reading the summary of ${project.name} aloud.`,
      reversible: false,
      projectId: project.id,
      projectName: project.name,
      usesActiveProject: usedActive,
    });
  },
  async run(p, ctx) {
    const { project } = await resolveProject(ctx, p.project);
    const text = await textOf(ctx, project);
    // A voice session speaks its reply itself: the text is the sentence, nothing else plays.
    let result: SpeakPortResult | null = null;
    if (ctx.source !== "voice" && ctx.ports.speak) {
      result = await ctx.ports.speak({
        text,
        projectId: project.id,
        projectName: project.name,
        humanId: ctx.humanId,
        source: ctx.source,
      });
    }
    const sentence =
      ctx.source === "voice"
        ? text
        : result?.spoken
          ? `Reading the summary of ${project.name} aloud. ${text}`
          : `Voice is unavailable${result && !result.spoken && result.reason ? ` (${result.reason})` : ""}. Summary of ${project.name}: ${text}`;
    const after: JsonObject = {
      project_id: project.id,
      spoken: ctx.source === "voice" || result?.spoken === true,
      via: ctx.source === "voice" ? "voice_session" : result?.spoken ? "speaker" : "text",
      speak_id: result?.spoken ? result.id : null,
      chars: text.length,
    };
    return {
      before: { project_id: project.id },
      after,
      sentence,
      projectId: project.id,
    };
  },
};
