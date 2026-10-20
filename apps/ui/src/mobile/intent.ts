import type { PlanCommand } from "../api/state-client.ts";
import { endOfTonight, localMidnight, nextLocalTime, startOfTomorrow } from "./time.ts";

/**
 * Understanding on the phone (spec Q.2, R.5): the spec phrases the phone turns into
 * module-Q commands before it shows one change card. The patterns mirror
 * `packages/commands/src/intent.ts` (English and German, times in the human's zone:
 * "tonight" and "tomorrow" end at 06:00) for the subset the phone drives: switch project, go
 * back, give / set a session or project budget, raise the monthly cap, start / stop / pause a
 * session, add a note. Anything else becomes one short question with options; the PC's
 * executor re-validates every command against the registry, so the phone never has the last
 * word (Q.12). Text marked as content (a page, a file, an email) is refused.
 */
export interface IntentProject {
  id: string;
  name: string;
}

export interface IntentContext {
  timezone: string;
  /** Milliseconds since the epoch. */
  now: number;
  activeProjectId: string | null;
  projects: IntentProject[];
  /** "content" marks text that came from a page, file or email: refused. */
  source?: "chat" | "voice" | "ui" | "content";
}

export interface IntentQuestion {
  text: string;
  options: string[];
}

export interface IntentResult {
  commands: PlanCommand[];
  question?: IntentQuestion;
  matched: "pattern" | "none";
  unmatched: string[];
}

export class IntentRefused extends Error {
  readonly code = "injection_suspected";
  constructor(message: string) {
    super(message);
    this.name = "IntentRefused";
  }
}

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?)`;
const CHF = String.raw`(?:swiss\s+francs?|francs?|franken|chf|fr\.?|stutz)`;
const USD = String.raw`(?:dollars?|usd|\$)`;
const CURRENCY = `(${CHF}|${USD})`;
const RUNNER_TAIL =
  /\s+(?:on|in|auf)\s+(?:my|the|meinem|dem|der)?\s*(pc|computer|desktop|laptop|rechner|cloud(?:\s+runner)?|cloud-runner)\s*$/i;
const QUESTION_RE =
  /\?\s*$|^\s*(?:what|why|how|when|where|who|which|wie|was|warum|wann|wo|wer|welche[rs]?)\b/i;
const SPLIT_RE = /\s*(?:[,;]|\b(?:and\s+then|and|und|then|dann)\b)\s*/i;
/** The runtime's data envelope markers; text carrying them is content, never a request. */
const ENVELOPE_RE = /<<<\s*(?:data|content)\b|\[\[\s*(?:data|content)\s*\]\]|<forerunner-data/i;

const UNSURE_OPTIONS = [
  "Switch project",
  "Set a budget",
  "Start a session",
  "Add a note",
  "Nothing",
];

interface When {
  until: string;
  label: string;
}

interface Match {
  command?: PlanCommand;
  question?: IntentQuestion;
  project?: string | null;
}

function amount(raw: string): number {
  return Number(raw.replace(",", "."));
}

function isUsd(currency: string): boolean {
  return new RegExp(`^${USD}$`, "i").test(currency);
}

function amountParams(raw: string, currency: string): Record<string, unknown> {
  const n = amount(raw);
  return isUsd(currency) ? { amountUsdMicro: Math.round(n * 1_000_000) } : { amountChf: n };
}

/** "tonight", "until tomorrow", "until 06:00", "bis 6 Uhr", "today": the end of a window. */
export function parseWhen(text: string, ctx: Pick<IntentContext, "now" | "timezone">): When | null {
  const t = text.trim();
  if (!t) return null;
  if (
    /\b(?:for\s+)?(?:tonight|over\s*night)\b|\bheute\s+(?:nacht|abend)\b|\büber\s+nacht\b/i.test(t)
  ) {
    return { until: new Date(endOfTonight(ctx.now, ctx.timezone)).toISOString(), label: "tonight" };
  }
  if (/\b(?:until|till|bis|for)\s+(?:tomorrow|morgen)\b/i.test(t)) {
    return {
      until: new Date(startOfTomorrow(ctx.now, ctx.timezone)).toISOString(),
      label: "tomorrow",
    };
  }
  const clock = /\b(?:until|till|bis|up\s+to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|uhr|h)?\b/i.exec(t);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? "0");
    const suffix = clock[3]?.toLowerCase();
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return {
      until: new Date(nextLocalTime(ctx.now, hour, minute, ctx.timezone)).toISOString(),
      label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  }
  if (/\b(?:for\s+)?today\b|\bheute\b/i.test(t)) {
    return {
      until: new Date(localMidnight(ctx.now, ctx.timezone, 1)).toISOString(),
      label: "today",
    };
  }
  return null;
}

/** Projects whose name or id matches `name` (id, exact name, then substring and word prefix). */
export function matchProjects(projects: IntentProject[], name: string): IntentProject[] {
  const needle = name
    .trim()
    .toLowerCase()
    .replace(/^(?:the|das|der|die|dem)\s+/, "");
  if (!needle) return [];
  const byId = projects.filter((p) => p.id.toLowerCase() === needle);
  if (byId.length) return byId;
  const exact = projects.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length) return exact;
  const words = needle.split(/\s+/);
  const contains = projects.filter((p) => {
    const n = p.name.toLowerCase();
    return n.includes(needle) || words.every((w) => n.split(/[\s-]+/).some((x) => x.startsWith(w)));
  });
  return contains;
}

function clean(clause: string): string {
  return clause
    .trim()
    .replace(/^(?:please|bitte|ok|okay|hey|also)\s+/i, "")
    .replace(/[.!]+$/g, "")
    .replace(/\s+(?:please|bitte)$/i, "")
    .trim();
}

const GUARD_OPEN = "\uE000";
const GUARD_CLOSE = "\uE001";
const GUARD_RE = /\uE000(\d+)\uE001/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Project names that contain a clause separator ("Rock and Roll", "Ship, then sell") would
 * be cut by the split: replace each, case-insensitively and whole, with a guard token first
 * and put the name back into every clause afterwards (longest names first, so a name that
 * contains another is kept whole).
 */
function splitClauses(text: string, projects: IntentProject[]): string[] {
  const guarded = projects
    .map((p) => p.name.trim())
    .filter((name) => name.length > 0 && SPLIT_RE.test(name))
    .sort((a, b) => b.length - a.length);
  let protectedText = text;
  guarded.forEach((name, i) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");
    protectedText = protectedText.replace(re, `${GUARD_OPEN}${i}${GUARD_CLOSE}`);
  });
  return protectedText
    .split(SPLIT_RE)
    .map((clause) => clean(clause.replace(GUARD_RE, (_m, i: string) => guarded[Number(i)] ?? "")))
    .filter(Boolean);
}

export function parseIntent(text: string, ctx: IntentContext): IntentResult {
  if (ctx.source === "content" || ENVELOPE_RE.test(text)) {
    throw new IntentRefused("text from a page, a file or an email is data, not a request");
  }
  const trimmed = text.trim();
  if (!trimmed) return { commands: [], matched: "none", unmatched: [] };

  const whole = matchNote(clean(trimmed));
  if (whole) return finish([whole], []);

  const clauses = splitClauses(trimmed, ctx.projects);
  const matches: Match[] = [];
  const unmatched: string[] = [];
  let project: string | null = ctx.activeProjectId;
  for (const clause of clauses) {
    const m = matchClause(clause, ctx, project);
    if (!m) {
      unmatched.push(clause);
      continue;
    }
    if (m.project !== undefined) project = m.project;
    matches.push(m);
    if (m.question) break;
  }
  if (unmatched.length === 0 && matches.length > 0) return finish(matches, []);
  if (QUESTION_RE.test(trimmed) && matches.length === 0) {
    return { commands: [], matched: "none", unmatched: clauses };
  }
  const first = unmatched[0] ?? trimmed;
  return {
    commands: [],
    question: {
      text: `I did not understand "${first.slice(0, 80)}". What should I do?`,
      options: UNSURE_OPTIONS,
    },
    matched: "none",
    unmatched,
  };
}

function finish(matches: Match[], unmatched: string[]): IntentResult {
  const question = matches.find((m) => m.question)?.question;
  if (question) return { commands: [], question, matched: "pattern", unmatched };
  const commands = matches.map((m) => m.command).filter((c): c is PlanCommand => !!c);
  return { commands, matched: "pattern", unmatched };
}

function matchClause(clause: string, ctx: IntentContext, project: string | null): Match | null {
  return (
    matchBack(clause) ??
    matchNote(clause) ??
    matchMonthlyCap(clause) ??
    matchScopedBudget(clause, ctx, project) ??
    matchGive(clause, ctx, project) ??
    matchStop(clause) ??
    matchPause(clause) ??
    matchStart(clause, ctx, project) ??
    matchSwitch(clause, ctx)
  );
}

function projectIdFor(
  name: string | undefined,
  ctx: IntentContext,
  current: string | null,
): string | null | IntentQuestion {
  if (name) {
    const matches = matchProjects(ctx.projects, name);
    if (matches.length === 1) return (matches[0] as IntentProject).id;
    return {
      text:
        matches.length > 1
          ? `"${name}" matches several projects. Which one?`
          : `No project named "${name}". Which one?`,
      options: (matches.length > 1 ? matches : ctx.projects).slice(0, 6).map((p) => p.name),
    };
  }
  if (current) return current;
  return { text: "Which project?", options: ctx.projects.slice(0, 6).map((p) => p.name) };
}

function switchTo(name: string, ctx: IntentContext): Match {
  const matches = matchProjects(ctx.projects, name);
  if (matches.length === 1) {
    const p = matches[0] as IntentProject;
    return { command: { name: "project.switch", params: { project: p.id } }, project: p.id };
  }
  const options = (matches.length > 1 ? matches : ctx.projects).slice(0, 6).map((p) => p.name);
  return {
    question: {
      text:
        matches.length > 1
          ? `Which project? "${name}" matches several.`
          : `No project named "${name}". Which project?`,
      options,
    },
  };
}

function matchBack(c: string): Match | null {
  if (
    /^(?:go\s+back|back|switch\s+back|zur[üu]ck|geh\s+zur[üu]ck|zur[üu]ck\s+wechseln)$/i.test(c)
  ) {
    return { command: { name: "project.switch", params: { back: true } } };
  }
  return null;
}

function matchSwitch(c: string, ctx: IntentContext): Match | null {
  const en =
    /^(?:switch|change|go)\s+(?:over\s+)?to\s+(?:the\s+)?(.+?)(?:\s+project)?(?:\s+now)?$/i.exec(
      c,
    ) ??
    /^(?:work\s+on|let'?s\s+work\s+on|focus\s+on|open|continue\s+(?:with|on))\s+(?:the\s+)?(.+?)(?:\s+project)?(?:\s+(?:now|next))?$/i.exec(
      c,
    );
  const de =
    /^(?:wechsle|wechsel|wechseln|geh|gehe)\s+(?:zu|zum|zur|auf)\s+(?:dem\s+|der\s+|das\s+)?(.+?)(?:\s+projekt)?$/i.exec(
      c,
    ) ??
    /^(?:arbeite|arbeiten\s+wir|weiter)\s+(?:jetzt\s+)?(?:an|mit|am)\s+(?:dem\s+|der\s+)?(.+?)(?:\s+(?:jetzt|weiter))?$/i.exec(
      c,
    ) ??
    /^zu\s+(?:dem\s+|der\s+)?(.+?)\s+wechseln$/i.exec(c);
  const m = en ?? de;
  if (!m?.[1]) return null;
  return switchTo(m[1], ctx);
}

function matchNote(c: string): Match | null {
  const m =
    /^(?:(note|idea|correction|notiz|idee|korrektur|merke?(?:\s+dir)?|remember)|note\s+that|merk\s+dir,?\s+dass)\s*[:,-]?\s+(.+)$/is.exec(
      c,
    );
  if (!m?.[2]) return null;
  const head = (m[1] ?? "note").toLowerCase();
  const kind = /^(?:idea|idee)$/.test(head)
    ? "idea"
    : /^(?:correction|korrektur)$/.test(head)
      ? "correction"
      : "note";
  return { command: { name: "note.add", params: { text: m[2].trim(), kind } } };
}

function matchMonthlyCap(c: string): Match | null {
  const m =
    new RegExp(
      String.raw`^(?:raise|increase|set|lower|reduce|change|put)\s+(?:the\s+|my\s+)?(?:monthly|month)\s+(?:hard\s+)?(?:cap|ceiling|limit|budget)\s+to\s+${AMOUNT}\s*${CURRENCY}?$`,
      "i",
    ).exec(c) ??
    new RegExp(
      String.raw`^(?:erh[öo]he?|setz(?:e)?|senke?|[äa]ndere?)\s+(?:das|die|den|mein|meine|meinen)?\s*(?:monats(?:limit|budget|deckel|obergrenze)|monatliche[sn]?\s+(?:limit|budget|obergrenze|deckel))\s+auf\s+${AMOUNT}\s*${CURRENCY}?$`,
      "i",
    ).exec(c);
  if (!m?.[1]) return null;
  return {
    command: {
      name: "budget.set",
      params: { scope: "month", ...amountParams(m[1], m[2] ?? "chf") },
    },
  };
}

function matchScopedBudget(c: string, ctx: IntentContext, current: string | null): Match | null {
  const m = new RegExp(
    String.raw`^(?:set|raise|increase|lower|reduce|change)\s+(?:the\s+)?(session|project)\s+(?:budget|cap|limit)\s+(?:(?:for|of|on)\s+(.+?)\s+)?to\s+${AMOUNT}\s*${CURRENCY}?(.*)$`,
    "i",
  ).exec(c);
  if (!m) return null;
  const scope = (m[1] as string).toLowerCase();
  const pid = projectIdFor(m[2], ctx, current);
  if (typeof pid !== "string" && pid !== null) return { question: pid };
  const when = parseWhen(m[5] ?? "", ctx);
  if (scope === "project" && when) return null;
  const params: Record<string, unknown> = { scope, ...amountParams(m[3] as string, m[4] ?? "chf") };
  if (pid) params.project = pid;
  if (when) params.until = when.until;
  return { command: { name: "budget.set", params } };
}

/** "give it 15 francs until tomorrow", "gib ihm 20 Franken heute Nacht", "give the game 10 francs". */
function matchGive(c: string, ctx: IntentContext, current: string | null): Match | null {
  const m = new RegExp(
    String.raw`^(?:give|allow|grant|gib|gebe|erlaube)\s+(?:(it|him|her|them|ihm|ihr|ihnen)|(?:the\s+|dem\s+|der\s+)?(.+?))\s+${AMOUNT}\s*${CURRENCY}\b(.*)$`,
    "i",
  ).exec(c);
  if (!m) return null;
  const pid = projectIdFor(m[1] ? undefined : m[2], ctx, current);
  if (typeof pid !== "string" && pid !== null) return { question: pid };
  const when = parseWhen(m[5] ?? "", ctx);
  const params: Record<string, unknown> = {
    scope: "session",
    ...amountParams(m[3] as string, m[4] as string),
  };
  if (pid) params.project = pid;
  if (when) params.until = when.until;
  return { command: { name: "budget.set", params } };
}

function matchStop(c: string): Match | null {
  if (
    /^(?:stop|halt|kill|stopp|stoppe|stoppen|beende|anhalten)\s+(?:everything|all(?:\s+(?:sessions|work))?|every\s+session|alles|alle\s+sessions?|alle\s+sitzungen)$/i.test(
      c,
    ) ||
    /^(?:alles|alle\s+sessions?|alle\s+sitzungen)\s+(?:stoppen|anhalten|beenden)$/i.test(c)
  ) {
    return { command: { name: "session.stop", params: { scope: "all" } } };
  }
  if (
    /^(?:stop|halt|kill|stopp|stoppe|beende)(?:\s+(?:the\s+|die\s+)?(?:session|sitzung|work|arbeit))?$/i.test(
      c,
    ) ||
    /^(?:session|sitzung)\s+(?:stoppen|beenden)$/i.test(c)
  ) {
    return { command: { name: "session.stop", params: { scope: "agent" } } };
  }
  return null;
}

function matchPause(c: string): Match | null {
  if (
    /^(?:pause|pausiere|pausieren)(?:\s+(?:the\s+|die\s+)?(?:session|sitzung|work|arbeit))?$/i.test(
      c,
    ) ||
    /^(?:session|sitzung)\s+pausieren$/i.test(c)
  ) {
    return { command: { name: "session.pause", params: {} } };
  }
  return null;
}

function matchStart(c: string, ctx: IntentContext, current: string | null): Match | null {
  let rest = c;
  let runner: "pc" | "cloud" | undefined;
  const tail = RUNNER_TAIL.exec(rest);
  if (tail) {
    runner = /cloud/i.test(tail[1] as string) ? "cloud" : "pc";
    rest = rest.slice(0, tail.index).trim();
  }
  let budgetChf: number | undefined;
  const withBudget = new RegExp(String.raw`\s+(?:with|mit)\s+${AMOUNT}\s*${CHF}\s*$`, "i").exec(
    rest,
  );
  if (withBudget) {
    budgetChf = amount(withBudget[1] as string);
    rest = rest.slice(0, withBudget.index).trim();
  }
  const m =
    /^(?:start|begin|launch|run|kick\s+off)\s+(?:a\s+|the\s+|another\s+)?(?:work\s+)?(?:session|sitzung)(?:\s+(?:on|for)\s+(?:the\s+)?(.+?))?$/i.exec(
      rest,
    ) ??
    /^(?:start|begin)\s+working(?:\s+on\s+(?:the\s+)?(.+?))?$/i.exec(rest) ??
    /^(?:starte|start)\s+(?:eine\s+|die\s+)?(?:session|sitzung)(?:\s+(?:f[üu]r|an|zu)\s+(?:dem\s+|der\s+)?(.+?))?$/i.exec(
      rest,
    ) ??
    /^(?:session|sitzung)\s+starten$/i.exec(rest);
  if (!m) return null;
  const pid = projectIdFor(m[1], ctx, current);
  if (typeof pid !== "string" && pid !== null) return { question: pid };
  const params: Record<string, unknown> = {};
  if (pid) params.project = pid;
  if (runner) params.runner = runner;
  if (budgetChf !== undefined) params.budgetChf = budgetChf;
  return { command: { name: "session.start", params } };
}
