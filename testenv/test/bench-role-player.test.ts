import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
// Test-only relative imports: the stand-in must satisfy the runtime's own parsers.
import { SubmitReviewSchema } from "../../packages/critic/src/schema.ts";
import { parseIntakeReply } from "../../packages/runtime/src/session/intake.ts";
import { shapeProjectPlan } from "../../packages/runtime/src/session/project-plan.ts";
import type { ModelCallRecord as ModelRecord } from "../src/bench/call-log.ts";
import {
  benchOptionsFromEnv,
  createRolePlayer,
  detectRole,
  ModelCallLog,
  reviewedTitle,
  STAND_IN,
  withModelCallLog,
} from "../src/bench/index.ts";
import type {
  ChatMessage,
  ContentBlock,
  ModelProvider,
  ModelRequest,
  StreamEvent,
  ToolDefinition,
} from "../src/provider/types.ts";

const REGISTRY = join(import.meta.dirname, "..", "..", "evals", "registry", "specialists");

function tempLog(secrets: string[] = []): ModelCallLog {
  const dir = mkdtempSync(join(tmpdir(), "fr-bench-"));
  return new ModelCallLog({ file: join(dir, "bench", "model-calls.jsonl"), secrets });
}

function lines(log: ModelCallLog): ModelRecord[] {
  return readFileSync(log.file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ModelRecord);
}

function player(env: Record<string, string> = {}, log = tempLog()) {
  return {
    log,
    p: createRolePlayer(benchOptionsFromEnv({ FORERUNNER_BENCH_DELAY_MS: "0", ...env }, log)),
  };
}

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  input_schema: { type: "object" },
});

async function call(p: ModelProvider, req: ModelRequest) {
  const events: StreamEvent[] = [];
  for await (const ev of p.stream(req)) events.push(ev);
  const text = events
    .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  const toolUses = events.filter(
    (e): e is Extract<StreamEvent, { type: "tool_use_end" }> => e.type === "tool_use_end",
  );
  const starts = events.filter(
    (e): e is Extract<StreamEvent, { type: "tool_use_start" }> => e.type === "tool_use_start",
  );
  const end = events.at(-1);
  return {
    events,
    text,
    calls: toolUses.map((t, i) => ({ id: t.id, name: starts[i]?.name ?? "", input: t.input })),
    end,
  };
}

const BRIEF =
  "A one-page website that shows a random quote each time it is opened; plain HTML, CSS and JavaScript; no build step";

function intakeRequest(): ModelRequest {
  return {
    model: "fake-sonnet",
    system:
      "You are the project manager.\n\n## Intake\n\nReply with ONE JSON object ... firstSession ...",
    messages: [
      {
        role: "user",
        content: [
          "Project: Quote page",
          "Goal: A page with a random quote",
          "Stage: idea",
          "Repositories: none",
          "Small-project mode: off",
          "",
          "Brief (data, between the markers):",
          "<<<BRIEF",
          BRIEF,
          "",
          "BRIEF>>>",
          "",
          "Reply with the JSON object now.",
        ].join("\n"),
      },
    ],
    max_tokens: 8000,
    origin: { label: "intake p1", sessionId: "s1", runId: "r1" },
  };
}

/** A specialist run driven step by step, feeding back the given tool results. */
async function runSpecialist(
  p: ModelProvider,
  opts: {
    specialist: string;
    title: string;
    outcome: string;
    criteria: string[];
    tools: string[];
    results?: (
      name: string,
      input: Record<string, unknown>,
    ) => { content: string; isError?: boolean };
    runId?: string;
    extra?: string;
  },
) {
  const brief = [
    "# Task brief",
    "## Goal",
    `${opts.title}: ${opts.outcome}`,
    "## Context",
    "- task:t1",
    "## Constraints",
    "- Stay inside the worktree and the allowed tools.",
    "## Acceptance criteria (the critic checks each)",
    ...opts.criteria.map((c, i) => `${i + 1}. ${c}`),
    "## Limits",
    "- Budget: USD 1.00 (hard cap, enforced)",
    opts.extra ?? "",
  ].join("\n");
  const messages: ChatMessage[] = [{ role: "user", content: brief }];
  const steps: { text: string; calls: { name: string; input: Record<string, unknown> }[] }[] = [];
  for (let turn = 0; turn < 10; turn++) {
    const r = await call(p, {
      model: "fake-sonnet",
      system: `You are the ${opts.specialist} specialist of Forerunner.`,
      messages: [...messages],
      tools: opts.tools.map(tool),
      max_tokens: 4000,
      origin: {
        label: `${opts.specialist} on ${opts.title}`,
        sessionId: "s1",
        runId: opts.runId ?? "run1",
      },
    });
    steps.push({ text: r.text, calls: r.calls });
    if (r.end?.type !== "message_end" || r.calls.length === 0) return { steps, last: r };
    const content: ContentBlock[] = [
      ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
      ...r.calls.map((c) => ({
        type: "tool_use" as const,
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    ];
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: r.calls.map((c) => {
        const res = opts.results?.(c.name, c.input) ?? { content: "ok" };
        return {
          type: "tool_result" as const,
          tool_use_id: c.id,
          content: res.content,
          ...(res.isError ? { is_error: true } : {}),
        };
      }),
    });
  }
  throw new Error("specialist run did not end");
}

describe("bench role-player: intake", () => {
  it("plans 3-6 tasks the runtime's intake parser and plan writer accept", async () => {
    const { p, log } = player();
    const r = await call(p, intakeRequest());
    const proposal = parseIntakeReply(r.text);
    const tasks = proposal.plan.milestones.flatMap((m) => m.tasks);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.length).toBeLessThanOrEqual(6);
    const known = new Set([...readdirSync(REGISTRY), "person"]);
    for (const t of tasks) expect(known.has(t.specialist ?? "coder")).toBe(true);
    expect(tasks.some((t) => t.dependsOn.length > 0)).toBe(true);
    expect(Object.keys(proposal.docs).some((d) => d.startsWith("docs/decisions/0001-"))).toBe(true);
    expect(tasks.map((t) => t.title).join("\n")).toMatch(/index\.html/);
    // The plan writer shapes it (no cycle, keys resolve).
    expect(
      shapeProjectPlan(proposal.plan, { name: "Quote page", small_project_mode: false }).milestones,
    ).toHaveLength(1);
    const rec = lines(log)[0];
    expect(rec?.role).toBe("intake");
    expect(rec?.system).toContain("## Intake");
    expect(rec?.messages[0]?.content).toContain(BRIEF);
  });

  it("plans a seven-task chain, a person task and a tier 2 task when asked", async () => {
    const { p } = player({
      FORERUNNER_BENCH_PLAN: "chain",
      FORERUNNER_BENCH_PERSON: "1",
      FORERUNNER_BENCH_RISK2: "styles.css",
    });
    const proposal = parseIntakeReply((await call(p, intakeRequest())).text);
    const tasks = proposal.plan.milestones.flatMap((m) => m.tasks);
    expect(tasks.filter((t) => t.specialist !== "person")).toHaveLength(7);
    expect(
      tasks
        .find((t) => t.specialist === "person")
        ?.acceptanceCriteria.every((q) => q.endsWith("?")),
    ).toBe(true);
    expect(tasks.find((t) => t.title.includes("styles.css"))?.riskTier).toBe(2);
    expect(tasks.find((t) => t.key === "step3")?.dependsOn).toEqual(["step2"]);
  });

  it("plants a malformed plan or a failed planning call", async () => {
    const bad = player({ FORERUNNER_BENCH_INTAKE: "malformed" });
    expect(() => parseIntakeReply("")).toThrow();
    const r = await call(bad.p, intakeRequest());
    expect(() => parseIntakeReply(r.text)).toThrow(/not a JSON object/);
    const err = player({ FORERUNNER_BENCH_INTAKE: "error" });
    expect((await call(err.p, intakeRequest())).end?.type).toBe("error");
  });
});

describe("bench role-player: specialists", () => {
  it("looks, writes real files through the app's tools, checks them and reports", async () => {
    const { p } = player();
    const run = await runSpecialist(p, {
      specialist: "coder",
      title: "Show a random quote on every load in script.js",
      outcome: "script.js holds at least ten quotes and puts a random one into the page.",
      criteria: ["script.js contains at least ten quotes with authors"],
      tools: ["read_file", "write_file", "list_dir", "run_command"],
      results: (name) =>
        name === "list_dir" ? { content: "index.html\nREADME.md" } : { content: "ok" },
    });
    const names = run.steps.flatMap((s) => s.calls.map((c) => c.name));
    expect(names).toEqual(["list_dir", "write_file", "run_command"]);
    const write = run.steps.flatMap((s) => s.calls).find((c) => c.name === "write_file");
    expect(write?.input.path).toBe("script.js");
    expect(String(write?.input.content)).toMatch(/QUOTES = \[/);
    expect(run.last.text).toContain(STAND_IN);
    expect(run.last.text).toMatch(/\*\*Files changed\*\*\n- script\.js/);
    expect(run.last.text).toMatch(/^Lesson: /m);
  });

  it("a README writer reads the folder first and writes from what it read", async () => {
    const { p } = player();
    const run = await runSpecialist(p, {
      specialist: "writer-marketing",
      title: "Write the README: what the page does and how to open it",
      outcome: "README.md says what the page does and how to open it.",
      criteria: ["README.md explains how to open index.html in a browser"],
      tools: ["read_file", "write_file", "list_dir"],
      results: (name, input) =>
        name === "list_dir"
          ? { content: "index.html\nscript.js\nREADME.md" }
          : name === "read_file" && input.path === "script.js"
            ? { content: "const QUOTES = [] // random quote" }
            : { content: "ok" },
    });
    const write = run.steps.flatMap((s) => s.calls).find((c) => c.name === "write_file");
    expect(write?.input.path).toBe("README.md");
    expect(String(write?.input.content)).toMatch(/random quote/);
  });

  it("FORERUNNER_BENCH_FAIL makes the run report it could not do the work, or fail the call", async () => {
    const report = player({ FORERUNNER_BENCH_FAIL: "script.js" });
    const r = await runSpecialist(report.p, {
      specialist: "coder",
      title: "Show a random quote in script.js",
      outcome: "x",
      criteria: ["a"],
      tools: ["list_dir", "write_file"],
    });
    expect(r.steps.flatMap((s) => s.calls.map((c) => c.name))).toEqual(["list_dir"]);
    expect(r.last.text).toMatch(/could not complete this task/);
    const rec = lines(report.log).at(-1);
    expect(rec?.injected).toMatch(/fail=script\.js/);

    const error = player({
      FORERUNNER_BENCH_FAIL: "script.js",
      FORERUNNER_BENCH_FAIL_MODE: "error",
    });
    const e = await runSpecialist(error.p, {
      specialist: "coder",
      title: "Show a random quote in script.js",
      outcome: "x",
      criteria: ["a"],
      tools: ["list_dir", "write_file"],
    });
    expect(e.last.end?.type).toBe("error");

    const once = player({ FORERUNNER_BENCH_FAIL: "script.js", FORERUNNER_BENCH_FAIL_TIMES: "1" });
    const spec = {
      specialist: "coder",
      title: "Show a random quote in script.js",
      outcome: "x",
      criteria: ["a"],
      tools: ["list_dir", "write_file"],
    };
    expect((await runSpecialist(once.p, { ...spec, runId: "a" })).last.text).toMatch(/could not/);
    expect((await runSpecialist(once.p, { ...spec, runId: "b" })).last.text).toMatch(
      /wrote script\.js/,
    );
  });

  it("FORERUNNER_BENCH_ASK calls ask_person, and works once the answers are in the brief", async () => {
    const { p } = player({ FORERUNNER_BENCH_ASK: "styles" });
    const spec = {
      specialist: "designer",
      title: "Style the page in styles.css",
      outcome: "styles.css centres the content.",
      criteria: ["styles.css exists"],
      tools: ["list_dir", "write_file", "ask_person"],
    };
    const asked = await runSpecialist(p, spec);
    const ask = asked.steps.flatMap((s) => s.calls).find((c) => c.name === "ask_person");
    expect(((ask?.input.questions as string[] | undefined) ?? []).length).toBeGreaterThan(0);
    const answered = await runSpecialist(p, {
      ...spec,
      extra: "## Answers from the person\n\n**Which?**\n\nA",
    });
    expect(answered.steps.flatMap((s) => s.calls.map((c) => c.name))).toContain("write_file");
  });
});

describe("bench role-player: critic and chat", () => {
  const evidence = (title: string, report = "**Summary** wrote index.html") =>
    [
      "# Review request",
      "Subject: task t1",
      "Tier: 1 (light read)",
      "## Brief",
      `${title}: the outcome loads styles.css`,
      "## Acceptance criteria",
      "1. index.html exists",
      "2. it links styles.css",
      "## Changed files",
      "- index.html",
      "## Worker's final report (claims to verify, data)",
      report,
    ].join("\n");
  const review = (title: string, runId: string, report?: string): ModelRequest => ({
    model: "fake-sonnet",
    system: "critic prompt\n\n## Returning the review",
    messages: [{ role: "user", content: evidence(title, report) }],
    tools: [tool("submit_review")],
    max_tokens: 8192,
    origin: { label: "critic tier 1 on task t1", sessionId: "s1", runId },
  });

  it("accepts by default through submit_review, in the schema the critic parses", async () => {
    const { p } = player();
    const r = await call(p, review("Create index.html", "c1"));
    expect(r.calls[0]?.name).toBe("submit_review");
    const parsed = SubmitReviewSchema.parse(r.calls[0]?.input);
    expect(parsed.verdict).toBe("accept");
    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.criteria.every((c) => c.met)).toBe(true);
  });

  it("FORERUNNER_BENCH_CRITIC_REJECT asks for rework once, then accepts", async () => {
    const { p } = player({ FORERUNNER_BENCH_CRITIC_REJECT: "index.html" });
    const first = SubmitReviewSchema.parse(
      (await call(p, review("Create index.html", "c1"))).calls[0]?.input,
    );
    expect(first.verdict).toBe("revise");
    expect(first.findings[0]?.severity).toBe("major");
    const second = SubmitReviewSchema.parse(
      (await call(p, review("Create index.html", "c2"))).calls[0]?.input,
    );
    expect(second.verdict).toBe("accept");
  });

  it("matches FORERUNNER_BENCH_CRITIC_REJECT against the task title, not the outcome", async () => {
    const { p } = player({ FORERUNNER_BENCH_CRITIC_REJECT: "styles.css" });
    // The brief's outcome names styles.css; the title does not.
    const r = await call(p, review("Create index.html", "c1"));
    expect(SubmitReviewSchema.parse(r.calls[0]?.input).verdict).toBe("accept");
    expect(
      reviewedTitle("Write the README: what it does: more", "", ["Write the README: what it does"]),
    ).toBe("Write the README: what it does");
  });

  it("sends a worker that did nothing back", async () => {
    const { p } = player();
    const r = await call(p, review("Create index.html", "c1", "I could not complete this task."));
    expect(SubmitReviewSchema.parse(r.calls[0]?.input).verdict).toBe("revise");
  });

  const chat = (text: string, tools: string[] = [], history: ChatMessage[] = []): ModelRequest => ({
    model: "fake-haiku",
    system: "You are the conversation agent.\n\n# Projects\n- Quote page (active): a page [id p1]",
    messages: [
      ...history,
      { role: "user", content: `# Now\n- now: x\n- active_project: p1\n\n${text}` },
    ],
    tools: tools.map(tool),
    max_tokens: 1024,
    origin: { label: "conversation", sessionId: "s", runId: "t" },
  });

  it("answers in one sentence that says what context it was given", async () => {
    const { p } = player();
    const r = await call(p, chat("what is going on?"));
    expect(r.text.startsWith(STAND_IN)).toBe(true);
    expect(r.text).toMatch(/0 earlier turn\(s\)/);
    expect(r.text).toMatch(/1 project\(s\).*marked active/);
    expect(r.text).toMatch(/no task list/);
    expect(detectRole(chat("x")).role).toBe("chat");
  });

  it("quotes back the plan's state and the first task it was told, as a real reply names them", async () => {
    const { p } = player();
    const told = (blocks: string) =>
      call(p, {
        ...chat("x"),
        messages: [
          {
            role: "user",
            content: `# Now\n- now: x\n\n${blocks}\n\nwhat is left to do?`,
          },
        ],
      });
    const failed = await told(
      "# Plan from the brief\nPlanning failed: Claude's plan was missing parts Forerunner needs. The person can press Try again on the project page.\n\n# Tasks of Quote page\n(no tasks yet)",
    );
    expect(failed.text).toContain(
      "The plan: Planning failed: Claude's plan was missing parts Forerunner needs.",
    );
    expect(failed.text).not.toContain("First task");
    const working = await told(
      '# Tasks of Quote page (run order; 1 of 2 done, 1 open)\n- "Build the quote page": Done; by the coder\n- "Write the README": Ready',
    );
    expect(working.text).toContain('First task: "Build the quote page": Done.');
    expect(working.text).not.toContain("The plan:");
  });

  it("calls a command tool for 'tool: <name> <json>' and reports its answer", async () => {
    const { p } = player();
    const r = await call(p, chat('tool: task_list {"project":"p1"}', ["task_list"]));
    expect(r.calls).toEqual([
      expect.objectContaining({ name: "task_list", input: { project: "p1" } }),
    ]);
    const follow = await call(p, {
      ...chat('tool: task_list {"project":"p1"}', ["task_list"]),
      messages: [
        ...chat('tool: task_list {"project":"p1"}').messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "task_list", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "3 tasks" }] },
      ],
    });
    expect(follow.text).toMatch(/task_list answered: 3 tasks/);
    expect((await call(p, chat("tool: nope {}", ["task_list"]))).text).toMatch(
      /no command tool named nope/,
    );
  });

  it("says so for a request it cannot place", async () => {
    const { p, log } = player();
    const r = await call(p, {
      model: "fake-haiku",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    expect(r.text).toMatch(/unrecognised role/);
    expect(lines(log)[0]?.role).toBe("unknown");
  });
});

describe("bench live mode: the logging wrapper", () => {
  const KEY = "sk-ant-api03-THIS_IS_NOT_A_REAL_KEY_0123456789"; // not-a-secret
  const inner: ModelProvider = {
    name: "anthropic",
    fastMode: true,
    listModels: async () => [{ provider: "anthropic", id: "claude-haiku-5-5", tier: "haiku" }],
    countTokens: (t) => t.length,
    async *stream(req) {
      yield { type: "message_start", model: req.model };
      // A provider that echoes the key must still not get it into the log.
      yield { type: "text_delta", text: `hello ${KEY}` };
      yield { type: "tool_use_start", id: "t1", name: "read_file" };
      yield { type: "tool_use_end", id: "t1", input: { path: "a.txt" } };
      yield {
        type: "message_end",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    },
    complete: async () => {
      throw new Error("not used");
    },
  };

  it("passes every event through unchanged and logs the request and the reply, never the key", async () => {
    const log = tempLog([KEY]);
    const wrapped = withModelCallLog(inner, log);
    expect(wrapped.name).toBe("anthropic");
    expect(wrapped.fastMode).toBe(true);
    const req: ModelRequest = {
      model: "claude-haiku-5-5",
      system: "You are the conversation agent.",
      messages: [{ role: "user", content: `# Now\n\nmy key is ${KEY}` }],
      tools: [tool("read_file")],
      max_tokens: 100,
      origin: { label: "conversation", sessionId: "s", runId: "r" },
    };
    const passed: StreamEvent[] = [];
    for await (const ev of wrapped.stream(req)) passed.push(ev);
    const direct: StreamEvent[] = [];
    for await (const ev of inner.stream(req)) direct.push(ev);
    expect(passed).toEqual(direct);
    const raw = readFileSync(log.file, "utf8");
    expect(raw).not.toContain(KEY);
    const rec = JSON.parse(raw.trim()) as ModelRecord;
    expect(rec.mode).toBe("live");
    expect(rec.role).toBe("chat");
    expect(rec.tools).toEqual(["read_file"]);
    expect(rec.reply.toolCalls).toEqual([{ name: "read_file", input: { path: "a.txt" } }]);
    expect(rec.reply.text).toContain("hello [REDACTED]");
    const response = await wrapped.complete(req);
    expect(response.stop_reason).toBe("tool_use");
    expect(lines(log)).toHaveLength(2);
  });

  it("logs a call that throws and rethrows it", async () => {
    const log = tempLog();
    const failing = withModelCallLog(
      {
        ...inner,
        // biome-ignore lint/correctness/useYield: a stream that fails before its first event
        async *stream() {
          throw new Error("network down");
        },
      },
      log,
    );
    await expect(async () => {
      for await (const _ of failing.stream({ model: "m", messages: [], max_tokens: 1 })) void _;
    }).rejects.toThrow(/network down/);
    expect(lines(log)[0]?.reply.error?.message).toBe("network down");
  });
});
