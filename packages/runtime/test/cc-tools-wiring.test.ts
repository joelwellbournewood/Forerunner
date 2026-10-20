import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, dirname, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/agent/loop.ts";
import { composeRuntime, type RuntimeApp, TOOL_UNMAPPED_AUDIT } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { LoopTaskExecutor, planItemFor } from "../src/session/executor.ts";
import { flatPricing, ScriptedProvider } from "./helpers.ts";

/**
 * The daemon's loop path offers a registry specialist the built-in equivalents of its Claude
 * Code tools (ADR 0043): `composeRuntime` on a registry copy whose coder names `cc:Read`,
 * `cc:Edit` and `cc:Glob`, one task through the `LoopTaskExecutor` with the fake provider
 * calling `read_file`, `write_file` and `run_command`, the hooks allowing the first two and
 * refusing the command, every decision an audit row; a name the loop driver cannot offer is
 * dropped at compose with its own audit row. Fake provider, `sqlite::memory:`, SimulatedClock.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const CODER_TOOLS = ["cc:Read", "cc:Edit", "cc:Glob"];

/** The repository registry with the coder on three Claude Code tools and a widget naming cc:WebFetch. */
function patchedRegistry(root: string): string {
  const dir = join(root, "registry");
  cpSync(REGISTRY, dir, { recursive: true });
  const coder = join(dir, "specialists", "coder", "specialist.md");
  const text = readFileSync(coder, "utf8")
    .replace(
      /allowed_tools:\n(?: {2}- .*\n)+/,
      `allowed_tools:\n${CODER_TOOLS.map((t) => `  - ${t}`).join("\n")}\n`,
    )
    .replace("requires_sandbox: true", "requires_sandbox: false");
  writeFileSync(coder, text, "utf8");
  const widget = join(dir, "specialists", "widget", "specialist.md");
  mkdirSync(dirname(widget), { recursive: true });
  writeFileSync(
    widget,
    `---
name: widget
version: "1.0.0"
description: Reads the worktree and fetches one page for the wiring test.
default_tier: haiku
default_effort: low
max_effort: low
allowed_tools:
  - cc:Read
  - cc:WebFetch
allowed_domains: []
max_budget_usd: 0.5
max_turns: 4
timeout_minutes: 2
risk_tier_floor: 0
eval_set: evals/widget
status: active
requires_sandbox: false
output_contract: A one-line answer with the page it read named.
---

# Widget

Read, then answer.
`,
    "utf8",
  );
  return dir;
}

describe("cc:* tools on the daemon's loop path", () => {
  let rt: RuntimeApp;
  let home: string;
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-cc-wiring-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({}),
      provider: new ScriptedProvider([{ text: "Hello from the fake agent." }], clock),
      gitHost: new MemoryGitHost("alice"),
      registryDir: patchedRegistry(home),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
  });
  afterAll(async () => {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the composition runs specialists on the loop driver and hands the executor the built-in equivalents, the registry untouched", () => {
    expect(rt.specialistDriver).toBe("loop");
    expect(rt.registry.specialist("coder").allowed_tools).toEqual(CODER_TOOLS);
    expect(rt.specialists("coder")?.allowedTools).toEqual(["read_file", "write_file", "list_dir"]);
    // cc:Read never yields write_file; no cc:Bash, no run_command
    expect(rt.specialists("widget")?.allowedTools).toEqual(["read_file"]);
    // the repository researcher (unchanged in the copy) keeps its read and write tools
    expect(rt.specialists("researcher")?.allowedTools).toEqual([
      "read_file",
      "list_dir",
      "write_file",
    ]);
  });

  it("a name the loop driver cannot offer is an audit row at compose naming the specialist and the tool, once", async () => {
    const before = await rt.store.auditLog.list({ tool: TOOL_UNMAPPED_AUDIT });
    const pairs = before.map((r) => r.input_summary).sort();
    expect(pairs).toEqual(
      expect.arrayContaining([
        "widget: cc:WebFetch",
        "researcher: cc:WebFetch",
        "researcher: cc:WebSearch",
      ]),
    );
    expect(pairs.filter((p) => p.startsWith("coder:"))).toEqual([]);
    const widget = before.find((r) => r.input_summary === "widget: cc:WebFetch");
    expect(widget).toMatchObject({
      allowed: false,
      agent_id: rt.agent.id,
      human_id: rt.human.id,
      result_summary: "dropped (unmapped)",
    });
    expect(widget?.denied_reason).toMatch(/^tool_not_allowed: cc:WebFetch has no equivalent/);
    // later lookups (every run start) add nothing for a pair already on record
    rt.specialists("widget");
    rt.specialists("researcher");
    await new Promise((r) => setImmediate(r));
    expect(await rt.store.auditLog.count({ tool: TOOL_UNMAPPED_AUDIT })).toBe(before.length);
  });

  it("one coder task through the LoopTaskExecutor: read_file and write_file allowed, run_command refused by the hooks, audit rows for each", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "fr-cc-wt-"));
    writeFileSync(join(worktree, "README.md"), "# Demo\n", "utf8");
    const project = await rt.store.project.insert({ name: "Demo", goal: "g", repos: [] });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Add a note",
      outcome: "notes.txt exists",
      acceptance_criteria: ["notes.txt says hello"],
      risk_tier: 1,
      status: "in_progress",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 500_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: project.id,
      trigger: "manual",
      plan: {},
      status: "running",
      started_at: clock.nowIso(),
      summary: "cc tools wiring",
      author_agent: rt.agent.id,
    });
    // The session grant as the daemon issues it: every registered tool, the worktree root.
    const token = rt.tokens.issue({
      runId: "run-session",
      sessionId: session.id,
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId: project.id,
      allowedTools: rt.toolsForRun().names(),
      allowedPaths: [worktree],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 4,
      planApproved: true,
      expiresAt: new Date(clock.now() + 60_000).toISOString(),
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 1_000_000,
      stepCap: 50,
      deadlineMs: clock.now() + 60_000,
      reserveShare: 0,
    });
    const provider = new ScriptedProvider(
      [
        {
          text: "",
          tools: [
            { name: "read_file", input: { path: "README.md" } },
            { name: "write_file", input: { path: "notes.txt", content: "hello" } },
            { name: "run_command", input: { argv: ["echo", "hi"] } },
          ],
        },
        { text: "Wrote notes.txt. Lesson: none." },
      ],
      clock,
    );
    const events: RunEvent[] = [];
    const executor = new LoopTaskExecutor({
      store: rt.store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider,
      pricing: flatPricing,
      tools: rt.tools,
      toolsFor: rt.toolsForRun,
      billingSourceId: rt.billingSourceId,
      specialists: rt.specialists,
      worktreeFor: async () => worktree,
      onEvent: (_taskId, ev) => events.push(ev),
    });
    const result = await executor.execute({
      task,
      session,
      token,
      budget,
      item: planItemFor(task, "coder"),
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("done");
    // The driver was offered exactly the mapped names (the token sorts them).
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual([
      "list_dir",
      "read_file",
      "write_file",
    ]);
    // read_file and write_file ran inside the worktree; run_command was refused in code.
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("hello");
    const denied = events.filter((e) => e.type === "tool_denied");
    expect(denied).toEqual([
      expect.objectContaining({ name: "run_command", code: "tool_not_allowed" }),
    ]);
    const run = (await rt.store.run.forTask(task.id))[0];
    expect(run).toMatchObject({ specialist: "coder", outcome: "completed", depth: 1 });
    const rows = await rt.store.auditLog.list({ runId: result.runId });
    expect(rows.map((r) => [r.tool, r.allowed])).toEqual([
      ["read_file", true],
      ["write_file", true],
      ["run_command", false],
    ]);
    expect(rows[2]?.denied_reason).toMatch(
      /^tool_not_allowed: tool "run_command" is not in this run's allowlist/,
    );
    expect(rows.every((r) => r.agent_id === rt.agent.id && r.human_id === rt.human.id)).toBe(true);
    expect(existsSync(join(worktree, "hi"))).toBe(false);
    rmSync(worktree, { recursive: true, force: true });
  });
});
