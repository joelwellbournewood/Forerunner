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
  filesNamed,
  judgeCriterion,
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

function intakeRequest(small = false): ModelRequest {
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
          small
            ? "Plan size: small (a short brief: see Size in your instructions)"
            : "Plan size: what the brief needs",
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

  it('asked for "Plan size: small" plans one to three tasks, a README and the decision only, and leaves the review level to Forerunner', async () => {
    const { p } = player();
    const proposal = parseIntakeReply((await call(p, intakeRequest(true))).text);
    const tasks = proposal.plan.milestones.flatMap((m) => m.tasks);
    expect(proposal.plan.milestones).toHaveLength(1);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.length).toBeLessThanOrEqual(3);
    expect(tasks.map((t) => t.specialist)).not.toContain("writer-marketing");
    // No task names a tier: the project's default (light review) applies, so the critic reviews.
    expect(tasks.map((t) => t.riskTier)).toEqual(tasks.map(() => undefined));
    expect(Object.keys(proposal.docs).sort()).toEqual([
      "README.md",
      "docs/decisions/0001-plain-static-page.md",
    ]);
    expect(proposal.docs["docs/decisions/0001-plain-static-page.md"]).toMatch(
      /^# 0001: .*\n\nDecision: /,
    );
    // Every task a specialist does has an estimate, in run order.
    expect(proposal.firstSession.items.map((i) => i.key)).toEqual(tasks.map((t) => t.key));
  });

  /** The intake's one retry: the first request, the refused reply, what was wrong. */
  const retryOf = (first: ModelRequest, reply: string): ModelRequest => ({
    ...first,
    messages: [
      ...first.messages,
      { role: "assistant", content: reply },
      { role: "user", content: "Forerunner could not use your reply:\n- plan: ..." },
    ],
  });

  it("FORERUNNER_BENCH_INTAKE_BAD plants the live model's bad first replies; the retry gets a plan", async () => {
    // missing-tasks: refused by the reader, so the intake asks once more.
    const missing = player({ FORERUNNER_BENCH_INTAKE_BAD: "missing-tasks" });
    const first = await call(missing.p, intakeRequest());
    expect(() => parseIntakeReply(first.text)).toThrow(/has no task/);
    const again = await call(missing.p, retryOf(intakeRequest(), first.text));
    expect(
      parseIntakeReply(again.text).plan.milestones.flatMap((m) => m.tasks).length,
    ).toBeGreaterThan(0);
    expect(lines(missing.log).map((l) => l.injected ?? null)).toEqual([
      "intake-bad=missing-tasks",
      null,
    ]);
    // reason-too-long: the live reply's 754-character reason; read, the reason shortened.
    const long = player({ FORERUNNER_BENCH_INTAKE_BAD: "reason-too-long" });
    const text = (await call(long.p, intakeRequest())).text;
    expect((JSON.parse(text) as { plan: { reason: string } }).plan.reason.length).toBeGreaterThan(
      500,
    );
    const read = parseIntakeReply(text);
    expect(read.plan.reason.length).toBeLessThanOrEqual(500);
    expect(read.plan.reason).toMatch(/ …$/);
    // fenced-docs: docs that hold code fences (the old reader took a doc's snippet for the reply).
    const fenced = player({ FORERUNNER_BENCH_INTAKE_BAD: "fenced-docs" });
    const withFences = (await call(fenced.p, intakeRequest())).text;
    expect(withFences).toContain("```");
    expect(Object.values(parseIntakeReply(withFences).docs).join("\n")).toContain("```json");
    // not-json: prose first; the retry gets the plan.
    const prose = player({ FORERUNNER_BENCH_INTAKE_BAD: "not-json" });
    const said = (await call(prose.p, intakeRequest())).text;
    expect(() => parseIntakeReply(said)).toThrow(/not a JSON object/);
    const fixed = (await call(prose.p, retryOf(intakeRequest(), said))).text;
    expect(() => parseIntakeReply(fixed)).not.toThrow();
    // too-big: asked for a small plan, the full plan first (the live model's six tasks); the
    // retry, asked for the size, gets the small plan.
    const big = player({ FORERUNNER_BENCH_INTAKE_BAD: "too-big" });
    const full = (await call(big.p, intakeRequest(true))).text;
    expect(parseIntakeReply(full).plan.milestones.flatMap((m) => m.tasks).length).toBeGreaterThan(
      3,
    );
    const small = (await call(big.p, retryOf(intakeRequest(true), full))).text;
    const smallTasks = parseIntakeReply(small).plan.milestones.flatMap((m) => m.tasks);
    expect(smallTasks.length).toBeGreaterThanOrEqual(1);
    expect(smallTasks.length).toBeLessThanOrEqual(3);
    expect(lines(big.log).map((l) => l.injected ?? null)).toEqual(["intake-bad=too-big", null]);
  });

  /**
   * An intake request after "Change the plan" (design §3.3): the brief, then the person's
   * words, as the intake writes them (`briefWithChanges` in packages/runtime/src/session/intake.ts).
   */
  const changedRequest = (brief: string, changes: string[]): ModelRequest => {
    const asked =
      changes.length === 1
        ? `${brief}\n\nThe person read the first plan and asked for this change: ${changes[0]}`
        : `${brief}\n\nThe person read the earlier plans and asked for these changes, in order; the later one wins where they differ:\n${changes.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    const first = intakeRequest(true);
    return {
      ...first,
      messages: [
        {
          role: "user",
          content: String(first.messages[0]?.content).replace(BRIEF, asked),
        },
      ],
    };
  };
  const titlesOf = (text: string) =>
    parseIntakeReply(text).plan.milestones.flatMap((m) => m.tasks.map((t) => t.title));

  it("Change the plan: the stand-in reads the person's words, drops and adds the tasks they name and says what it did (bench, phase E)", async () => {
    const { p } = player();
    const before = titlesOf((await call(p, intakeRequest(true))).text);
    expect(before.some((t) => /^Check /.test(t))).toBe(true);
    expect(before.some((t) => /README/.test(t))).toBe(false);
    const r = await call(p, changedRequest(BRIEF, ["drop the check and add a README task"]));
    const proposal = parseIntakeReply(r.text);
    const tasks = proposal.plan.milestones.flatMap((m) => m.tasks);
    const after = tasks.map((t) => t.title);
    // The check is gone; a README task is there; the rest of the plan is as before.
    expect(after.some((t) => /check/i.test(t))).toBe(false);
    expect(after.filter((t) => /README/.test(t))).toHaveLength(1);
    expect(after).toContain(before[0]);
    expect(tasks.find((t) => /README/.test(t.title))?.dependsOn).toEqual([tasks[0]?.key]);
    // The plan writer takes it, and every task an agent does has its estimate.
    expect(
      shapeProjectPlan(proposal.plan, { name: "Quote page", small_project_mode: false }).milestones,
    ).toHaveLength(1);
    expect(proposal.firstSession.items.map((i) => i.key)).toEqual(tasks.map((t) => t.key));
    // What it did is in the plan's reason, in words.
    expect(proposal.plan.reason).toMatch(/removed "Check that index\.html/);
    expect(proposal.plan.reason).toMatch(/added "Write the README/);
  });

  it("Change the plan: later changes win, words it cannot place leave the plan as it was and are named, the last task is never dropped", async () => {
    const { p } = player();
    const plain = titlesOf((await call(p, intakeRequest(true))).text);
    // In order: the README is added, then dropped again.
    const both = parseIntakeReply(
      (await call(p, changedRequest(BRIEF, ["add a README task", "remove the README"]))).text,
    );
    expect(both.plan.milestones.flatMap((m) => m.tasks.map((t) => t.title))).toEqual(plain);
    // Words that name no task and no verb it knows: the same plan, and the reason says so.
    const vague = parseIntakeReply(
      (await call(p, changedRequest(BRIEF, ["A single index.html only."]))).text,
    );
    expect(vague.plan.milestones.flatMap((m) => m.tasks.map((t) => t.title))).toEqual(plain);
    expect(vague.plan.reason).toContain('could not place "A single index.html only."');
    // Anything else it is asked to add becomes a task with the person's words as its title.
    const dark = parseIntakeReply(
      (await call(p, changedRequest(BRIEF, ["Add a dark mode."]))).text,
    );
    expect(dark.plan.milestones.flatMap((m) => m.tasks.map((t) => t.title))).toEqual([
      ...plain,
      "Add a dark mode",
    ]);
    // A change that would leave no task keeps the last one and says why.
    const all = parseIntakeReply(
      (await call(p, changedRequest(BRIEF, ["drop the check, remove the page"]))).text,
    );
    const left = all.plan.milestones.flatMap((m) => m.tasks);
    expect(left).toHaveLength(1);
    expect(left[0]?.dependsOn).toEqual([]);
    expect(all.plan.reason).toMatch(/kept .* so the plan has a task/);
  });

  it("FORERUNNER_BENCH_PLAN=research adds a researcher task whose brief names a web address (bench, phase E, C-73)", async () => {
    const { p } = player({ FORERUNNER_BENCH_PLAN: "research" });
    const tasks = parseIntakeReply(
      (await call(p, intakeRequest(true))).text,
    ).plan.milestones.flatMap((m) => m.tasks);
    const research = tasks.find((t) => t.specialist === "researcher");
    expect(research?.title).toMatch(/research\/notes\.md/);
    expect(`${research?.outcome}`).toMatch(/https:\/\//);
    expect(tasks.length).toBeLessThanOrEqual(3);
    // With chain: the seven steps and the research task.
    const chained = player({ FORERUNNER_BENCH_PLAN: "chain,research" });
    const seven = parseIntakeReply(
      (await call(chained.p, intakeRequest())).text,
    ).plan.milestones.flatMap((m) => m.tasks);
    expect(seven.map((t) => t.specialist)).toContain("researcher");
    expect(seven.filter((t) => t.key?.startsWith("step"))).toHaveLength(7);
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

  it("a tester whose title names a test file writes it beside its notes, so the plan's criterion can be met (C-10)", async () => {
    const { p } = player();
    const run = await runSpecialist(p, {
      specialist: "tester",
      title: "Add a check for src/main.js in test/main.test.js",
      outcome: "test/main.test.js checks the main behaviour of src/main.js.",
      criteria: ["node --check passes on test/main.test.js"],
      tools: ["read_file", "write_file", "list_dir", "run_command"],
      results: (name) =>
        name === "list_dir" ? { content: "src/main.js\nREADME.md" } : { content: "ok" },
    });
    const writes = run.steps
      .flatMap((s) => s.calls)
      .filter((c) => c.name === "write_file")
      .map((c) => String(c.input.path));
    expect(writes).toEqual([
      "test/main.test.js",
      "checks/add-a-check-for-src-main-js-in-test-main.md",
    ]);
    // A tester whose title names no test file writes its notes only, as before.
    const notes = await runSpecialist(p, {
      specialist: "tester",
      title: "Check that index.html, styles.css and script.js work together",
      outcome: "A short check confirms the three files load together without errors.",
      criteria: ["Every file index.html references exists"],
      tools: ["read_file", "write_file", "list_dir", "run_command"],
      results: (name) => (name === "list_dir" ? { content: "index.html" } : { content: "ok" }),
      runId: "run2",
    });
    expect(
      notes.steps
        .flatMap((s) => s.calls)
        .filter((c) => c.name === "write_file")
        .map((c) => String(c.input.path)),
    ).toEqual(["checks/check-that-index-html-styles-css-and-scr.md"]);
  });

  it("a researcher offered web_fetch reads the pages its brief names and writes from them, citing each (ADR 0107)", async () => {
    const { p } = player();
    const url = "https://gohugo.io/about/";
    const refused = "http://10.0.0.7/admin";
    const run = await runSpecialist(p, {
      specialist: "researcher",
      title: "Compare two static site generators",
      outcome: `docs/research.md says how fast Hugo builds, citing ${url} and ${refused}.`,
      criteria: ["Every claim cites its page"],
      tools: ["read_file", "write_file", "list_dir", "web_fetch"],
      results: (name, input) =>
        name === "web_fetch"
          ? input.url === url
            ? {
                content: `${url} (HTTP 200, "About Hugo")\n\nHugo builds a 10,000-page site in about 2 seconds.\nLinks (1):`,
              }
            : {
                content:
                  "ERROR: Refused: 10.0.0.7 is a private or local network address; research reads public web pages only.",
                isError: true,
              }
          : { content: name === "list_dir" ? "(empty)" : "ok" },
    });
    const names = run.steps.flatMap((s) => s.calls.map((c) => c.name));
    expect(names).toEqual(["list_dir", "web_fetch", "web_fetch", "write_file"]);
    const write = run.steps.flatMap((s) => s.calls).find((c) => c.name === "write_file");
    expect(write?.input.path).toBe("docs/research.md");
    const text = String(write?.input.content);
    expect(text).toContain(`- "Hugo builds a 10,000-page site in about 2 seconds." (${url})`);
    expect(text).toContain(`- ${refused} was not read: Refused: 10.0.0.7 is a private`);
    expect(text).toContain(`## Sources read\n\n- ${url}\n- ${refused} (not read)`);
    expect(run.last.text).toContain(`**Sources read**\n- ${url}\n- ${refused}: not read (Refused:`);
    // Without the page reader it reads nothing and writes as before.
    const plain = await runSpecialist(player().p, {
      specialist: "researcher",
      title: "Compare two static site generators",
      outcome: `docs/research.md says how fast Hugo builds, citing ${url}.`,
      criteria: ["Every claim cites its page"],
      tools: ["read_file", "write_file", "list_dir"],
      results: (name) => ({ content: name === "list_dir" ? "(empty)" : "ok" }),
    });
    expect(plain.steps.flatMap((s) => s.calls.map((c) => c.name))).toEqual([
      "list_dir",
      "write_file",
    ]);
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

  it("FORERUNNER_BENCH_ASK_STYLE=plain works with a placeholder and asks in its report's last lines, one question per line without bullets (live L-2)", async () => {
    const { p } = player({
      FORERUNNER_BENCH_ASK: "Home page",
      FORERUNNER_BENCH_ASK_STYLE: "plain",
    });
    const spec = {
      specialist: "coder",
      title: "Home page in index.html",
      outcome: "index.html shows the club's name.",
      criteria: ["index.html exists"],
      tools: ["list_dir", "write_file", "ask_person"],
    };
    const asked = await runSpecialist(p, spec);
    const names = asked.steps.flatMap((s) => s.calls.map((c) => c.name));
    expect(names).toContain("write_file");
    expect(names).not.toContain("ask_person");
    const report = asked.last.text;
    expect(report).toMatch(/^\*\*Summary\*\*: /);
    expect(report).toContain(
      '- The name in "Home page in index.html" is a placeholder, because the brief gave no real one.',
    );
    expect(report).toContain(
      '**Questions for the person:**\nWhat is the real name to show in "Home page in index.html"?\nIs there anything this must not change?\n',
    );
    // "Go ahead without" in the brief: no question again.
    const without = await runSpecialist(p, {
      ...spec,
      extra:
        "## Answers from the person\n\nThe person chose to go ahead without answering the questions asked about this task.",
    });
    expect(without.last.text).not.toContain("Questions for the person");
  });

  it("FORERUNNER_BENCH_ASK_STYLE=bullets asks with '- ' items after a '**Summary**:' heading (live L-12)", async () => {
    const { p } = player({
      FORERUNNER_BENCH_ASK: "Contact",
      FORERUNNER_BENCH_ASK_STYLE: "bullets",
    });
    const asked = await runSpecialist(p, {
      specialist: "coder",
      title: "Contact page in contact.html",
      outcome: "contact.html gives the address.",
      criteria: ["contact.html exists"],
      tools: ["list_dir", "write_file"],
    });
    expect(asked.last.text).toContain(
      '**Questions for the person:**\n- What is the real name to show in "Contact page in contact.html"?\n- Is there anything this must not change?',
    );
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

  it("its summary follows the writing rules: no '(s)', and the verb agrees with the count (bench, phase E)", async () => {
    // The Reviews tab read "Accepted: 1 changed file match the brief." (design §5 rule 6).
    const { p } = player();
    const one = SubmitReviewSchema.parse(
      (await call(p, review("Create index.html", "c1"))).calls[0]?.input,
    );
    expect(one.summary).toBe(`${STAND_IN} Accepted: the changed file matches the brief.`);
    const two = SubmitReviewSchema.parse(
      (
        await call(p, {
          ...review("Create index.html", "c2"),
          messages: [
            {
              role: "user",
              content: evidence("Create index.html").replace(
                "- index.html",
                "- index.html\n- styles.css",
              ),
            },
          ],
        })
      ).calls[0]?.input,
    );
    expect(two.summary).toBe(`${STAND_IN} Accepted: the 2 changed files match the brief.`);
    for (const s of [one.summary, two.summary]) expect(s).not.toContain("(s)");
  });

  /**
   * C-10: the stand-in critic marked every criterion met ("The page links styles.css: met")
   * whatever the work did, so a walk's drawer could say met where the try said the file was
   * missing. It reads the files the criteria name and marks a criterion met only when a changed
   * or read file shows it; one it cannot check says so.
   */
  const reviewWithReads = async (
    p: ModelProvider,
    criteria: string[],
    changed: string[],
    files: Record<string, string | null>,
    runId = "c-read",
  ) => {
    const content = [
      "# Review request",
      "Subject: task t1",
      "Tier: 1 (light read)",
      "## Brief",
      "Create index.html: the page",
      "## Acceptance criteria",
      ...criteria.map((c, i) => `${i + 1}. ${c}`),
      "## Changed files",
      ...changed.map((f) => `- ${f}`),
      "## Worker's final report (claims to verify, data)",
      "**Summary** wrote index.html",
    ].join("\n");
    const req = (messages: ChatMessage[]): ModelRequest => ({
      model: "fake-sonnet",
      system: "critic prompt\n\n## Returning the review",
      messages,
      tools: [tool("submit_review"), tool("read_file")],
      max_tokens: 8192,
      origin: { label: "critic tier 1 on task t1", sessionId: "s1", runId },
    });
    const messages: ChatMessage[] = [{ role: "user", content }];
    const first = await call(p, req(messages));
    const reads = first.calls.filter((c) => c.name === "read_file");
    messages.push({
      role: "assistant",
      content: first.calls.map((c) => ({
        type: "tool_use" as const,
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    });
    messages.push({
      role: "user",
      content: reads.map((c) => {
        const text = files[String(c.input.path)];
        return {
          type: "tool_result" as const,
          tool_use_id: c.id,
          content: text ?? `ERROR: ${String(c.input.path)} does not exist`,
          ...(text === null || text === undefined ? { is_error: true } : {}),
        };
      }),
    });
    const second = await call(p, req(messages));
    return {
      read: reads.map((c) => String(c.input.path)),
      review: SubmitReviewSchema.parse(second.calls.find((c) => c.name === "submit_review")?.input),
    };
  };

  it("reads the files the criteria name and marks a criterion met only when a changed or read file shows it (C-10)", async () => {
    const { p } = player();
    const criteria = [
      "index.html exists and is valid HTML5",
      "index.html links styles.css",
      "The text is readable on a narrow screen",
    ];
    // The page links no stylesheet and styles.css was never written: the live drawer said met.
    const missing = await reviewWithReads(p, criteria, ["index.html"], {
      "index.html": "<!doctype html><title>Page</title>",
      "styles.css": null,
    });
    expect(missing.read).toEqual(["index.html", "styles.css"]);
    expect(missing.review.criteria).toEqual([
      expect.objectContaining({ text: criteria[0], met: true }),
      { text: criteria[1], met: false, evidence: "index.html does not name styles.css" },
      {
        text: criteria[2],
        met: true,
        evidence: "not checked by the stand-in: the criterion names no file",
      },
    ]);
    // An unmet criterion is not accepted: it is sent back with the criterion named.
    expect(missing.review.verdict).toBe("revise");
    expect(missing.review.findings[0]?.what).toContain(criteria[1]);
    // The page that links it, with the file there: met, and accepted.
    const shown = await reviewWithReads(
      p,
      criteria,
      ["index.html", "styles.css"],
      {
        "index.html": '<link rel="stylesheet" href="styles.css" />',
        "styles.css": "body {}",
      },
      "c-read-2",
    );
    expect(shown.review.criteria[1]).toEqual({
      text: criteria[1],
      met: true,
      evidence: "read index.html: it names styles.css",
    });
    expect(shown.review.verdict).toBe("accept");
    // A file a criterion names that is not in the folder at all.
    const absent = await reviewWithReads(
      p,
      ["data/members.csv has a row per year"],
      ["notes/x.md"],
      { "notes/x.md": "# x", "data/members.csv": null },
      "c-read-3",
    );
    expect(absent.review.criteria[0]).toEqual({
      text: "data/members.csv has a row per year",
      met: false,
      evidence: "data/members.csv is not in the task's folder",
    });
  });

  it("names in a criterion: a dotted test file is a file, a technology's name is not (C-10)", () => {
    expect(filesNamed("node --check passes on test/main.test.js")).toEqual(["test/main.test.js"]);
    expect(filesNamed("docs/research.md says which Node.js Eleventy needs")).toEqual([
      "docs/research.md",
    ]);
    expect(judgeCriterion("Eleventy runs on Node.js 18", ["docs/research.md"], [])).toEqual({
      text: "Eleventy runs on Node.js 18",
      met: true,
      evidence: "not checked by the stand-in: the criterion names no file",
    });
    // A file it neither changed nor read is not checked, never "met" on no evidence.
    expect(judgeCriterion("styles.css exists", ["index.html"], []).evidence).toBe(
      "not checked by the stand-in: it did not read styles.css",
    );
  });

  it("FORERUNNER_BENCH_MISSING still plays the live critic's accept, and says it did not check (C-10)", async () => {
    const { p } = player({ FORERUNNER_BENCH_MISSING: "Create index.html" });
    const r = await reviewWithReads(p, ["data/members.csv has a row per year"], ["notes/x.md"], {
      "notes/x.md": "# x",
      "data/members.csv": null,
    });
    expect(r.review.verdict).toBe("accept");
    expect(r.review.criteria[0]?.evidence).toMatch(/^not checked by the stand-in/);
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
    // Plural words as the number says (design §5 rule 6): the reply is shown in the chat.
    expect(r.text).toMatch(/no earlier turn of this conversation/);
    expect(r.text).toMatch(/1 project in the system prompt.*marked active/);
    expect(r.text).toMatch(/no task list/);
    expect(r.text).toMatch(/and no command tool\.$/);
    expect(r.text).not.toContain("(s)");
    const later = await call(
      p,
      chat(
        "and now?",
        ["task_list", "task_add"],
        [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      ),
    );
    expect(later.text).toMatch(/1 earlier turn of this conversation/);
    expect(later.text).toMatch(/and 2 command tools\.$/);
    expect(later.text).not.toContain("(s)");
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

describe("bench role-player: the prompt cache ('cost', L-15)", () => {
  // A coder's run as the agent loop sends it: the conversation marked for caching.
  const system = `You are the coder specialist of Forerunner. ${"Follow the brief. ".repeat(200)}`;
  const brief: ChatMessage = { role: "user", content: "# Task brief\n## Goal\nWrite index.html" };
  const step = (n: number): ChatMessage[] => [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${n}`, name: "read_file", input: { path: `f${n}` } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${n}`, content: `file ${n} `.repeat(300) }],
    },
  ];
  const request = (messages: ChatMessage[], cache?: ModelRequest["cache"]): ModelRequest => ({
    model: "fake-sonnet",
    system,
    messages,
    tools: [tool("read_file"), tool("write_file")],
    max_tokens: 4096,
    ...(cache ? { cache } : {}),
    origin: { label: "coder on Write index.html", sessionId: "s1", runId: "run-cache" },
  });
  const usageOf = (r: Awaited<ReturnType<typeof call>>) =>
    r.end?.type === "message_end" ? r.end.usage : undefined;

  it("reads what the call before sent, more each call, and the log says what was marked", async () => {
    const { p, log } = player();
    const all = { system: true, tools: true, messages: true };
    const first = usageOf(await call(p, request([brief], all)));
    const second = usageOf(await call(p, request([brief, ...step(1)], all)));
    const third = usageOf(await call(p, request([brief, ...step(1), ...step(2)], all)));
    expect(first?.cache_read_input_tokens).toBe(0);
    expect(first?.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(second?.cache_read_input_tokens).toBeGreaterThanOrEqual(
      (first?.cache_creation_input_tokens ?? 0) + (first?.cache_read_input_tokens ?? 0),
    );
    expect(third?.cache_read_input_tokens).toBeGreaterThan(second?.cache_read_input_tokens ?? 0);
    // The last breakpoint is the last block: no plain input after it.
    expect(third?.input_tokens).toBe(0);
    const recs = lines(log);
    expect(recs.map((r) => r.cache)).toEqual([all, all, all]);
    expect(recs.map((r) => r.reply.usage?.cache_read_input_tokens)).toEqual([
      0,
      second?.cache_read_input_tokens,
      third?.cache_read_input_tokens,
    ]);
  });

  it("a request that marks nothing is plain input, and its log line has no cache field", async () => {
    const { p, log } = player();
    const u = usageOf(await call(p, request([brief])));
    expect(u?.cache_read_input_tokens).toBe(0);
    expect(u?.cache_creation_input_tokens).toBe(0);
    expect(u?.input_tokens).toBeGreaterThan(0);
    expect(lines(log)[0]?.cache).toBeUndefined();
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
