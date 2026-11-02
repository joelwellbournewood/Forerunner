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
  type PlanOptions,
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
  clock?: Clock;
}

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

/** The failure-injection and plan knobs, read once at daemon start. */
export function benchOptionsFromEnv(env: NodeJS.ProcessEnv, log: ModelCallLog): BenchOptions {
  const intake = (env.FORERUNNER_BENCH_INTAKE ?? "").trim().toLowerCase();
  const bad = (env.FORERUNNER_BENCH_INTAKE_BAD ?? "").trim().toLowerCase();
  const rawDelay = (env.FORERUNNER_BENCH_DELAY_MS ?? "").trim();
  const delay = rawDelay ? Number(rawDelay) : 250;
  return {
    log,
    plan: {
      kind:
        (env.FORERUNNER_BENCH_PLAN ?? "").trim().toLowerCase() === "chain" ? "chain" : "default",
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
    intake: intake === "malformed" || intake === "error" ? intake : "ok",
    intakeBad: (INTAKE_BAD_KINDS as readonly string[]).includes(bad) ? (bad as IntakeBad) : "none",
    delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 250,
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
        if (opts.delayMs > 0 && guess.role !== "critic")
          await clock.sleep(opts.delayMs, req.signal);
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
  const brief = /<<<BRIEF\n([\s\S]*?)\nBRIEF>>>/.exec(user)?.[1]?.trim() ?? "";
  return {
    project: field("Project"),
    goal: field("Goal"),
    brief,
    // "Plan size: small (a short brief: …)" asks for one to three tasks (the intake's Size rules).
    smallProject: field("Plan size").startsWith("small"),
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

interface BriefParts {
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
  const targets = checker
    ? [`checks/${slug(brief.title)}.md`]
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
  if (askHit && !brief.answers && !did("ask_person")) {
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
    const writes = targets.map((path) => ({
      name: "write_file",
      input: {
        path,
        content: checker
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
          : contentFor(path, brief, seen),
      },
    }));
    return { text: `Writing ${targets.join(", ")}.`, toolCalls: writes };
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
  return text(report(brief, who, calls, req.tools));
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
    `Lesson: ${who} tasks in this project are small; one file per task keeps reviews quick.`,
  ];
  return lines.join("\n");
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
  const brief = section(evidence, "Brief");
  const workerReport = section(evidence, "Worker's final report");
  const changed = section(evidence, "Changed files")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  const subject = /^Subject: (.*)$/m.exec(evidence)?.[1] ?? "the work";
  const runId = req.origin?.runId ?? "no-run-id";
  // FORERUNNER_BENCH_CRITIC_REJECT matches the task's title, as FAIL and ASK do.
  const title = reviewedTitle(brief, workerReport, known) || subject;
  const rejectHit = matchesAny(title, opts.reject);
  const workerFailed = /could not complete this task|changed no file/i.test(workerReport);
  const reject = workerFailed || (rejectHit !== null && rejectThisReview(title, runId));
  const where = changed[0] ?? "the change";
  const review = reject
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
        summary: `${STAND_IN} Accepted: ${changed.length ? `${changed.length} changed file(s) match the brief` : "the report and the evidence match the brief"}.`,
        findings: [],
        criteria: criteria.map((c) => ({
          text: c,
          met: true,
          evidence: changed.length
            ? `read ${changed.slice(0, 3).join(", ")}`
            : "the worker's report",
        })),
        checks_run: [],
        evidence: changed.slice(0, 5),
      };
  const injected = reject && !workerFailed ? `critic_reject=${rejectHit}` : undefined;
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
  return `I was given ${earlier} earlier turn(s) of this conversation, ${projects.length} project(s) in the system prompt${active ? " with one marked active" : ""}, ${hasTasks ? "a task list" : "no task list"}, ${hasDocs ? "project doc excerpts" : "no project doc excerpts"}, ${hasLessons ? "lessons" : "no lessons"}, the facts ${factNames.length ? factNames.join(", ") : "(none)"}, and ${tools} command tool(s).`;
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
