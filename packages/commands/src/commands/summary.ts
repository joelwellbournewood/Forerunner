import { ForerunnerError } from "@forerunner/platform";
import type { JsonObject, ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import { ownsProject } from "../ownership.ts";
import type { CommandContext, CommandDef, SpeakPortResult } from "../types.ts";
import { type ResolvedProject, resolveProject } from "./shared.ts";

/**
 * summary.speak (spec A.6 "readable aloud", L.6 "TTS for summaries"): read a project's cached
 * one-screen summary aloud. The text is built here from the project row (one source for the
 * daemon's `GET /projects/:id/summary` and for the spoken form), the voice is the runtime's
 * `speak` port over the voice provider registry. In a voice session the sentence *is* the
 * summary, so the loop that answers the human speaks it; by chat or from the UI the port
 * speaks it through the desktop's audio path and the sentence echoes the text so the screen
 * shows what is being read. Without a usable voice provider the text is the reply, so "read
 * me the summary" always answers. Low risk, no confirmation, nothing to undo. Another human's
 * project on a shared state is refused as the daemon's speak route refuses it (`ownsProject`).
 */

/**
 * The summary quotes records (d1109-chat-guard, ADR 0114): the last session's result, which
 * quotes a run's report ("It reported: ..."), and the next tasks' titles. The chat model gets
 * the answer inside the data envelope, scanned, and the rest of its turn reads changes back.
 */
const SUMMARY_IS_A_RECORD = { source: "agent_output", origin: "record:summary" } as const;

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

/**
 * The summary as the chat writes it (design §3.9, §5): how far the project is, the last
 * session's result as the engine wrote it (at most three lines: what needs you, what happened,
 * what is next and its one spend figure), and what runs next. Before, a typed "summary" tried
 * to speak, printed the voice provider's install error with Python module and secret names,
 * then the spoken text, whose project total and the session's spend disagreed.
 */
export async function chatProjectSummary(
  ctx: Pick<CommandContext, "store">,
  p: ProjectRow,
): Promise<string> {
  const tasks = (await ctx.store.task.forProject(p.id, {}, { limit: 10_000 })).filter(
    (t) => t.status !== "cancelled",
  );
  const done = tasks.filter((t) => t.status === "done").length;
  const s = (p.summary_cache ?? {}) as SummaryCache;
  const last = s.last_session?.summary?.replace(/\s*\n\s*/g, " ").trim();
  const next = Array.isArray(s.next_steps)
    ? s.next_steps.filter((x): x is string => typeof x === "string")
    : [];
  const quoted = next.slice(0, 3).map((t) => `"${t}"`);
  const more = next.length > 3 ? ` and ${next.length - 3} more` : "";
  return [
    tasks.length
      ? `${p.name}: ${done === tasks.length ? `done, all ${tasks.length} tasks` : `${done} of ${tasks.length} tasks done`}.`
      : `${p.name}: no tasks yet.`,
    last ? `Last session: ${last}` : "No session yet.",
    quoted.length && done < tasks.length
      ? `Next: ${quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0]}${more}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Whether the person asked to hear it: a button in the app, or "read", "speak", "aloud". */
function wantsAloud(ctx: CommandContext): boolean {
  if (ctx.source === "ui") return true;
  return /\b(?:read|speak|say|aloud|out\s+loud|vorlesen|vor|lies|sprich)\b/i.test(ctx.wordsUsed);
}

/** Why it was not read aloud, in plain words (never the provider's module or secret names). */
function notAloudWords(reason: string | undefined): string {
  if (reason && /no app window/i.test(reason)) return "no app window is open to play it";
  return "voice is not set up (Settings → Voice)";
}

async function textOf(ctx: Parameters<CommandDef<SummarySpeakParams>["run"]>[1], p: ProjectRow) {
  const spend = await ctx.store.costLedger.sum({ projectId: p.id });
  const chf = await ctx.ports.chfPerUsd(ctx.clock.nowIso());
  return spokenProjectSummary(p, spend.usd_micro, chf);
}

/** The named or active project, refused when it belongs to another human (ADR 0041 item 4). */
async function ownProject(
  ctx: CommandContext,
  named: string | undefined,
): Promise<ResolvedProject> {
  const resolved = await resolveProject(ctx, named);
  if (!ownsProject(resolved.project, { humanId: ctx.humanId, agentId: ctx.agentId })) {
    throw new ForerunnerError("not_found", `the project "${resolved.project.name}" is not yours`, {
      details: { projectId: resolved.project.id, cause: "not_your_project" },
    });
  }
  return resolved;
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
    const { project, usedActive } = await ownProject(ctx, p.project);
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
    const { project } = await ownProject(ctx, p.project);
    const text = await textOf(ctx, project);
    // Typed "summary" or "summarise the last session" (design §3.9): the summary in text,
    // and no attempt to speak it.
    if (ctx.source !== "voice" && !wantsAloud(ctx)) {
      return {
        before: { project_id: project.id },
        after: { project_id: project.id, spoken: false, via: "text", speak_id: null },
        sentence: await chatProjectSummary(ctx, project),
        projectId: project.id,
        untrusted: SUMMARY_IS_A_RECORD,
      };
    }
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
          : `I cannot read it aloud: ${notAloudWords(result && !result.spoken ? result.reason : undefined)}. Here it is:\n${await chatProjectSummary(ctx, project)}`;
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
      untrusted: SUMMARY_IS_A_RECORD,
    };
  },
};
