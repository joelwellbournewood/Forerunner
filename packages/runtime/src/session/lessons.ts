import { type ContentSource, type InjectionMatch, scanForInjection } from "../injection/scan.ts";
import type { LessonCandidate } from "../loop/ports.ts";

/**
 * The injection gate in front of memory (AGENTS.md: content from other agents is data; what
 * looks like an instruction is quoted to the human). A lesson candidate comes from a
 * specialist's final report, from the critic's repeat-finding proposals or from a human
 * decision; the first two were produced by a model that read web pages, emails and repo files,
 * so a planted "Lesson: ..." line would become a standing note in the principal's memory for
 * every later session. Every candidate runs through the general scanner plus rules for the
 * shapes a lesson never needs (a shell pipe to run, an order to skip a guard, an operator's
 * note, a standing order for every task); a match is dropped, reported with its rules and
 * quoted to the human. Nothing here loosens the general scanner: its own verdict rejects too.
 */
export interface RejectedLesson {
  text: string;
  /** The rules that matched (general scanner and lesson rules). */
  rules: string[];
  score: number;
  source: ContentSource;
  error: string;
}

export interface ScreenedLessons {
  kept: LessonCandidate[];
  rejected: RejectedLesson[];
}

interface LessonRule {
  name: string;
  re: RegExp;
  weight: number;
}

/** Shapes an observation never needs but an instruction to the agent does. */
const LESSON_RULES: LessonRule[] = [
  {
    name: "shell_pipe",
    re: /\b(curl|wget|iwr|invoke-webrequest|fetch)\b[^\n]{0,160}\|\s*(sh|bash|zsh|dash|pwsh|powershell|python3?|node|perl|ruby)\b/i,
    weight: 5,
  },
  {
    name: "skip_guard",
    re: /\b(skip|bypass|disable|ignore|turn off|remove|avoid|circumvent|suppress)\b[^.\n]{0,40}\b(hooks?|budgets?|limits?|caps?|checks?|guards?|critic|reviews?|approvals?|confirmations?|sandbox|kill[- ]?switch|allowlists?|enforcement|scan(?:ner|ning)?|audit)\b/i,
    weight: 3,
  },
  {
    name: "operator_note",
    re: /\b(system|operator|admin(?:istrator)?|developer|maintainer|vendor|anthropic|forerunner team)\b[^.\n]{0,24}\b(note|notice|message|instruction|directive|override|order|update)s?\b/i,
    weight: 3,
  },
  {
    name: "standing_order",
    re: /\b(before|after|on|at|during|for)\s+(every|each|all|any)\b[^.\n]{0,40}\b(tasks?|sessions?|runs?|requests?|calls?|turns?|starts?|commits?|reviews?)\b[^.\n]{0,40}\b(run|execute|call|send|post|fetch|curl|wget|download|open|visit|install|delete|remove|write|upload|email|report)\b/i,
    weight: 3,
  },
  {
    name: "agent_address",
    re: /\b(you (must|should|have to|need to|are to)|your (next|first) (task|step|action)( is)?)\b[^.\n]{0,60}\b(run|execute|send|post|fetch|download|install|delete|upload|email|ignore|skip|disable|visit|open)\b/i,
    weight: 2,
  },
  {
    name: "url_exec",
    re: /https?:\/\/[^\s"'`)]+[^\n]{0,40}\b(and|then)\b[^.\n]{0,20}\b(run|execute|follow|apply|paste|obey)\b/i,
    weight: 3,
  },
];

/** A lesson is dropped at this combined score, or when the general scanner alone says so. */
export const LESSON_REJECT_SCORE = 4;

export interface LessonScreenReport {
  rejected: boolean;
  score: number;
  rules: string[];
  matches: InjectionMatch[];
}

/** One candidate through the general scanner and the lesson rules. */
export function screenLessonText(
  text: string,
  source: ContentSource = "agent_output",
): LessonScreenReport {
  const general = scanForInjection(text, source);
  const matches: InjectionMatch[] = [...general.matches];
  let score = general.score;
  for (const rule of LESSON_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    score += rule.weight;
    const start = Math.max(0, m.index - 40);
    matches.push({
      rule: `lesson:${rule.name}`,
      excerpt: text
        .slice(start, Math.min(text.length, m.index + m[0].length + 40))
        .replace(/\s+/g, " "),
      weight: rule.weight,
    });
  }
  const rules = [...new Set(matches.map((m) => m.rule))];
  return {
    rejected: general.suspicious || score >= LESSON_REJECT_SCORE,
    score,
    rules,
    matches,
  };
}

/**
 * Split candidates into the ones memory may store and the ones that read as instructions.
 * The rejected entries carry the rules and a one-line error for `memory.recorded`.
 */
export function screenLessons(
  candidates: readonly LessonCandidate[],
  source: ContentSource = "agent_output",
): ScreenedLessons {
  const kept: LessonCandidate[] = [];
  const rejected: RejectedLesson[] = [];
  for (const c of candidates) {
    const report = screenLessonText(c.text, source);
    if (!report.rejected) {
      kept.push(c);
      continue;
    }
    rejected.push({
      text: c.text,
      rules: report.rules,
      score: report.score,
      source,
      error: `instruction-like content ignored (${report.rules.join(", ")})`,
    });
  }
  return { kept, rejected };
}

/** The human-facing quote of rejected lessons (the inbox warning and the session log). */
export function describeRejectedLessons(
  rejected: readonly RejectedLesson[],
  origin?: string,
): string {
  const where = origin ? ` from ${origin}` : "";
  const lines = rejected.map((r) => `- "${cut(r.text, 300)}" (${r.rules.join(", ")})`);
  return `${rejected.length} proposed lesson(s)${where} read like instructions and were not stored in memory. They were ignored:\n${lines.join("\n")}`;
}

function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
