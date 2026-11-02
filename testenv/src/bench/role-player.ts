import { type Clock, systemClock } from "@forerunner/platform";
import { collectFakeStream } from "../provider/collect.ts";
import {
  chunkJson,
  chunkText,
  FAKE_MODELS,
  FAKE_PROVIDER_NAME,
} from "../provider/fake-provider.ts";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "../provider/types.ts";
import { type LoggedReply, type ModelCallLog, requestFields } from "./call-log.ts";
import {
  contentFor,
  defaultFile,
  filesNamed,
  type IntakeInput,
  intakeProposal,
  type PageRead,
  type PlanOptions,
  researchContent,
  splitChanges,
  urlsNamed,
} from "./plans.ts";
import {
  detectRole,
  firstUserText,
  lastUserText,
  matchesAny,
  messageText,
  numbered,
  type PastToolCall,
  pastToolCalls,
  type RoleGuess,
  section,
  slug,
} from "./roles.ts";

/**
 * The bench's role-playing stand-in model (`fr daemon --provider bench`, scripts/bench/). It
 * reads which part of Forerunner is asking (intake, a specialist, the critic, the chat) and
 * answers so the real flow goes on: a plan the intake parser takes, real tool calls through the
 * app's own tools, a verdict through `submit_review`, a short chat reply that says what context
 * it was given. Deterministic; failures are planted through the environment (`benchOptionsFromEnv`).
 * Every request is written to the model-call log. Its output says "[stand-in model]" wherever a
 * person sees it: it shows that the mechanics work, never what a real model would do.
 */

export const STAND_IN = "[stand-in model]";

export interface BenchOptions {
  log: ModelCallLog;
  plan: PlanOptions;
  /** Task-title substrings whose specialist run fails (FORERUNNER_BENCH_FAIL). */
  fail: string[];
  /** `report`: the specialist says it could not do the work; `error`: the model call fails. */
  failMode: "report" | "error";
  /** How many runs of a matching task fail (FORERUNNER_BENCH_FAIL_TIMES; default every run). */
  failTimes: number;
  /** Task-title substrings the critic sends back for rework (FORERUNNER_BENCH_CRITIC_REJECT). */
  reject: string[];
  /** How many reviews of a matching task ask for rework (FORERUNNER_BENCH_CRITIC_REJECT_TIMES; default 1). */
  rejectTimes: number;
  /** Task-title substrings whose specialist asks the person first (FORERUNNER_BENCH_ASK). */
  ask: string[];
  /**
   * How a FORERUNNER_BENCH_ASK specialist asks (FORERUNNER_BENCH_ASK_STYLE): `tool` (default)
   * calls `ask_person`; `plain` does the work with a placeholder and ends its report with
   * "**Questions for the person:**" and one question per line without bullets, as the live
   * garden club "Home page" report did (2026-11-02, L-2); `bullets` does the same with "- "
   * items, after a "**Summary**:" heading, as the live "Contact page" report did (L-12).
   */
  askStyle?: AskStyle;
  /**
   * Task-title substrings whose input is missing (FORERUNNER_BENCH_MISSING, the live "Members
   * chart" of 2026-11-01): the specialist makes no deliverable, writes a note that says so and
   * ends its report with "Questions for the person:"; the stand-in critic accepts it, as the
   * live critic did.
   */
  missing: string[];
  /** `ok`, or a planted intake failure (FORERUNNER_BENCH_INTAKE=malformed|error). */
  intake: "ok" | "malformed" | "error";
  /**
   * The first planning reply of each draft is one the live model sent (FORERUNNER_BENCH_INTAKE_BAD,
   * live check of 2026-11-01): `reason-too-long` (a 750-character plan.reason), `fenced-docs`
   * (docs that hold code fences), `missing-tasks` (a milestone with no task), `not-json` (prose),
   * `too-big` (the full plan when a small one was asked for: the live model's six tasks for a
   * one-line brief). The intake's one retry (its request carries the refused reply) gets the plan.
   */
  intakeBad: IntakeBad;
  /**
   * Wait before each reply so running states can be seen (FORERUNNER_BENCH_DELAY_MS, default
   * 250). Not applied to the critic, whose monthly calibration makes some 160 calls.
   */
  delayMs: number;
  /**
   * Wait before each reply of the critic (FORERUNNER_BENCH_CRITIC_DELAY_MS, default 0), so a
   * task can be seen "Being reviewed" and stopped or cancelled then, as with the real model,
   * whose review takes tens of seconds. Leave it at 0 when the monthly calibration may run.
   */
  criticDelayMs?: number;
  clock?: Clock;
}

export const ASK_STYLES = ["tool", "plain", "bullets"] as const;
export type AskStyle = (typeof ASK_STYLES)[number];

export const INTAKE_BAD_KINDS = [
  "reason-too-long",
  "fenced-docs",
  "missing-tasks",
  "not-json",
  "too-big",
] as const;
export type IntakeBad = (typeof INTAKE_BAD_KINDS)[number] | "none";

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);

const count = (v: string | undefined, fallback: number): number => {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return fallback;
  if (t === "always" || t === "all" || t === "inf") return Number.POSITIVE_INFINITY;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const askStyleOf = (v: string | undefined): AskStyle => {
  const t = (v ?? "").trim().toLowerCase();
  return (ASK_STYLES as readonly string[]).includes(t) ? (t as AskStyle) : "tool";
};

/** The failure-injection and plan knobs, read once at daemon start. */
export function benchOptionsFromEnv(env: NodeJS.ProcessEnv, log: ModelCallLog): BenchOptions {
  const intake = (env.FORERUNNER_BENCH_INTAKE ?? "").trim().toLowerCase();
  const bad = (env.FORERUNNER_BENCH_INTAKE_BAD ?? "").trim().toLowerCase();
  const rawDelay = (env.FORERUNNER_BENCH_DELAY_MS ?? "").trim();
  const delay = rawDelay ? Number(rawDelay) : 250;
  const criticDelay = Number((env.FORERUNNER_BENCH_CRITIC_DELAY_MS ?? "").trim() || 0);
  // FORERUNNER_BENCH_PLAN: `chain`, `research`, or both (`chain,research`).
  const plans = list(env.FORERUNNER_BENCH_PLAN).map((v) => v.toLowerCase());
  return {
    log,
    plan: {
      kind: plans.includes("chain") ? "chain" : "default",
      research: plans.includes("research"),
      personTask: ["1", "true", "yes", "on"].includes(
        (env.FORERUNNER_BENCH_PERSON ?? "").trim().toLowerCase(),
      ),
      risk2: list(env.FORERUNNER_BENCH_RISK2),
    },
    fail: list(env.FORERUNNER_BENCH_FAIL),
    failMode:
      (env.FORERUNNER_BENCH_FAIL_MODE ?? "").trim().toLowerCase() === "error" ? "error" : "report",
    failTimes: count(env.FORERUNNER_BENCH_FAIL_TIMES, Number.POSITIVE_INFINITY),
    reject: list(env.FORERUNNER_BENCH_CRITIC_REJECT),
    rejectTimes: count(env.FORERUNNER_BENCH_CRITIC_REJECT_TIMES, 1),
    ask: list(env.FORERUNNER_BENCH_ASK),
    askStyle: askStyleOf(env.FORERUNNER_BENCH_ASK_STYLE),
    missing: list(env.FORERUNNER_BENCH_MISSING),
    intake: intake === "malformed" || intake === "error" ? intake : "ok",
    intakeBad: (INTAKE_BAD_KINDS as readonly string[]).includes(bad) ? (bad as IntakeBad) : "none",
    delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 250,
    criticDelayMs: Number.isFinite(criticDelay) && criticDelay > 0 ? criticDelay : 0,
  };
}

/** What the stand-in decided to answer, before it becomes stream events. */
interface Answer {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  error?: { code: string; message: string; retryable: boolean };
  injected?: string;
}

const text = (t: string, injected?: string): Answer => ({
  text: t,
  toolCalls: [],
  ...(injected ? { injected } : {}),
});

export function createRolePlayer(opts: BenchOptions): ModelProvider {
  const clock = opts.clock ?? systemClock;
  /** Runs (by run id) of a task that were made to fail / reviews made to reject. */
  const failedRuns = new Map<string, Set<string>>();
  const rejectedRuns = new Map<string, Set<string>>();
  /** Task titles seen in specialist runs: the critic's brief is "<title>: <outcome>". */
  const titles = new Set<string>();
  let callSeq = 0;

  /** Whether this run is one of the first `times` runs of `key` picked for an injection. */
  const pick = (runs: Map<string, Set<string>>, key: string, runId: string, times: number) => {
    const seen = runs.get(key) ?? new Set<string>();
    runs.set(key, seen);
    if (seen.has(runId)) return true;
    if (seen.size >= times) return false;
    seen.add(runId);
    return true;
  };

  const answer = (req: ModelRequest, guess: RoleGuess): Answer => {
    switch (guess.role) {
      case "intake":
        return intakeAnswer(req, opts);
      case "specialist":
        if (guess.task) titles.add(guess.task);
        return specialistAnswer(req, guess, opts, (title, runId) =>
          pick(failedRuns, title, runId, opts.failTimes),
        );
      case "critic":
        return criticAnswer(
          req,
          opts,
          (key, runId) => pick(rejectedRuns, key, runId, opts.rejectTimes),
          titles,
        );
      case "chat":
        return chatAnswer(req);
      default:
        console.error(
          `[bench] unrecognised role: label=${req.origin?.label ?? "-"} system=${(req.system ?? "").slice(0, 80)}`,
        );
        return text(
          `${STAND_IN} unrecognised role: this stand-in does not know what to answer here.`,
        );
    }
  };

  const provider: ModelProvider = {
    name: FAKE_PROVIDER_NAME,
    listModels: async () => [...FAKE_MODELS],
    countTokens: (t) => Math.ceil(t.length / 4),
    async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
      const started = clock.monotonic();
      const time = clock.nowIso();
      const guess = detectRole(req);
      callSeq += 1;
      const seq = callSeq;
      let a: Answer;
      try {
        a = answer(req, guess);
      } catch (e) {
        a = text(
          `${STAND_IN} the stand-in failed to build a reply: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const usage: Usage = {
        input_tokens: Math.ceil(
          ((req.system ?? "").length + JSON.stringify(req.messages).length) / 4,
        ),
        output_tokens: Math.max(
          1,
          Math.ceil((a.text.length + JSON.stringify(a.toolCalls).length) / 4),
        ),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      const stop: StopReason = a.error ? "error" : a.toolCalls.length ? "tool_use" : "end_turn";
      const logged: LoggedReply = {
        text: a.text,
        toolCalls: a.toolCalls,
        stopReason: stop,
        ...(a.error ? { error: { code: a.error.code, message: a.error.message } } : {}),
        usage,
      };
      const record = () =>
        opts.log.write({
          time,
          mode: "stand-in",
          ...requestFields(req, FAKE_PROVIDER_NAME),
          reply: logged,
          ...(a.injected ? { injected: a.injected } : {}),
          durationMs: Math.round(clock.monotonic() - started),
        });
      yield { type: "message_start", model: req.model };
      try {
        const wait = guess.role === "critic" ? (opts.criticDelayMs ?? 0) : opts.delayMs;
        if (wait > 0) await clock.sleep(wait, req.signal);
      } catch {
        logged.stopReason = "aborted";
        record();
        yield { type: "error", code: "aborted", message: "aborted", retryable: false };
        return;
      }
      if (a.error) {
        record();
        yield { type: "error", ...a.error };
        return;
      }
      for (const chunk of a.text ? chunkText(a.text, 80) : [])
        yield { type: "text_delta", text: chunk };
      // Tool-use ids are unique per call and position, as a real provider's are.
      for (const [i, c] of a.toolCalls.entries()) {
        const id = `toolu_bench_${seq}_${i}`;
        yield { type: "tool_use_start", id, name: c.name };
        for (const part of chunkJson(JSON.stringify(c.input), 400))
          yield { type: "tool_use_delta", id, partial_json: part };
        yield { type: "tool_use_end", id, input: c.input };
      }
      record();
      yield { type: "message_end", stop_reason: stop, usage };
    },
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const { response, error } = await collectFakeStream(
        provider.stream(req),
        () => clock.monotonic(),
        () => clock.monotonic(),
      );
      return error
        ? { ...response, error: { code: error.code, message: error.message } }
        : response;
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------

export function parseIntakeRequest(req: ModelRequest): IntakeInput {
  const user = firstUserText(req.messages);
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(user)?.[1]?.trim() ?? "";
  // After "Change the plan" the person's words follow the brief inside the markers (design §3.3).
  const { brief, changes } = splitChanges(
    /<<<BRIEF\n([\s\S]*?)\nBRIEF>>>/.exec(user)?.[1]?.trim() ?? "",
  );
  return {
    project: field("Project"),
    goal: field("Goal"),
    brief,
    // "Plan size: small (a short brief: …)" asks for one to three tasks (the intake's Size rules).
    smallProject: field("Plan size").startsWith("small"),
    changes,
  };
}

function intakeAnswer(req: ModelRequest, opts: BenchOptions): Answer {
  if (opts.intake === "error")
    return {
      text: "",
      toolCalls: [],
      error: {
        code: "overloaded_error",
        message: "stand-in: planted planning failure",
        retryable: false,
      },
      injected: "intake=error",
    };
  if (opts.intake === "malformed")
    return text(
      `${STAND_IN} I think this project needs a website first. Here is my plan: build it, then test it.`,
      "intake=malformed",
    );
  const input = parseIntakeRequest(req);
  const proposal = intakeProposal(input, opts.plan);
  // The intake's one retry carries the refused reply and what was wrong with it: the plan.
  const retry = req.messages.length > 1;
  if (opts.intakeBad !== "none" && !retry) {
    if (opts.intakeBad === "too-big")
      // The full plan although a small one was asked for (the live model's six tasks).
      return text(
        JSON.stringify(intakeProposal({ ...input, smallProject: false }, opts.plan), null, 2),
        "intake-bad=too-big",
      );
    return badIntakeReply(proposal, opts.intakeBad);
  }
  return text(JSON.stringify(proposal, null, 2));
}

/** A reason as long as the live model's (754 characters), in whole sentences. */
const LONG_REASON = [
  `${STAND_IN} The brief is one line, so this plan chooses the smallest approach that meets it.`,
  "A static page in plain HTML, CSS and JavaScript needs no backend, no framework and no build step.",
  "The brief names no hosting, repository, quote source or look, and only the person can settle those,",
  "so the plan assumes the simplest: files in the project's folder, opened in a browser.",
  "The work is one build task and one check, so the person sees a working page after the first session.",
  "No task needs the web, so the quote list is written from what the coder already knows,",
  "and the decision record says which attributions could not be checked online.",
  "Anything bigger, a server, user accounts or a shared quote list, would need a new decision first,",
  "so it is left out of this plan on purpose and can be asked for in a later change.",
].join(" ");

/** The live model's bad first replies (`FORERUNNER_BENCH_INTAKE_BAD`). */
function badIntakeReply(
  proposal: Record<string, unknown>,
  kind: Exclude<IntakeBad, "none" | "too-big">,
): Answer {
  const injected = `intake-bad=${kind}`;
  const plan = proposal.plan as Record<string, unknown>;
  switch (kind) {
    case "reason-too-long":
      return text(
        JSON.stringify({ ...proposal, plan: { ...plan, reason: LONG_REASON } }, null, 2),
        injected,
      );
    case "fenced-docs": {
      const docs = { ...(proposal.docs as Record<string, string>) };
      docs["README.md"] = [
        docs["README.md"] ?? "# Project",
        "## The quote list",
        "",
        "Each quote in script.js has this shape:",
        "",
        "```json",
        '[ { "text": "string, non-empty, under 280 characters", "author": "string" } ]',
        "```",
        "",
        "## Check it",
        "",
        "```bash",
        "node --check script.js",
        "```",
        "",
      ].join("\n");
      return text(JSON.stringify({ ...proposal, docs }, null, 2), injected);
    }
    case "missing-tasks": {
      const milestones = (plan.milestones as Record<string, unknown>[]).map((m) => ({
        ...m,
        tasks: [],
      }));
      return text(
        JSON.stringify({ ...proposal, plan: { ...plan, milestones } }, null, 2),
        injected,
      );
    }
    case "not-json":
      return text(
        `${STAND_IN} Here is my plan: first build the page, then check it works. I will write the JSON next.`,
        injected,
      );
  }
}

// ---------------------------------------------------------------------------------------
// Specialists
// ---------------------------------------------------------------------------------------

export interface BriefParts {
  title: string;
  outcome: string;
  criteria: string[];
  answers: string;
}

export function parseBrief(req: ModelRequest, guess: RoleGuess): BriefParts {
  const user = firstUserText(req.messages);
  const goal = section(user, "Goal");
  const title = guess.task ?? goal.split(": ")[0] ?? goal;
  const outcome = goal.startsWith(`${title}: `) ? goal.slice(title.length + 2) : goal;
  return {
    title,
    outcome,
    criteria: numbered(section(user, "Acceptance criteria")),
    answers: section(user, "Answers from the person"),
  };
}

const offered = (tools: readonly ToolDefinition[] | undefined, name: string) =>
  (tools ?? []).some((t) => t.name === name);

const CHECKER = new Set(["tester", "reviewer"]);
/** A test file a checker writes when its title names one (test/x.test.js, tests/y.mjs). */
const TEST_FILE = /(?:^|\/)tests?\/|\.(?:test|spec)\.m?[jt]s$/;
const COMMON_FILES = ["index.html", "script.js", "src/main.js", "README.md"];

/** The files a `list_dir` result names (one path per line, directories end in "/"). */
function listed(calls: readonly PastToolCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.name !== "list_dir" || c.isError || !c.result) continue;
    for (const line of c.result.split("\n")) {
      const p = line.trim();
      if (p && !p.endsWith("/") && p !== "(empty)") out.push(p);
    }
  }
  return out;
}

function specialistAnswer(
  req: ModelRequest,
  guess: RoleGuess,
  opts: BenchOptions,
  failThisRun: (title: string, runId: string) => boolean,
): Answer {
  const brief = parseBrief(req, guess);
  const who = guess.specialist ?? "specialist";
  const calls = pastToolCalls(req.messages);
  const did = (name: string) => calls.some((c) => c.name === name);
  const runId = req.origin?.runId ?? "no-run-id";
  const checker = CHECKER.has(who);
  const files = listed(calls);
  // What it writes: the files its title names, else the first its outcome names, else a note.
  // A checker (tester, reviewer) never rewrites the work; it writes its own notes.
  const titleFiles = filesNamed(brief.title);
  const outcomeFile = filesNamed(brief.outcome).slice(0, 1);
  // A checker never rewrites the work: it writes its notes, and the test file its title names
  // ("Add a check for src/main.js in test/main.test.js": the criterion names that file, C-10).
  const testFiles = titleFiles.filter((f) => TEST_FILE.test(f));
  const targets = checker
    ? [...testFiles, `checks/${slug(brief.title)}.md`]
    : titleFiles.length
      ? titleFiles
      : outcomeFile.length
        ? outcomeFile
        : [defaultFile(brief.title, who)];
  const mentioned = filesNamed(`${brief.title}\n${brief.outcome}\n${brief.criteria.join("\n")}`);

  // 1. Look around first, as a careful worker does.
  if (!did("list_dir") && offered(req.tools, "list_dir"))
    return {
      text: "I'll look at what is already in the folder first.",
      toolCalls: [{ name: "list_dir", input: { path: ".", depth: 2 } }],
    };

  // 2. Planted: needs the person's answers before it can work.
  const askHit = matchesAny(brief.title, opts.ask);
  // "Go ahead without" reaches the brief under "Answers from the person" (live L-3), and
  // `ask_person` is refused on the task from then on.
  const wentAhead = /chose to go ahead without answering/i.test(firstUserText(req.messages));
  // FORERUNNER_BENCH_ASK_STYLE=plain|bullets: it works with a placeholder and asks in its report.
  const askInReport =
    askHit && !brief.answers && !wentAhead && (opts.askStyle ?? "tool") !== "tool"
      ? reportQuestions(brief.title, opts.askStyle === "plain" ? "plain" : "bullets")
      : null;
  if (askHit && !askInReport && !brief.answers && !wentAhead && !did("ask_person")) {
    const questions = [
      `For "${brief.title}": which option do you prefer, A (simple) or B (complete)?`,
      "Is there anything this must not change?",
    ];
    if (offered(req.tools, "ask_person"))
      return {
        text: "I need the person's answers before I can do this.",
        toolCalls: [
          {
            name: "ask_person",
            input: {
              questions,
              why: `${STAND_IN} planted question (FORERUNNER_BENCH_ASK=${askHit})`,
            },
          },
        ],
        injected: `ask=${askHit}`,
      };
    return text(
      `${STAND_IN} I did not change anything yet.\n\nQuestions for the person:\n${questions.map((q) => `- ${q}`).join("\n")}`,
      `ask=${askHit}`,
    );
  }
  if (did("ask_person")) return text(`${STAND_IN} I asked the person and wait for the answers.`);

  // 3. Planted: the run fails.
  const failHit = matchesAny(brief.title, opts.fail);
  if (failHit && failThisRun(brief.title, runId)) {
    if (opts.failMode === "error")
      return {
        text: "",
        toolCalls: [],
        error: {
          code: "overloaded_error",
          message: `stand-in: planted model failure (FORERUNNER_BENCH_FAIL=${failHit})`,
          retryable: false,
        },
        injected: `fail=${failHit} (error)`,
      };
    return text(
      [
        `**Summary** ${STAND_IN} I could not complete this task. The work needs something I do not have here, so I stopped without changing any file.`,
        "",
        "**Files changed**: none.",
        "",
        "**Criteria**",
        ...brief.criteria.map((c) => `- ${c}: not met (nothing was written)`),
        "",
        `**Not done / risks**: everything. Planted failure (FORERUNNER_BENCH_FAIL=${failHit}).`,
      ].join("\n"),
      `fail=${failHit} (report)`,
    );
  }

  // 3b. Planted: an input the task needs is missing (FORERUNNER_BENCH_MISSING). Live, the
  // data-analyst rightly made no chart and asked for the file in its report's last lines.
  const missingHit = matchesAny(brief.title, opts.missing ?? []);
  if (missingHit) {
    const input = mentioned.find((f) => f.startsWith("data/")) ?? "the input file";
    const note = `notes/${slug(brief.title)}.md`;
    if (!did("write_file") && offered(req.tools, "write_file"))
      return {
        text: `Writing ${note}.`,
        toolCalls: [
          {
            name: "write_file",
            input: {
              path: note,
              content: `# ${brief.title}\n\nNot made yet: ${input} is not in the project's folder, and no number may be invented.\n`,
            },
          },
        ],
        injected: `missing=${missingHit}`,
      };
    return text(
      [
        `**Summary** ${STAND_IN} ${who} wrote ${note} for "${brief.title}": the deliverable is not made, because ${input} is missing. A blocked report is the right outcome.`,
        "",
        "**Files changed**",
        `- ${note}`,
        "",
        "Questions for the person:",
        `- Please add ${input} to the project's folder: "${brief.title}" needs it and no number may be invented.`,
      ].join("\n"),
      `missing=${missingHit}`,
    );
  }

  // 4a. Research: read the web pages the brief names, when the page reader is offered (the
  // researcher and the science-evaluator on an API key, ADR 0107), then write from them.
  const urls = urlsNamed(`${brief.title}\n${brief.outcome}\n${brief.criteria.join("\n")}`);
  if (urls.length && offered(req.tools, "web_fetch") && !did("web_fetch"))
    return {
      text: `Reading ${urls.join(", ")}.`,
      toolCalls: urls.map((url) => ({ name: "web_fetch", input: { url } })),
    };
  const pages: PageRead[] = calls
    .filter((c) => c.name === "web_fetch")
    .map((c) => ({
      url: String(c.input.url),
      result: c.result ?? "",
      isError: c.isError === true,
    }));

  // 4. Read what is there that this task builds on.
  if (!did("read_file") && offered(req.tools, "read_file")) {
    const wanted = [
      ...targets,
      ...mentioned,
      ...(checker || who.startsWith("writer") ? COMMON_FILES : []),
    ];
    const toRead = [...new Set(wanted)].filter((f) => files.includes(f)).slice(0, 3);
    if (toRead.length)
      return {
        text: `Reading ${toRead.join(", ")}.`,
        toolCalls: toRead.map((path) => ({ name: "read_file", input: { path } })),
      };
  }
  const seen = calls
    .filter((c) => c.name === "read_file" && !c.isError)
    .map((c) => c.result ?? "")
    .join("\n");

  // 5. Checkers run a harmless check before they write their notes.
  const jsToCheck = [...new Set([...mentioned, ...files])].filter(
    (f) =>
      /\.m?js$/.test(f) &&
      (files.includes(f) || calls.some((c) => c.name === "write_file" && c.input.path === f)),
  );
  if (checker && !did("run_command") && offered(req.tools, "run_command") && jsToCheck[0])
    return {
      text: `Checking ${jsToCheck[0]} with node --check.`,
      toolCalls: [
        { name: "run_command", input: { argv: ["node", "--check", jsToCheck[0]], timeoutSec: 60 } },
      ],
    };

  // 6. Write the work.
  if (!did("write_file") && offered(req.tools, "write_file")) {
    const ran = calls.filter((c) => c.name === "run_command");
    const literal = briefAsRead(firstUserText(req.messages), who);
    const writes = targets.map((path) => {
      // A tester writes the test file its title names as code, beside its notes (bench, C-10).
      const content =
        checker && !TEST_FILE.test(path)
          ? [
              `# Check: ${brief.title}`,
              "",
              ...ran.map(
                (c) =>
                  `- \`${((c.input.argv as string[]) ?? []).join(" ")}\`: ${c.isError ? "failed" : "passed"}`,
              ),
              ...brief.criteria.map((c) => `- ${c}: checked by reading the files`),
              "",
            ].join("\n")
          : pages.length && path.endsWith(".md")
            ? researchContent(brief, pages, STAND_IN)
            : (toolContent(path, brief) ?? contentFor(path, brief, seen, [...files, ...targets]));
      return {
        name: "write_file",
        input: {
          path,
          content:
            !checker && literal.lessonsInReportFile && isReportFile(path)
              ? `${content.replace(/\n*$/, "\n")}\n${lessonLine(who)}\n`
              : content,
        },
      };
    });
    if (!checker && literal.scratchNotes && writes.some((w) => w.input.path.endsWith(".md")))
      writes.push({
        name: "write_file",
        input: {
          path: "notes.md",
          content: `# Scratch notes\n\n${STAND_IN} working notes for "${brief.title}".\n`,
        },
      });
    return { text: `Writing ${writes.map((w) => w.input.path).join(", ")}.`, toolCalls: writes };
  }

  // 7. Makers check the JavaScript they wrote.
  const wroteJs = calls.find(
    (c) => c.name === "write_file" && /\.m?js$/.test(String(c.input.path)) && !c.isError,
  );
  if (!checker && wroteJs && !did("run_command") && offered(req.tools, "run_command"))
    return {
      text: `Checking ${String(wroteJs.input.path)} with node --check.`,
      toolCalls: [
        {
          name: "run_command",
          input: { argv: ["node", "--check", String(wroteJs.input.path)], timeoutSec: 60 },
        },
      ],
    };

  // 8. The report, in the shape the registry asks for.
  if (askInReport) return text(askInReport(report(brief, who, calls, req.tools)), `ask=${askHit}`);
  return text(report(brief, who, calls, req.tools));
}

/**
 * A report that asks the person in its last lines, as the live model wrote it (2026-11-02): the
 * summary under "**Summary**:", the reason under "Not done / risks", then "**Questions for the
 * person:**" with one question per line, without bullets (the garden club's "Home page", L-2)
 * or with "- " items (the "Contact page", L-12).
 */
function reportQuestions(title: string, style: "plain" | "bullets"): (body: string) => string {
  const questions = [
    `What is the real name to show in "${title}"?`,
    "Is there anything this must not change?",
  ];
  return (body) =>
    [
      body
        .replace(/^\*\*Summary\*\* /, "**Summary**: ")
        .replace(
          "**Not done / risks**",
          `**Not done / risks**\n- The name in "${title}" is a placeholder, because the brief gave no real one.`,
        )
        .replace(/\n+Lesson: [^\n]*$/, ""),
      "",
      "**Questions for the person:**",
      ...questions.map((q) => (style === "plain" ? q : `- ${q}`)),
      "",
      "Lesson: a name only the person knows is asked for, never invented.",
    ].join("\n");
}

/**
 * A command line tool or a tiny HTTP API that works (ADR 0110: the review runs a tool with
 * sample input and starts a server and calls it, so the stand-in's must do what the brief
 * says): a JavaScript file the brief runs as `node <file> ...` becomes a tool that counts the
 * words or lines of its file (or standard input), or greets the name it is given; a JavaScript
 * file of a brief that names an HTTP API, a server or a `GET /route` becomes a server that
 * listens on PORT (3000 when unset) and answers each route the brief names with JSON.
 * Anything else: null (the plan's content).
 */
export function toolContent(path: string, brief: BriefParts): string | null {
  if (!/\.(m?js|cjs)$/i.test(path) || /test/i.test(path)) return null;
  const about = `${brief.title}\n${brief.outcome}\n${brief.criteria.join("\n")}`;
  const runs = new RegExp(`\\bnode\\s+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
    about,
  );
  const routes = [...about.matchAll(/\bGET\s+(\/[\w\-./]*)/g)].map((m) => m[1] ?? "/");
  const api = routes.length > 0 || /\b(http api|api|server)\b/i.test(about);
  if (api && (runs || /server|api|app/i.test(path))) {
    const answers = (routes.length ? [...new Set(routes)] : ["/"]).map((r) => {
      const body = /health/i.test(r) ? { ok: true } : { path: r, from: "the stand-in model" };
      return `  if (url === ${JSON.stringify(r)}) return send(200, ${JSON.stringify(body)});`;
    });
    return [
      `// ${STAND_IN} ${brief.title}`,
      'const http = require("http");',
      "const PORT = Number(process.env.PORT) || 3000;",
      "function handle(req, res) {",
      "  const send = (status, body) => {",
      '    res.writeHead(status, { "content-type": "application/json" });',
      "    res.end(JSON.stringify(body));",
      "  };",
      '  const url = (req.url || "/").split("?")[0];',
      ...answers,
      '  return send(404, { error: "not found" });',
      "}",
      "if (require.main === module) {",
      '  http.createServer(handle).listen(PORT, () => console.log("listening on " + PORT));',
      "}",
      "module.exports = { handle };",
      "",
    ].join("\n");
  }
  if (!runs) return null;
  const greet = /\bgreet|greeting|hello\b/i.test(about);
  const lines = /\blines?\b/i.test(about) && !/\bwords?\b/i.test(about);
  if (greet)
    return [
      `// ${STAND_IN} ${brief.title}`,
      "function greet(name) {",
      '  return "Hello, " + name + "!";',
      "}",
      "module.exports = { greet };",
      "if (require.main === module) {",
      '  console.log(greet(process.argv[2] || "world"));',
      "}",
      "",
    ].join("\n");
  return [
    "#!/usr/bin/env node",
    `// ${STAND_IN} ${brief.title}`,
    'const fs = require("fs");',
    "const file = process.argv[2];",
    'const text = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");',
    lines
      ? 'console.log(text.split("\\n").filter((l) => l.length > 0).length);'
      : "console.log(text.split(/\\s+/).filter(Boolean).length);",
    "",
  ].join("\n");
}

function report(
  brief: BriefParts,
  who: string,
  calls: readonly PastToolCall[],
  tools: readonly ToolDefinition[] | undefined,
): string {
  const writes = calls.filter((c) => c.name === "write_file");
  const okWrites = writes.filter((c) => !c.isError);
  const failedWrites = writes.filter((c) => c.isError);
  const runs = calls.filter((c) => c.name === "run_command");
  const pages = calls.filter((c) => c.name === "web_fetch");
  const lines = [
    `**Summary** ${STAND_IN} ${okWrites.length ? `${who} wrote ${okWrites.map((c) => String(c.input.path)).join(", ")} for "${brief.title}".` : `${who} changed no file for "${brief.title}".`}`,
    "",
    "**Files changed**",
    ...(okWrites.length
      ? okWrites.map(
          (c) =>
            `- ${String(c.input.path)}: ${String((c.input.content as string | undefined)?.length ?? 0)} characters`,
        )
      : ["- none"]),
    "",
    "**Criteria**",
    ...(brief.criteria.length ? brief.criteria : ["The outcome in the goal"]).map(
      (c) =>
        `- ${c}: ${okWrites.length || runs.some((r) => !r.isError) ? "met" : "unclear"} (see the files and commands listed)`,
    ),
    "",
    "**Commands run**",
    ...(runs.length
      ? runs.map(
          (r) =>
            `- \`${((r.input.argv as string[]) ?? []).join(" ")}\`: ${r.isError ? "failed" : "ok"}${r.result ? ` (${r.result.split("\n")[0]?.slice(0, 80)})` : ""}`,
        )
      : ["- none"]),
    "",
    ...(pages.length
      ? [
          "**Sources read**",
          ...pages.map(
            (p) =>
              `- ${String(p.input.url)}${p.isError ? `: not read (${(p.result ?? "").replace(/^ERROR: /, "").slice(0, 160)})` : ""}`,
          ),
          "",
        ]
      : []),
    "**Not done / risks**",
    ...(failedWrites.length
      ? failedWrites.map(
          (c) => `- writing ${String(c.input.path)} failed: ${(c.result ?? "").slice(0, 200)}`,
        )
      : []),
    ...(offered(tools, "write_file") || CHECKER.has(who)
      ? []
      : ["- no write tool was offered on this run, so nothing could be written"]),
    "- This report was written by the bench's stand-in model, not a real model.",
    "",
    lessonLine(who),
  ];
  return lines.join("\n");
}

/** The lesson the stand-in keeps, as its final message's last line. */
function lessonLine(who: string): string {
  return `Lesson: ${who} tasks in this project are small; one file per task keeps reviews quick.`;
}

/** A deliverable that is itself a report (the data-analyst's report.md, an evaluation.md). */
function isReportFile(path: string): boolean {
  return /\.md$/i.test(path) && /(report|evaluation|analysis|findings)/i.test(path);
}

/**
 * How the live model read two lines of the brief (live walk 4, 2026-11-02), so the bench shows
 * what the brief causes rather than passing by construction (phase E #95):
 * - "End the report with one line per lesson worth keeping" made the data-analyst and the
 *   science-evaluator, whose deliverable is a report, end that file with "Lesson:" lines.
 *   The brief now says lessons go only in the final message; the stand-in then keeps them out.
 * - Nothing said scratch notes stay out of the project: the writer-marketing left a notes.md
 *   at the root. A brief that says so ("scratch notes") gets none.
 */
function briefAsRead(
  user: string,
  who: string,
): { lessonsInReportFile: boolean; scratchNotes: boolean } {
  return {
    lessonsInReportFile: /End the report with one line per lesson/i.test(user),
    scratchNotes: who.startsWith("writer") && !/scratch notes/i.test(user),
  };
}

// ---------------------------------------------------------------------------------------
// Critic
// ---------------------------------------------------------------------------------------

/**
 * The reviewed task's title: a title seen in a specialist run that the brief starts with (the
 * longest), else the one the stand-in's own report names, else the brief up to its first ": ".
 */
export function reviewedTitle(brief: string, report: string, known: Iterable<string>): string {
  let best = "";
  for (const t of known) if (brief.startsWith(`${t}: `) && t.length > best.length) best = t;
  if (best) return best;
  const named = /for "([^"]+)"\./.exec(report)?.[1];
  if (named && brief.startsWith(named)) return named;
  return brief.split(": ")[0] ?? brief;
}

/** Words that say one file names another: "index.html links styles.css". */
const NAMES_ANOTHER = /\b(?:links?|loads?|references?|includes?|imports?)\b/i;

/**
 * Whether the work shows a criterion (C-10), from what the stand-in critic has: the changed
 * files and the files it read. A criterion that names no file is "not checked by the stand-in";
 * one that names a file not in the task's folder (its read failed) is not met; "<A> links|loads|
 * references|includes|imports <B>" is met only when the read A names B; a file it neither
 * changed nor read is "not checked". Deterministic: the same evidence, the same marks.
 */
export function judgeCriterion(
  text: string,
  changed: readonly string[],
  calls: readonly PastToolCall[],
): { text: string; met: boolean; evidence: string } {
  const files = filesNamed(text);
  if (!files.length)
    return {
      text,
      met: true,
      evidence: "not checked by the stand-in: the criterion names no file",
    };
  const reads = new Map(
    calls.filter((c) => c.name === "read_file").map((c) => [String(c.input.path), c]),
  );
  const readOk = (f: string) => {
    const r = reads.get(f);
    return r !== undefined && r.isError !== true && r.result !== undefined;
  };
  const missing = files.filter((f) => !changed.includes(f) && reads.get(f)?.isError === true);
  const notThere = () => ({
    text,
    met: false,
    evidence: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the task's folder`,
  });
  // The criterion's own claim first ("index.html links styles.css"), then the files it names.
  const verb = NAMES_ANOTHER.exec(text);
  const subject = verb ? filesNamed(text.slice(0, verb.index)).at(-1) : undefined;
  const objects = verb ? filesNamed(text.slice(verb.index)) : [];
  if (subject && objects.length && !missing.includes(subject)) {
    if (!readOk(subject))
      return {
        text,
        met: true,
        evidence: `not checked by the stand-in: it did not read ${subject}`,
      };
    const body = reads.get(subject)?.result ?? "";
    const absent = objects.filter((f) => !body.includes(f));
    if (absent.length)
      return { text, met: false, evidence: `${subject} does not name ${absent.join(" or ")}` };
    if (missing.length) return notThere();
    return { text, met: true, evidence: `read ${subject}: it names ${objects.join(" and ")}` };
  }
  if (missing.length) return notThere();
  const unseen = files.filter((f) => !changed.includes(f) && !readOk(f));
  if (unseen.length)
    return {
      text,
      met: true,
      evidence: `not checked by the stand-in: it did not read ${unseen.join(", ")}`,
    };
  return {
    text,
    met: true,
    evidence: files.map((f) => (readOk(f) ? `read ${f}` : `${f} changed`)).join("; "),
  };
}

function criticAnswer(
  req: ModelRequest,
  opts: BenchOptions,
  rejectThisReview: (key: string, runId: string) => boolean,
  known: Iterable<string> = [],
): Answer {
  const calls = pastToolCalls(req.messages);
  if (calls.some((c) => c.name === "submit_review")) return text(`${STAND_IN} Review submitted.`);
  const evidence = firstUserText(req.messages);
  const criteria = numbered(section(evidence, "Acceptance criteria"));
  const changed = section(evidence, "Changed files")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  // ADR 0104: the critic may read the task's folder. A careful reviewer reads the first changed
  // file and the files the criteria name before it grades (C-10: it marks a criterion met only
  // when a changed or read file shows it), in one turn.
  const toRead = [...new Set([changed[0], ...criteria.flatMap((c) => filesNamed(c))])]
    .filter((f): f is string => Boolean(f))
    .slice(0, 4);
  if (
    toRead.length &&
    offered(req.tools, "read_file") &&
    !calls.some((c) => c.name === "read_file")
  )
    return {
      text: `Reading ${toRead.join(", ")} before I grade.`,
      toolCalls: toRead.map((path) => ({ name: "read_file", input: { path } })),
    };
  const brief = section(evidence, "Brief");
  const workerReport = section(evidence, "Worker's final report");
  const subject = /^Subject: (.*)$/m.exec(evidence)?.[1] ?? "the work";
  const runId = req.origin?.runId ?? "no-run-id";
  // FORERUNNER_BENCH_CRITIC_REJECT matches the task's title, as FAIL and ASK do.
  const title = reviewedTitle(brief, workerReport, known) || subject;
  const rejectHit = matchesAny(title, opts.reject);
  const workerFailed = /could not complete this task|changed no file/i.test(workerReport);
  // FORERUNNER_BENCH_MISSING plays the live critic, which accepted a report that made nothing.
  const missingHit = matchesAny(title, opts.missing ?? []);
  const judged = criteria.map((c) =>
    missingHit
      ? {
          text: c,
          met: true,
          evidence: `not checked by the stand-in: FORERUNNER_BENCH_MISSING=${missingHit} plays the live critic, which accepted`,
        }
      : judgeCriterion(c, changed, calls),
  );
  const unmet = judged.filter((c) => !c.met);
  const reject =
    workerFailed || unmet.length > 0 || (rejectHit !== null && rejectThisReview(title, runId));
  const where = changed[0] ?? "the change";
  const review =
    unmet.length && !workerFailed
      ? {
          grade: 55,
          confidence: "high",
          verdict: "revise",
          summary: `${STAND_IN} Sent back for rework: ${unmet[0]?.text}: ${unmet[0]?.evidence}.`,
          findings: unmet.map((c) => ({
            severity: "major",
            what: `Acceptance criterion not met: ${c.text}: ${c.evidence}.`,
            where,
            required_action: "Meet the criterion and show the evidence for it.",
          })),
          criteria: judged,
          checks_run: [],
          evidence: changed.slice(0, 5),
        }
      : reject
        ? {
            grade: 35,
            confidence: "high",
            verdict: "revise",
            summary: `${STAND_IN} Sent back for rework: ${workerFailed ? "the worker reports it could not do the work" : `planted rejection (FORERUNNER_BENCH_CRITIC_REJECT=${rejectHit})`}.`,
            findings: [
              {
                severity: "major",
                what: workerFailed
                  ? "The worker changed nothing; the acceptance criteria are not met."
                  : "The change does not meet the first acceptance criterion as written.",
                where,
                required_action:
                  "Do the work the brief asks for and show the evidence for each criterion.",
              },
            ],
            criteria: criteria.map((c, i) => ({
              text: c,
              met: i > 0 && !workerFailed,
              evidence: i > 0 ? `read ${where}` : "not shown",
            })),
            checks_run: [],
            evidence: changed.slice(0, 5),
          }
        : {
            grade: 86,
            confidence: "high",
            verdict: "accept",
            // Design §5 rule 6: no "(s)"; the verb agrees ("Accepted: 1 changed file match").
            summary: `${STAND_IN} Accepted: ${
              changed.length === 1
                ? "the changed file matches the brief"
                : changed.length
                  ? `the ${changed.length} changed files match the brief`
                  : "the report and the evidence match the brief"
            }.`,
            findings: [],
            criteria: judged,
            checks_run: [],
            evidence: changed.slice(0, 5),
          };
  const injected =
    reject && !workerFailed && !unmet.length ? `critic_reject=${rejectHit}` : undefined;
  if (offered(req.tools, "submit_review"))
    return {
      text: "",
      toolCalls: [{ name: "submit_review", input: review }],
      ...(injected ? { injected } : {}),
    };
  return text(
    `${JSON.stringify(review)}\n\n${STAND_IN} (no submit_review tool was offered)`,
    injected,
  );
}

// ---------------------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------------------

/** The person's own words in a chat turn: the text after the facts and retrieved blocks. */
export function chatLine(req: ModelRequest): string {
  const last = lastUserText(req.messages);
  const parts = last.split("\n\n");
  return (parts.at(-1) ?? last).trim();
}

/** One sentence on what the chat turn was given. */
export function describeChatContext(req: ModelRequest): string {
  const system = req.system ?? "";
  const userTexts = req.messages.filter((m) => m.role === "user" && messageText(m));
  const earlier = Math.max(0, userTexts.length - 1);
  const projects = section(system.replace(/^# Projects/m, "## Projects"), "Projects")
    .split("\n")
    .filter((l) => l.startsWith("- "));
  const active = projects.find((l) => l.includes("(active)"));
  const sent = req.messages.map((m) => messageText(m)).join("\n");
  const all = `${system}\n${sent}`;
  // A heading that lists tasks; the doc excerpts' and lessons' own envelopes (conversation/agent.ts).
  const hasTasks = /(^|\n)#+\s*(open\s+|project\s+)?tasks\b/i.test(all);
  const hasDocs = /origin="project docs"/.test(sent);
  const hasLessons = /# Lessons from memory/.test(sent) || /(^|\n)# Pinned lessons/.test(system);
  const facts = /(^|\n)# Now\n([\s\S]*?)(\n\n|$)/.exec(lastUserText(req.messages))?.[2] ?? "";
  const factNames = facts
    .split("\n")
    .map((l) => /^- ([a-z_]+):/.exec(l)?.[1])
    .filter(Boolean);
  const tools = (req.tools ?? []).length;
  // The reply is shown in the chat: plural words as the number says (design §5 rule 6).
  return `I was given ${counted(earlier, "earlier turn")} of this conversation, ${counted(projects.length, "project")} in the system prompt${active ? " with one marked active" : ""}, ${hasTasks ? "a task list" : "no task list"}, ${hasDocs ? "project doc excerpts" : "no project doc excerpts"}, ${hasLessons ? "lessons" : "no lessons"}, the facts ${factNames.length ? factNames.join(", ") : "(none)"}, and ${counted(tools, "command tool")}.`;
}

/** "no project", "1 project", "2 projects". */
function counted(n: number, what: string): string {
  return n === 0 ? `no ${what}` : n === 1 ? `1 ${what}` : `${n} ${what}s`;
}

function chatAnswer(req: ModelRequest): Answer {
  const calls = pastToolCalls(req.messages);
  const lastCall = calls.at(-1);
  // After a command tool ran: say what it answered.
  const lastMsg = req.messages.at(-1);
  if (
    lastCall &&
    lastMsg &&
    typeof lastMsg.content !== "string" &&
    lastMsg.content.some((b) => b.type === "tool_result")
  )
    return text(
      `${STAND_IN} The command tool ${lastCall.name} answered${lastCall.isError ? " with an error" : ""}: ${(lastCall.result ?? "").slice(0, 400)}`,
    );
  const line = chatLine(req);
  const names = (req.tools ?? []).map((t) => t.name);
  if (/^tools\??$/i.test(line) || /^list tools$/i.test(line))
    return text(
      `${STAND_IN} The command tools offered on this turn: ${names.join(", ") || "none"}.`,
    );
  const m = /^tool:\s*([\w.:-]+)\s*([\s\S]*)$/i.exec(line);
  if (m?.[1]) {
    const name = m[1];
    if (!names.includes(name))
      return text(
        `${STAND_IN} There is no command tool named ${name} on this turn. Offered: ${names.join(", ") || "none"}.`,
      );
    let input: Record<string, unknown> = {};
    const raw = (m[2] ?? "").trim();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          input = parsed as Record<string, unknown>;
        else return text(`${STAND_IN} The input for ${name} must be a JSON object.`);
      } catch {
        return text(`${STAND_IN} The input for ${name} is not valid JSON: ${raw.slice(0, 120)}`);
      }
    }
    return { text: `Running ${name}.`, toolCalls: [{ name, input }] };
  }
  const told = chatFacts(req);
  return text(`${STAND_IN} ${describeChatContext(req)}${told ? ` ${told}` : ""}`);
}

/**
 * What the turn was told about the project, quoted back in the reply so a journey can check
 * the reply names the project's state and a task as a real model's would (scripts/bench): the
 * plan from the brief (`# Plan from the brief`) and the first task line of `# Tasks of …`.
 */
export function chatFacts(req: ModelRequest): string {
  const last = lastUserText(req.messages);
  const plan = /(?:^|\n)# Plan from the brief\n([^\n]+)/.exec(last)?.[1]?.trim();
  const task = /(?:^|\n)# Tasks of [^\n]*\n- ("[^"\n]+": [^;\n]+)/.exec(last)?.[1]?.trim();
  return [
    plan ? `The plan: ${plan}` : "",
    task ? `First task: ${task.replace(/[.\s]+$/, "")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
