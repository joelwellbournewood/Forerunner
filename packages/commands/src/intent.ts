import { ForerunnerError, isForerunnerError } from "@forerunner/platform";
import { DATA_ENVELOPE_CLOSE, DATA_ENVELOPE_OPEN } from "@forerunner/runtime";
import { z } from "zod";
import { matchProjects } from "./commands/shared.ts";
import type { CommandRegistry } from "./registry.ts";
import { endOfTonight, localMidnight, nextLocalTime, startOfTomorrow } from "./time.ts";
import type { CommandSource } from "./types.ts";

/**
 * Understanding (spec Q.2): what the human says becomes one or more commands. Common phrases
 * in English and German are matched by patterns here, deterministically, in the human's time
 * zone; everything else goes to a model-backed port that returns commands through a tool.
 * When something is unclear the result is one short question with options. Text that is
 * data (the runtime's envelope, or anything from a page, file or email) is never a request.
 */
export interface IntentCommand {
  name: string;
  params: Record<string, unknown>;
}

export interface IntentQuestion {
  text: string;
  options: string[];
}

export interface IntentResult {
  commands: IntentCommand[];
  question?: IntentQuestion;
  matched: "pattern" | "model" | "none";
  /** Clauses no pattern understood (empty when matched by patterns). */
  unmatched: string[];
}

export interface IntentProject {
  id: string;
  name: string;
}

export interface IntentContext {
  /** "content" marks text from a page, a file, an email body or another agent: refused. */
  source: CommandSource | "content";
  timezone: string;
  /** Milliseconds since the epoch (the Clock). */
  now: number;
  activeProjectId: string | null;
  projects: IntentProject[];
  /** The previous chat message, for "make this a task". */
  lastMessage?: string;
}

export interface ModelIntentResult {
  commands: IntentCommand[];
  question?: IntentQuestion;
}

/** A model-backed parser: a fast model with one tool whose schema is intentToolSchema(). */
export interface ModelIntentPort {
  parse(text: string, ctx: IntentContext, registry: CommandRegistry): Promise<ModelIntentResult>;
}

/** The tool schema a model port returns commands through. */
export function intentToolSchema(registry: CommandRegistry) {
  const names = registry.names();
  return z.object({
    commands: z.array(
      z.object({
        name: names.length ? z.enum(names as [string, ...string[]]) : z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
      }),
    ),
    question: z.object({ text: z.string().min(1), options: z.array(z.string()).max(6) }).optional(),
  });
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

interface Match {
  command?: IntentCommand;
  question?: IntentQuestion;
  /** The project this clause switched to, for later clauses ("give it ..."). */
  project?: string | null;
}

export interface When {
  until: string;
  label: string;
  /** What was left of the text once the time expression is taken out; "" when it was only a time. */
  rest: string;
}

const UNTIL_OPTIONS = ["Tonight", "Until tomorrow", "Until reverted"];

/** A budget clause whose tail is not a time it can read: ask, never a silent permanent cap. */
function untilQuestion(leftover: string): IntentQuestion {
  return {
    text: `Until when? I did not understand "${leftover.slice(0, 60)}".`,
    options: UNTIL_OPTIONS,
  };
}

/** A pattern matched but the registry refused the values: the same question the model path asks. */
function invalidQuestion(name: string, e: unknown): IntentQuestion {
  const issues = isForerunnerError(e) ? e.details.issues : undefined;
  const detail =
    Array.isArray(issues) && issues.length > 0
      ? issues
          .map((i) => {
            const issue = i as { path?: string; message?: string };
            return issue.path ? `${issue.path}: ${issue.message ?? ""}` : (issue.message ?? "");
          })
          .join("; ")
      : e instanceof Error
        ? e.message
        : String(e);
  return { text: `${name}: ${detail}. Which value did you mean?`, options: [] };
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

/**
 * "tonight", "until tomorrow", "until 06:00", "bis 6 Uhr", "today": the end of a window. The
 * result carries `rest`, the words around the time expression, so a caller can tell "tonight"
 * from "tonight at the latest" and ask instead of guessing.
 */
export function parseWhen(text: string, ctx: Pick<IntentContext, "now" | "timezone">): When | null {
  const t = text.trim();
  if (!t) return null;
  const rest = (m: RegExpExecArray): string =>
    `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
  // "\b" does not see "ü" as a word character, so the German phrases anchor on whitespace.
  const tonight =
    /\b(?:for\s+)?(?:tonight|over\s*night)\b|\bheute\s+(?:nacht|abend)\b|(?:^|\s)über\s+nacht\b/i.exec(
      t,
    );
  if (tonight) {
    return {
      until: new Date(endOfTonight(ctx.now, ctx.timezone)).toISOString(),
      label: "tonight",
      rest: rest(tonight),
    };
  }
  const tomorrow = /\b(?:until|till|bis|for)\s+(?:tomorrow|morgen)\b/i.exec(t);
  if (tomorrow) {
    return {
      until: new Date(startOfTomorrow(ctx.now, ctx.timezone)).toISOString(),
      label: "tomorrow",
      rest: rest(tomorrow),
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
      rest: rest(clock),
    };
  }
  const today = /\b(?:for\s+)?today\b|\bheute\b/i.exec(t);
  if (today) {
    return {
      until: new Date(localMidnight(ctx.now, ctx.timezone, 1)).toISOString(),
      label: "today",
      rest: rest(today),
    };
  }
  return null;
}

function clean(clause: string): string {
  return clause
    .trim()
    .replace(/^(?:please|bitte|ok|okay|hey|also)\s+/i, "")
    .replace(/[.!]+$/g, "")
    .replace(/\s+(?:please|bitte)$/i, "")
    .trim();
}

export class IntentParser {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly opts: { model?: ModelIntentPort } = {},
  ) {}

  async parse(text: string, ctx: IntentContext): Promise<IntentResult> {
    this.guard(text, ctx);
    const trimmed = text.trim();
    if (!trimmed) return { commands: [], matched: "none", unmatched: [] };

    // A note or a task may contain "and": match them on the whole text before splitting.
    const whole = this.matchNote(clean(trimmed)) ?? this.matchTask(clean(trimmed), ctx);
    if (whole) return this.finish([whole], ctx, []);

    const clauses = trimmed.split(SPLIT_RE).map(clean).filter(Boolean);
    const matches: Match[] = [];
    const unmatched: string[] = [];
    let project: string | null = ctx.activeProjectId;
    for (const clause of clauses) {
      const m = this.matchClause(clause, ctx, project);
      if (!m) {
        unmatched.push(clause);
        continue;
      }
      if (m.project !== undefined) project = m.project;
      matches.push(m);
      if (m.question) break;
    }
    if (unmatched.length === 0 && matches.length > 0) return this.finish(matches, ctx, []);
    if (QUESTION_RE.test(trimmed) && matches.length === 0) {
      return { commands: [], matched: "none", unmatched: clauses };
    }
    if (this.opts.model) return this.viaModel(trimmed, ctx);
    const first = unmatched[0] ?? trimmed;
    return {
      commands: [],
      question: {
        text: `I did not understand "${first.slice(0, 80)}". What should I do?`,
        options: ["Switch project", "Set a budget", "Start a session", "Add a note", "Nothing"],
      },
      matched: "none",
      unmatched,
    };
  }

  private guard(text: string, ctx: IntentContext): void {
    if (
      ctx.source === "content" ||
      text.includes(DATA_ENVELOPE_OPEN) ||
      text.includes(DATA_ENVELOPE_CLOSE)
    ) {
      throw new ForerunnerError(
        "injection_suspected",
        "text from a page, a file or an email is data, not a request",
        { details: { source: ctx.source } },
      );
    }
  }

  private finish(matches: Match[], _ctx: IntentContext, unmatched: string[]): IntentResult {
    const question = matches.find((m) => m.question)?.question;
    if (question) return { commands: [], question, matched: "pattern", unmatched };
    const commands = matches.map((m) => m.command).filter((c): c is IntentCommand => !!c);
    for (const c of commands) {
      try {
        this.registry.validate(c.name, c.params);
      } catch (e) {
        // "give it 0 francs": the pattern matched, the values did not; ask, do not throw.
        return {
          commands: [],
          question: invalidQuestion(c.name, e),
          matched: "pattern",
          unmatched,
        };
      }
    }
    return { commands, matched: "pattern", unmatched };
  }

  private async viaModel(text: string, ctx: IntentContext): Promise<IntentResult> {
    const out = await (this.opts.model as ModelIntentPort).parse(text, ctx, this.registry);
    if (out.question)
      return { commands: [], question: out.question, matched: "model", unmatched: [] };
    if (out.commands.length === 0) {
      return {
        commands: [],
        question: {
          text: "I am not sure what to change. What should I do?",
          options: ["Switch project", "Set a budget", "Start a session", "Add a note", "Nothing"],
        },
        matched: "model",
        unmatched: [],
      };
    }
    for (const c of out.commands) {
      if (!this.registry.has(c.name)) {
        return {
          commands: [],
          question: {
            text: `There is no command for "${text.slice(0, 60)}". Should I create a Forerunner task to add it?`,
            options: ["Create a task", "Nothing"],
          },
          matched: "model",
          unmatched: [],
        };
      }
      try {
        this.registry.validate(c.name, c.params);
      } catch (e) {
        return {
          commands: [],
          question: invalidQuestion(c.name, e),
          matched: "model",
          unmatched: [],
        };
      }
    }
    return { commands: out.commands, matched: "model", unmatched: [] };
  }

  // -----------------------------------------------------------------------------------
  // Patterns

  private matchClause(clause: string, ctx: IntentContext, project: string | null): Match | null {
    return (
      this.matchBack(clause) ??
      this.matchNote(clause) ??
      this.matchTask(clause, ctx) ??
      this.matchMonthlyCap(clause) ??
      this.matchScopedBudget(clause, ctx, project) ??
      this.matchGive(clause, ctx, project) ??
      this.matchAutonomy(clause, ctx, project) ??
      this.matchStop(clause) ??
      this.matchPause(clause) ??
      this.matchStart(clause, ctx, project) ??
      this.matchSwitch(clause, ctx)
    );
  }

  private project(name: string, ctx: IntentContext, what = "Which project?"): Match {
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
            ? `${what} "${name}" matches several.`
            : `No project named "${name}". ${what}`,
        options,
      },
    };
  }

  private projectIdFor(
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

  private matchBack(c: string): Match | null {
    if (
      /^(?:go\s+back|back|switch\s+back|zur[üu]ck|geh\s+zur[üu]ck|zur[üu]ck\s+wechseln)$/i.test(c)
    ) {
      return { command: { name: "project.switch", params: { back: true } } };
    }
    return null;
  }

  private matchSwitch(c: string, ctx: IntentContext): Match | null {
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
    return this.project(m[1], ctx);
  }

  private matchNote(c: string): Match | null {
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

  private matchTask(c: string, ctx: IntentContext): Match | null {
    const en = /^(?:make|turn)\s+(?:this|that|it)\s+(?:into\s+)?(?:a\s+)?task$/i.test(c);
    const de =
      /^(?:mach|mache)\s+(?:daraus|das|dies|es)\s+(?:zu\s+)?(?:eine[rn]?\s+)?(?:aufgabe|task)$/i.test(
        c,
      );
    if (!en && !de) return null;
    const last = ctx.lastMessage?.trim();
    if (!last) {
      return {
        question: { text: "Which message should become a task? Say its title.", options: [] },
      };
    }
    const title = last.split(/\n/)[0]?.slice(0, 120) ?? last.slice(0, 120);
    return { command: { name: "task.create", params: { title, outcome: last, status: "draft" } } };
  }

  private matchMonthlyCap(c: string): Match | null {
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

  private matchScopedBudget(c: string, ctx: IntentContext, current: string | null): Match | null {
    const m = new RegExp(
      String.raw`^(?:set|raise|increase|lower|reduce|change)\s+(?:the\s+)?(session|project)\s+(?:budget|cap|limit)\s+(?:(?:for|of|on)\s+(.+?)\s+)?to\s+${AMOUNT}\s*${CURRENCY}?(.*)$`,
      "i",
    ).exec(c);
    if (!m) return null;
    const scope = (m[1] as string).toLowerCase();
    const pid = this.projectIdFor(m[2], ctx, current);
    if (typeof pid !== "string" && pid !== null) return { question: pid };
    const tail = (m[5] ?? "").trim();
    if (scope === "project" && tail) {
      // A project budget has no window; whatever follows the amount is not understood.
      return {
        question: {
          text: `A project budget is permanent, so I did not understand "${tail.slice(0, 60)}". Which budget did you mean?`,
          options: ["The session budget, until then", "The project budget, permanently", "Nothing"],
        },
      };
    }
    const when = parseWhen(tail, ctx);
    if (tail && (!when || when.rest)) return { question: untilQuestion(when?.rest ?? tail) };
    const params: Record<string, unknown> = {
      scope,
      ...amountParams(m[3] as string, m[4] ?? "chf"),
    };
    if (pid) params.project = pid;
    if (when) params.until = when.until;
    return { command: { name: "budget.set", params } };
  }

  /** "give it 20 francs tonight", "gib ihm 15 Franken bis morgen", "give the game 10 francs". */
  private matchGive(c: string, ctx: IntentContext, current: string | null): Match | null {
    const m = new RegExp(
      String.raw`^(?:give|allow|grant|gib|gebe|erlaube)\s+(?:(it|him|her|them|ihm|ihr|ihnen)|(?:the\s+|dem\s+|der\s+)?(.+?))\s+${AMOUNT}\s*${CURRENCY}\b(.*)$`,
      "i",
    ).exec(c);
    if (!m) return null;
    const pid = this.projectIdFor(m[1] ? undefined : m[2], ctx, current);
    if (typeof pid !== "string" && pid !== null) return { question: pid };
    const tail = (m[5] ?? "").trim();
    const when = parseWhen(tail, ctx);
    // "for two hours", "next week", "tonight at the latest": never a silent permanent cap.
    if (tail && (!when || when.rest)) return { question: untilQuestion(when?.rest ?? tail) };
    const params: Record<string, unknown> = {
      scope: "session",
      ...amountParams(m[3] as string, m[4] as string),
    };
    if (pid) params.project = pid;
    if (when) params.until = when.until;
    return { command: { name: "budget.set", params } };
  }

  private matchAutonomy(c: string, ctx: IntentContext, current: string | null): Match | null {
    const m =
      /^(?:set|change|put|move)\s+(?:the\s+)?autonomy(?:\s+level)?\s+(?:(?:of|for|on)\s+(.+?)\s+)?to\s+(?:level\s+)?([0-4])$/i.exec(
        c,
      ) ??
      /^autonomy(?:\s+level)?\s+(?:(?:of|for|on)\s+(.+?)\s+)?(?:to\s+)?([0-4])$/i.exec(c) ??
      /^(?:setz(?:e)?|stell(?:e)?|[äa]ndere?)\s+(?:die\s+)?autonomie(?:\s*stufe)?\s+(?:(?:von|f[üu]r)\s+(.+?)\s+)?auf\s+(?:stufe\s+)?([0-4])$/i.exec(
        c,
      ) ??
      /^autonomie(?:\s*stufe)?\s+(?:(?:von|f[üu]r)\s+(.+?)\s+)?auf\s+([0-4])$/i.exec(c);
    if (!m) return null;
    const pid = this.projectIdFor(m[1], ctx, current);
    if (typeof pid !== "string" && pid !== null) return { question: pid };
    const params: Record<string, unknown> = { level: Number(m[2]) };
    if (pid) params.project = pid;
    return { command: { name: "autonomy.set", params } };
  }

  private matchStop(c: string): Match | null {
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

  private matchPause(c: string): Match | null {
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

  private matchStart(c: string, ctx: IntentContext, current: string | null): Match | null {
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
    const pid = this.projectIdFor(m[1], ctx, current);
    if (typeof pid !== "string" && pid !== null) return { question: pid };
    const params: Record<string, unknown> = {};
    if (pid) params.project = pid;
    if (runner) params.runner = runner;
    if (budgetChf !== undefined) params.budgetChf = budgetChf;
    return { command: { name: "session.start", params } };
  }
}
