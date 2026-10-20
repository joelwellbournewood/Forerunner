import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FakeProbe } from "@forerunner/billing";
import { MemoryGitHost } from "@forerunner/capabilities";
import {
  appDirs,
  isForerunnerError,
  join,
  Logger,
  type LogRecord,
  SimulatedClock,
} from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import { billingSourcesLine, buildProgram } from "../src/cli/main.ts";
import { composeRuntime, type RuntimeApp, TOOL_UNMAPPED_AUDIT } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { BILLING_PICK_AUDIT_TOOL, planShareAfter } from "../src/session/billing.ts";
import { planItemFor, SDK_RUN_PROVIDER } from "../src/session/executor.ts";
import {
  DEFAULT_PLAN_USD_MONTHLY,
  describePlanAllowance,
  parsePlanUsdMonthly,
  resolvePlanAllowance,
} from "../src/setup/plan-allowance.ts";
import { CREDENTIAL_REQUESTS, validateSubscriptionTokenFormat } from "../src/setup/validators.ts";
import { PLAN_ALLOWANCE_QUESTION, runSetup, SECRET_NAMES } from "../src/setup/wizard.ts";
import { RouterTaskBilling, seedBillingSources } from "../src/wiring/billing-pick.ts";
import { ScriptedProvider, until } from "./helpers.ts";

/**
 * The subscription half of the phase 1 check (ADR 0044): one composition with both credentials
 * in the vault registers both billing sources; a task for the human's own agent on the PC is
 * routed to the subscription and runs through the Agent SDK driver (a fake `query`, never a
 * Claude Code subprocess) with the OAuth token and the registry's `cc:*` names, its Run row
 * cites the subscription source and its ledger rows are "subscription"; another human's agent
 * runs on the API key through the loop driver; a plan share at the cap routes to the API key;
 * the kill switch aborts an SDK run; the hooks refuse a tool outside the allowlist and a path
 * outside the run's directory on the SDK path. Fake provider, `sqlite::memory:`, SimulatedClock.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "subscription", "0".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "apikey", "0".repeat(40)].join(""); // not-a-secret
const CODER_CC_TOOLS = [
  "cc:Read",
  "cc:Edit",
  "cc:MultiEdit",
  "cc:Write",
  "cc:Bash",
  "cc:Grep",
  "cc:Glob",
];

type SdkMessage = Record<string, unknown>;
type SdkScript = (options: Record<string, unknown>) => AsyncIterable<SdkMessage>;

const init: SdkMessage = { type: "system", subtype: "init", session_id: "sdk-1" };
const assistant = (text: string): SdkMessage => ({
  type: "assistant",
  message: {
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});
const done = (text: string): SdkMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  total_cost_usd: 0.006,
});

/** A scriptable stand-in for the SDK's `query`: records every call, never spawns anything. */
function fakeSdk() {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  let script: SdkScript = async function* () {
    yield init;
    yield assistant("Implemented the change. Lesson: none.");
    yield done("Implemented the change. Lesson: none.");
  };
  const q: QueryLike = ({ prompt, options }) => {
    const o = options ?? {};
    calls.push({ prompt, options: o });
    return script(o);
  };
  return {
    q,
    calls,
    set(fn: SdkScript) {
      script = fn;
    },
  };
}

type PreHook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
function preToolUseOf(options: Record<string, unknown>): PreHook {
  const hooks = options.hooks as { PreToolUse: { hooks: PreHook[] }[] };
  const pre = hooks.PreToolUse[0]?.hooks[0];
  if (!pre) throw new Error("no PreToolUse hook");
  return pre;
}
function decisionOf(r: Record<string, unknown>): { decision: string; reason: string } {
  const out = r.hookSpecificOutput as
    | { permissionDecision: string; permissionDecisionReason?: string }
    | undefined;
  return { decision: out?.permissionDecision ?? "", reason: out?.permissionDecisionReason ?? "" };
}

describe("the subscription path (ADR 0044)", () => {
  let rt: RuntimeApp;
  let home: string;
  let provider: ScriptedProvider;
  const sdk = fakeSdk();
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const logs: LogRecord[] = [];
  let offLogs: () => void = () => undefined;
  let projectId: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-subscription-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    offLogs = Logger.addSink((r) => logs.push(r));
    provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    rt = await composeRuntime({
      // The plan's allowance makes the share computable: USD 100 of API-equivalent a month.
      env: { FORERUNNER_HOME: home, FORERUNNER_PLAN_USD_MONTHLY: "100" },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({
        [SECRET_NAMES.anthropicOauth]: OAUTH,
        [SECRET_NAMES.anthropic]: API_KEY,
      }),
      provider,
      gitHost: new MemoryGitHost("alice"),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
      sdkQuery: sdk.q,
    });
    projectId = (await rt.store.project.insert({ name: "Demo", goal: "g", repos: [] })).id;
  });
  afterAll(async () => {
    offLogs();
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function seedTask(title: string, agentId = rt.agent.id, ownerHumanId = rt.human.id) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: "the change is in",
      acceptance_criteria: ["the change is in and tested"],
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
      agent_id: agentId,
      project_id: projectId,
      trigger: "manual",
      plan: {},
      status: "running",
      started_at: clock.nowIso(),
      summary: "subscription path",
      runner: "pc",
      author_agent: agentId,
    });
    const token = rt.tokens.issue({
      runId: `run-session-${task.id}`,
      sessionId: session.id,
      agentId,
      ownerHumanId,
      projectId,
      // The daemon's session grant: the loop tools plus the Claude Code names (a derived token
      // only narrows, so the SDK run's `cc:` names must be here).
      allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
      allowedPaths: [rt.dirs.worktrees],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 2_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 3,
      planApproved: true,
      expiresAt: new Date(clock.now() + 60_000).toISOString(),
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 2_000_000,
      stepCap: 50,
      deadlineMs: clock.now() + 60_000,
      reserveShare: 0,
    });
    return { task, session, token, budget };
  }

  function execute(w: Awaited<ReturnType<typeof seedTask>>) {
    return rt.executor.execute({
      task: w.task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: planItemFor(w.task, "coder"),
      signal: new AbortController().signal,
    });
  }

  it("registers both sources when both credentials exist and bills the loop paths to the API key", async () => {
    const sources = await rt.billing.sources();
    const sub = sources.find((s) => s.kind === "subscription");
    const key = sources.find((s) => s.kind === "api_key");
    expect(sub).toMatchObject({
      credentialRef: SECRET_NAMES.anthropicOauth,
      humanId: rt.human.id,
      enabled: true,
      priority: 1,
      limits: { planShareCap: 0.95, planUsdMicro: 100_000_000 },
    });
    expect(key).toMatchObject({
      credentialRef: SECRET_NAMES.anthropic,
      humanId: rt.human.id,
      enabled: true,
      priority: 2,
    });
    expect(sources.filter((s) => s.kind === "fake")).toEqual([]);
    // The allowance in force and where it came from (the environment here).
    expect(rt.billing.planAllowance).toEqual({
      usdMonthly: 100,
      usdMicro: 100_000_000,
      origin: "env",
    });
    // The critic, chat and evals stay on the Messages provider, which holds the key.
    expect(rt.billingSourceId).toBe(key?.id);
    // The default driver is the loop one; the "sdk" form keeps the registry's names.
    expect(rt.specialistDriver).toBe("loop");
    expect(rt.specialists("coder")?.allowedTools).toEqual([
      "read_file",
      "write_file",
      "run_command",
      "list_dir",
    ]);
    expect(rt.specialists("coder", "sdk")?.allowedTools).toEqual(CODER_CC_TOOLS);
    expect(JSON.stringify(sources)).not.toContain(OAUTH);
  });

  it("runs the human's own task on the subscription through the SDK driver with the OAuth token and the cc:* names, records the Run and the ledger", async () => {
    const w = await seedTask("Add a greeting");
    const sdkCallsBefore = sdk.calls.length;
    const providerCallsBefore = provider.calls.length;
    const res = await execute(w);
    expect(res.outcome).toBe("done");
    expect(res.summary).toContain("Implemented the change.");
    // The SDK driver ran it, not the loop driver.
    expect(sdk.calls).toHaveLength(sdkCallsBefore + 1);
    expect(provider.calls).toHaveLength(providerCallsBefore);
    const call = sdk.calls[sdk.calls.length - 1] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    const env = call.options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // The registry's Claude Code names, as written, minus Bash (no sandbox lease covers the subprocess).
    expect([...(call.options.allowedTools as string[])].sort()).toEqual(
      ["Edit", "Glob", "Grep", "MultiEdit", "Read", "Write"].sort(),
    );
    expect(call.options.model).toBe("claude-sonnet-5-5");
    expect(call.options.maxTurns).toBe(80);
    expect(call.options.permissionMode).toBe("dontAsk");
    // No worktree: the run works in its own directory under the worktrees root, and only there.
    expect(String(call.options.cwd).startsWith(join(rt.dirs.worktrees, "sdk-runs"))).toBe(true);
    expect(call.prompt).toContain("Add a greeting");
    // The Run row cites the subscription source and the SDK provider, with whole-ms timings.
    const sources = await rt.billing.sources();
    const sub = sources.find((s) => s.kind === "subscription");
    const run = (await rt.store.run.forTask(w.task.id))[0];
    expect(run).toMatchObject({
      id: res.runId,
      specialist: "coder",
      provider: SDK_RUN_PROVIDER,
      billing_source_id: sub?.id,
      outcome: "completed",
      tokens_in: 1_000,
      tokens_out: 200,
      depth: 1,
    });
    expect(run?.cost_usd_micro).toBeGreaterThan(0);
    expect(Number.isInteger(run?.duration_ms)).toBe(true);
    expect(run?.artifacts[0]).toMatchObject({
      driver: "sdk",
      sdk_session_id: "sdk-1",
      sdk_cost_usd_micro: 6_000,
    });
    // The ledger: "subscription" rows on that source, the plan share moved by the run.
    const rows = await rt.store.costLedger.list({ run_id: res.runId }, { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.kind).toBe("subscription");
      expect(r.billing_source_id).toBe(sub?.id);
      expect(r.plan_usage_share).toBeGreaterThan(0);
      expect(r.plan_usage_share).toBeLessThanOrEqual(1);
    }
    expect(rows.reduce((s, r) => s + r.usd_micro, 0)).toBe(run?.cost_usd_micro);
    // The pick is an audit row with the router's reason; the withheld Bash is another.
    const audit = await rt.store.auditLog.list({ runId: res.runId });
    const pick = audit.find((r) => r.tool === BILLING_PICK_AUDIT_TOOL);
    expect(pick).toMatchObject({ allowed: true, human_id: rt.human.id, agent_id: rt.agent.id });
    expect(pick?.result_summary).toMatch(
      /^subscription "Claude subscription" for session work on the pc runner/,
    );
    expect(JSON.parse(pick?.input_summary ?? "{}")).toMatchObject({
      sourceId: sub?.id,
      kind: "subscription",
      driver: "sdk",
      tier: "sonnet",
    });
    const bash = audit.find((r) => r.tool === TOOL_UNMAPPED_AUDIT);
    expect(bash).toMatchObject({ allowed: false, input_summary: "coder: cc:Bash" });
    expect(bash?.denied_reason).toMatch(/no sandbox lease/);
    // The token never reaches the audit log, the Run row or the runtime log.
    expect(JSON.stringify(audit)).not.toContain(OAUTH);
    expect(JSON.stringify(run)).not.toContain(OAUTH);
    expect(JSON.stringify(logs)).not.toContain(OAUTH);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
  });

  it("the hooks refuse a tool outside the allowlist and a path outside the run's directory on the SDK path too", async () => {
    const w = await seedTask("Read the docs");
    const decisions: Record<string, { decision: string; reason: string }> = {};
    sdk.set(async function* (options) {
      const pre = preToolUseOf(options);
      yield init;
      decisions.webfetch = decisionOf(
        await pre({
          tool_name: "WebFetch",
          tool_input: { url: "https://example.test/" },
          tool_use_id: "t1",
        }),
      );
      decisions.outside = decisionOf(
        await pre({
          tool_name: "Read",
          tool_input: { file_path: join(tmpdir(), "elsewhere.txt") },
          tool_use_id: "t2",
        }),
      );
      decisions.inside = decisionOf(
        await pre({
          tool_name: "Read",
          tool_input: { file_path: join(String(options.cwd), "README.md") },
          tool_use_id: "t3",
        }),
      );
      decisions.bash = decisionOf(
        await pre({ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t4" }),
      );
      yield assistant("Read it. Lesson: none.");
      yield done("Read it. Lesson: none.");
    });
    try {
      const res = await execute(w);
      expect(res.outcome).toBe("done");
      expect(decisions.webfetch?.decision).toBe("deny");
      expect(decisions.webfetch?.reason).toMatch(/^tool_not_allowed: tool "cc:WebFetch"/);
      expect(decisions.outside?.decision).toBe("deny");
      expect(decisions.outside?.reason).toMatch(/^path_not_allowed/);
      expect(decisions.inside?.decision).toBe("allow");
      expect(decisions.bash?.decision).toBe("deny");
      expect(decisions.bash?.reason).toMatch(/^tool_not_allowed: tool "cc:Bash"/);
      const audit = await rt.store.auditLog.list({ runId: res.runId });
      expect(audit.filter((r) => !r.allowed).map((r) => r.tool)).toEqual(
        expect.arrayContaining(["cc:WebFetch", "cc:Read", "cc:Bash"]),
      );
    } finally {
      sdk.set(async function* () {
        yield init;
        yield assistant("Implemented the change. Lesson: none.");
        yield done("Implemented the change. Lesson: none.");
      });
    }
  });

  it("the kill switch aborts an SDK run within its budget of two seconds", async () => {
    const w = await seedTask("Long task");
    let started = false;
    let sawAbort = false;
    sdk.set(async function* (options) {
      const ac = options.abortController as AbortController;
      yield init;
      started = true;
      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) resolve();
        else ac.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      sawAbort = true;
      throw ac.signal.reason instanceof Error ? ac.signal.reason : new Error("aborted");
    });
    try {
      const p = execute(w);
      await until(() => started, "the SDK run to start");
      const t0 = performance.now();
      const report = await rt.kill.stop("all", "test stop");
      const res = await p;
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(report.stoppedRuns).toBeGreaterThanOrEqual(1);
      expect(sawAbort).toBe(true);
      expect(res.outcome).toBe("killed");
      expect((await rt.store.run.forTask(w.task.id))[0]?.outcome).toBe("killed");
    } finally {
      rt.kill.resume();
      sdk.set(async function* () {
        yield init;
        yield assistant("Implemented the change. Lesson: none.");
        yield done("Implemented the change. Lesson: none.");
      });
    }
  });

  it("a driver error that quotes the subprocess environment is redacted before it becomes the task's summary", async () => {
    const w = await seedTask("Echoing failure");
    sdk.set(async function* (options) {
      yield init;
      // A subprocess that fails and echoes its environment in the message, token included.
      const env = options.env as Record<string, string | undefined>;
      throw new Error(`claude exited 1: CLAUDE_CODE_OAUTH_TOKEN=${env.CLAUDE_CODE_OAUTH_TOKEN}`);
    });
    try {
      const res = await execute(w);
      expect(res.outcome).toBe("failed");
      expect(res.summary).toContain("claude exited 1");
      expect(res.summary).toContain("[REDACTED]");
      expect(res.summary).not.toContain(OAUTH);
      expect(res.finalReport).toBe("");
      const run = (await rt.store.run.forTask(w.task.id))[0];
      expect(run?.outcome).toBe("error");
      expect(JSON.stringify(run)).not.toContain(OAUTH);
      expect(JSON.stringify(await rt.store.auditLog.list({ runId: res.runId }))).not.toContain(
        OAUTH,
      );
      expect(JSON.stringify(logs)).not.toContain(OAUTH);
    } finally {
      sdk.set(async function* () {
        yield init;
        yield assistant("Implemented the change. Lesson: none.");
        yield done("Implemented the change. Lesson: none.");
      });
    }
  });

  it("another human's agent never runs on the subscription: the API key through the loop driver", async () => {
    const other = await rt.store.human.insert({
      name: "K",
      email: "k@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 100_000_000,
      locale: "en",
    });
    const agent = await rt.store.agent.insert({
      name: "Bob",
      owner_human_id: other.id,
      model_config: {},
      memory_location: "m",
      status: "active",
      kind: "principal",
    });
    const w = await seedTask("Bob's task", agent.id, other.id);
    const sdkCallsBefore = sdk.calls.length;
    const providerCallsBefore = provider.calls.length;
    const res = await execute(w);
    expect(res.outcome).toBe("done");
    expect(sdk.calls).toHaveLength(sdkCallsBefore);
    expect(provider.calls).toHaveLength(providerCallsBefore + 1);
    const sources = await rt.billing.sources();
    const key = sources.find((s) => s.kind === "api_key");
    const sub = sources.find((s) => s.kind === "subscription");
    const run = (await rt.store.run.forTask(w.task.id))[0];
    expect(run).toMatchObject({
      billing_source_id: key?.id,
      provider: "fake",
      outcome: "completed",
    });
    const rows = await rt.store.costLedger.list({ run_id: res.runId }, { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "api" && r.billing_source_id === key?.id)).toBe(true);
    const pick = (await rt.store.auditLog.list({ runId: res.runId })).find(
      (r) => r.tool === BILLING_PICK_AUDIT_TOOL,
    );
    expect(pick?.result_summary).toMatch(/^api_key "Anthropic API key" for session work/);
    expect(pick?.result_summary).toContain(`withheld subscription ${sub?.id}`);
    expect(pick?.result_summary).toMatch(/another human/);
    expect(JSON.parse(pick?.input_summary ?? "{}")).toMatchObject({ driver: "loop" });
  });

  it("at the plan share cap the router picks the API key and the task runs on the loop driver", async () => {
    const sources = await rt.billing.sources();
    const sub = sources.find((s) => s.kind === "subscription");
    const key = sources.find((s) => s.kind === "api_key");
    // What a probe or the last subscription run reported this month: the plan is at the cap.
    await rt.store.costLedger.record({
      human_id: rt.human.id,
      agent_id: rt.agent.id,
      billing_source_id: sub?.id ?? null,
      kind: "subscription",
      usd_micro: 0,
      chf_micro: 0,
      rate_chf_per_usd: 0.8,
      plan_usage_share: 0.95,
      model: "claude-sonnet-5-5",
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      occurred_at: clock.nowIso(),
    });
    const w = await seedTask("After the cap");
    const sdkCallsBefore = sdk.calls.length;
    const res = await execute(w);
    expect(res.outcome).toBe("done");
    expect(sdk.calls).toHaveLength(sdkCallsBefore);
    const run = (await rt.store.run.forTask(w.task.id))[0];
    expect(run).toMatchObject({ billing_source_id: key?.id, provider: "fake" });
    const pick = (await rt.store.auditLog.list({ runId: res.runId })).find(
      (r) => r.tool === BILLING_PICK_AUDIT_TOOL,
    );
    expect(pick?.result_summary).toMatch(/^api_key "Anthropic API key"/);
    expect(pick?.result_summary).toMatch(/plan usage 95% is at or above the cap 95%/);
  });
});

describe("billing sources from the vault", () => {
  it("seeds a row per credential once, both when both exist, and a fake row only when nothing exists", async () => {
    const clock = new SimulatedClock("2026-10-20T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({
      name: "J",
      email: "",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    });
    const none = await seedBillingSources({ store, vault: new MemoryVault({}), humanId: human.id });
    expect(none.map((r) => [r.kind, r.enabled])).toEqual([["fake", true]]);
    const keyOnly = new MemoryVault({ [SECRET_NAMES.anthropic]: API_KEY });
    const withKey = await seedBillingSources({ store, vault: keyOnly, humanId: human.id });
    expect(withKey.map((r) => r.kind).sort()).toEqual(["api_key", "fake"]);
    // The fake row is disabled as soon as a real source is enabled: never a candidate again.
    expect(withKey.find((r) => r.kind === "fake")?.enabled).toBe(false);
    expect(withKey.find((r) => r.kind === "api_key")?.enabled).toBe(true);
    expect((await store.billingSource.enabledFor(human.id)).map((r) => r.kind)).toEqual([
      "api_key",
    ]);
    const both = new MemoryVault({
      [SECRET_NAMES.anthropic]: API_KEY,
      [SECRET_NAMES.anthropicOauth]: OAUTH,
    });
    const withBoth = await seedBillingSources({ store, vault: both, humanId: human.id });
    expect(withBoth.map((r) => r.kind).sort()).toEqual(["api_key", "fake", "subscription"]);
    // Without any input the subscription row still carries an allowance: the default, so the
    // plan share cap is never silently absent.
    const sub = withBoth.find((r) => r.kind === "subscription");
    expect(sub?.limits).toEqual({
      planShareCap: 0.95,
      planUsdMicro: DEFAULT_PLAN_USD_MONTHLY * 1_000_000,
    });
    // Idempotent: the same vault again adds nothing.
    const again = await seedBillingSources({ store, vault: both, humanId: human.id });
    expect(again).toHaveLength(3);
    expect(JSON.stringify(again)).not.toContain(OAUTH);
    expect(JSON.stringify(again)).not.toContain(API_KEY);
    // A human-set allowance (here the environment) updates the row at the next seed...
    const raised = await seedBillingSources({
      store,
      vault: both,
      humanId: human.id,
      env: { FORERUNNER_PLAN_USD_MONTHLY: "200" },
    });
    expect(raised.find((r) => r.kind === "subscription")?.limits.planUsdMicro).toBe(200_000_000);
    // ...the default never overwrites a row that has one (a value edited on the row stands)...
    const kept = await seedBillingSources({ store, vault: both, humanId: human.id });
    expect(kept.find((r) => r.kind === "subscription")?.limits.planUsdMicro).toBe(200_000_000);
    // ...and the resolved allowance of the composition wins over the environment.
    const fromConfig = await seedBillingSources({
      store,
      vault: both,
      humanId: human.id,
      env: { FORERUNNER_PLAN_USD_MONTHLY: "200" },
      planAllowance: resolvePlanAllowance([{ value: 75, origin: "config" }]),
    });
    expect(fromConfig.find((r) => r.kind === "subscription")?.limits).toEqual({
      planShareCap: 0.95,
      planUsdMicro: 75_000_000,
    });
    expect(fromConfig).toHaveLength(3);
    await store.close();
  });

  it("the router never bills real work to the fake row beside a real source, even one re-enabled by hand", async () => {
    const clock = new SimulatedClock("2026-10-20T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({
      name: "J",
      email: "",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    });
    // An install that started without credentials (a fake row) and then got both.
    await seedBillingSources({ store, vault: new MemoryVault({}), humanId: human.id });
    const vault = new MemoryVault({
      [SECRET_NAMES.anthropic]: API_KEY,
      [SECRET_NAMES.anthropicOauth]: OAUTH,
    });
    const rows = await seedBillingSources({ store, vault, humanId: human.id });
    const sub = rows.find((r) => r.kind === "subscription");
    const key = rows.find((r) => r.kind === "api_key");
    const fake = rows.find((r) => r.kind === "fake");
    if (!sub || !key || !fake) throw new Error("rows missing");
    // The subscription at its cap, the API key over its monthly limit: nothing real is left.
    const probe = new FakeProbe({
      [sub.id]: { available: true, planUsageShare: 0.95 },
      [key.id]: { available: false, reason: "no credential in the vault" },
    });
    const billing = new RouterTaskBilling({ store, vault, clock, humanId: human.id, probe });
    const req = {
      agentId: "alice",
      agentOwnerHumanId: human.id,
      runner: "pc" as const,
      modelTier: "sonnet",
    };
    let err: unknown = null;
    try {
      await billing.pick(req);
    } catch (e) {
      err = e;
    }
    expect(isForerunnerError(err, "unavailable")).toBe(true);
    expect(String((err as Error).message)).toMatch(/no billing source available/);
    // Re-enabled by hand, the fake row is still withheld: real work never lands on a stand-in.
    await store.billingSource.patch(fake.id, { enabled: true });
    err = null;
    try {
      await billing.pick(req);
    } catch (e) {
      err = e;
    }
    expect(isForerunnerError(err, "unavailable")).toBe(true);
    const details = (err as { details?: { skipped?: { sourceId: string; code: string }[] } })
      .details;
    expect(details?.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: sub.id, code: "plan_share" })]),
    );
    // With the API key available again the router picks it, never the fake row.
    probe.set(key.id, { available: true });
    const pick = await billing.pick(req);
    expect(pick.source.id).toBe(key.id);
    expect(pick.driver).toBe("loop");
    expect(pick.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: fake.id, kind: "fake", code: "unavailable" }),
      ]),
    );
    await store.close();
  });

  it("the plan allowance parses only a positive number of USD and resolves most explicit first", () => {
    expect(parsePlanUsdMonthly("100")).toBe(100);
    expect(parsePlanUsdMonthly(" 12.5 ")).toBe(12.5);
    expect(parsePlanUsdMonthly(50)).toBe(50);
    for (const bad of ["", "abc", "0", "-5", "1e3", "USD 20", undefined, null, Number.NaN, -1]) {
      expect(parsePlanUsdMonthly(bad)).toBeNull();
    }
    expect(resolvePlanAllowance([])).toEqual({
      usdMonthly: DEFAULT_PLAN_USD_MONTHLY,
      usdMicro: DEFAULT_PLAN_USD_MONTHLY * 1_000_000,
      origin: "default",
    });
    expect(
      resolvePlanAllowance([
        { value: undefined, origin: "flag" },
        { value: "abc", origin: "env" },
        { value: 80, origin: "config" },
      ]),
    ).toEqual({ usdMonthly: 80, usdMicro: 80_000_000, origin: "config" });
    expect(describePlanAllowance(resolvePlanAllowance([]))).toMatch(
      /^plan allowance USD 50\/month \(default; set it with fr setup --plan-usd-monthly/,
    );
    expect(describePlanAllowance(resolvePlanAllowance([{ value: "120", origin: "flag" }]))).toBe(
      "plan allowance USD 120/month from --plan-usd-monthly",
    );
  });

  it("the plan share after a run follows the allowance, else stays what the pick saw", () => {
    expect(
      planShareAfter(
        { share: 0.5, monthUsdMicro: 50_000_000, allowanceUsdMicro: 100_000_000, cap: 0.95 },
        10_000_000,
      ),
    ).toBe(0.6);
    expect(
      planShareAfter({ share: 0.3, monthUsdMicro: 1, allowanceUsdMicro: null, cap: 0.95 }, 5),
    ).toBe(0.3);
    expect(
      planShareAfter({ share: null, monthUsdMicro: 1, allowanceUsdMicro: null, cap: 0.95 }, 5),
    ).toBeNull();
  });
});

describe("fr setup with a subscription token", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "fr-setup-sub-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("takes --subscription-token, checks the format, stores it in the vault and names both sources", async () => {
    const vault = new MemoryVault({ [SECRET_NAMES.anthropic]: API_KEY });
    const env = { FORERUNNER_HOME: join(home, "flag") };
    const report = await runSetup(vault, { nonInteractive: true, subscriptionToken: OAUTH, env });
    expect(report.results.subscription?.ok).toBe(true);
    expect(report.results.subscription?.details).toEqual({
      kind: "subscription",
      verified: "format",
    });
    expect(await vault.get(SECRET_NAMES.anthropicOauth)).toBe(OAUTH);
    expect(report.stored).toContain(SECRET_NAMES.anthropicOauth);
    expect(report.sources).toEqual({
      subscription: true,
      apiKey: true,
      planAllowance: { usdMonthly: 50, usdMicro: 50_000_000, origin: "default" },
    });
    // Nothing set the allowance, so the default applies and the config does not pin it.
    expect(report.config.subscription).toBeUndefined();
    expect(report.config.credentials).toMatchObject({
      anthropic: true,
      anthropicSubscription: true,
    });
    expect(JSON.stringify({ ...report, dirs: null })).not.toContain(OAUTH);
    expect(billingSourcesLine(report.sources)).toContain(
      "subscription (anthropic_subscription_token",
    );
    expect(billingSourcesLine(report.sources)).toContain("API key (anthropic_api_key)");
    expect(billingSourcesLine(report.sources)).toContain(
      "plan allowance USD 50/month (default; set it with fr setup --plan-usd-monthly",
    );
  });

  it("takes --plan-usd-monthly, writes it to config.json, keeps it on the next run and rejects a bad value before anything is stored", async () => {
    const vault = new MemoryVault({});
    const env = { FORERUNNER_HOME: join(home, "allowance") };
    const first = await runSetup(vault, {
      nonInteractive: true,
      subscriptionToken: OAUTH,
      planUsdMonthly: "120",
      env,
    });
    expect(first.sources.planAllowance).toEqual({
      usdMonthly: 120,
      usdMicro: 120_000_000,
      origin: "flag",
    });
    expect(first.config.subscription).toEqual({ planUsdMonthly: 120 });
    expect(billingSourcesLine(first.sources)).toContain(
      "plan allowance USD 120/month from --plan-usd-monthly",
    );
    // The next run without the flag reads it back from the config file.
    const second = await runSetup(vault, { nonInteractive: true, env });
    expect(second.sources.planAllowance).toEqual({
      usdMonthly: 120,
      usdMicro: 120_000_000,
      origin: "config",
    });
    expect(second.config.subscription).toEqual({ planUsdMonthly: 120 });
    // The environment overrides the config, and is written in its place.
    const third = await runSetup(vault, {
      nonInteractive: true,
      env: { ...env, FORERUNNER_PLAN_USD_MONTHLY: "300" },
    });
    expect(third.sources.planAllowance).toMatchObject({ usdMonthly: 300, origin: "env" });
    expect(third.config.subscription).toEqual({ planUsdMonthly: 300 });
    // A bad flag fails before any credential is stored; a bad environment value too.
    const fresh = new MemoryVault({});
    for (const bad of [
      { planUsdMonthly: "lots", env: { FORERUNNER_HOME: join(home, "bad-flag") } },
      { env: { FORERUNNER_HOME: join(home, "bad-env"), FORERUNNER_PLAN_USD_MONTHLY: "0" } },
    ]) {
      let err: unknown = null;
      try {
        await runSetup(fresh, { nonInteractive: true, subscriptionToken: OAUTH, ...bad });
      } catch (e) {
        err = e;
      }
      expect(isForerunnerError(err, "validation")).toBe(true);
      expect(String((err as Error).message)).toMatch(/positive number of USD per month/);
      expect(await fresh.list()).toEqual([]);
    }
  });

  it("asks the questions in order (GitHub, Anthropic, subscription token, plan allowance) and skips the token question when the Anthropic step stored one", async () => {
    const models = { data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(models), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const headerOf = (q: string) => q.trim().split("\n")[0] ?? "";
    const scripted = (answers: string[]) => {
      const asked: { header: string; secret: boolean }[] = [];
      const prompt = async (question: string, secret: boolean) => {
        asked.push({ header: headerOf(question), secret });
        return answers[asked.length - 1] ?? "";
      };
      return { asked, prompt };
    };
    // GitHub skipped, Anthropic skipped, the token pasted at the third question, the
    // allowance at the fourth.
    const a = scripted(["", "", OAUTH, "120"]);
    const vaultA = new MemoryVault({});
    const reportA = await runSetup(vaultA, {
      nonInteractive: false,
      prompt: a.prompt,
      fetchImpl,
      env: { FORERUNNER_HOME: join(home, "interactive-a") },
    });
    expect(a.asked).toEqual([
      { header: "GitHub token", secret: true },
      { header: "Anthropic API key", secret: true },
      { header: "Claude subscription token", secret: true },
      { header: "Plan allowance", secret: false },
    ]);
    expect(headerOf(PLAN_ALLOWANCE_QUESTION)).toBe("Plan allowance");
    expect(await vaultA.get(SECRET_NAMES.anthropicOauth)).toBe(OAUTH);
    expect(reportA.stored).toEqual([SECRET_NAMES.anthropicOauth]);
    expect(reportA.skipped).toEqual(["github", "anthropic"]);
    expect(reportA.sources).toEqual({
      subscription: true,
      apiKey: false,
      planAllowance: { usdMonthly: 120, usdMicro: 120_000_000, origin: "prompt" },
    });
    expect(reportA.results.planAllowance?.ok).toBe(true);
    expect(reportA.config.subscription).toEqual({ planUsdMonthly: 120 });
    // The token pasted at the Anthropic step: validated there, stored once, the token
    // question skipped, the allowance question still asked and left at the default.
    const b = scripted(["", OAUTH, ""]);
    const vaultB = new MemoryVault({});
    const reportB = await runSetup(vaultB, {
      nonInteractive: false,
      prompt: b.prompt,
      fetchImpl,
      env: { FORERUNNER_HOME: join(home, "interactive-b") },
    });
    expect(b.asked.map((q) => q.header)).toEqual([
      "GitHub token",
      "Anthropic API key",
      "Plan allowance",
    ]);
    expect(reportB.results.anthropic?.details).toMatchObject({ kind: "subscription" });
    expect(reportB.results.subscription).toBeUndefined();
    expect(reportB.stored).toEqual([SECRET_NAMES.anthropicOauth]);
    expect(reportB.skipped).toEqual(["github"]);
    expect(reportB.sources.planAllowance).toMatchObject({ usdMonthly: 50, origin: "default" });
    expect(reportB.results.planAllowance).toBeUndefined();
    expect(reportB.config.subscription).toBeUndefined();
    // An answer that is not a number: said so in the results, the default applies.
    const c = scripted(["", "", OAUTH, "fifty"]);
    const reportC = await runSetup(new MemoryVault({}), {
      nonInteractive: false,
      prompt: c.prompt,
      fetchImpl,
      env: { FORERUNNER_HOME: join(home, "interactive-c") },
    });
    expect(reportC.results.planAllowance?.ok).toBe(false);
    expect(reportC.results.planAllowance?.problems[0]).toMatch(/positive number/);
    expect(reportC.sources.planAllowance).toMatchObject({ usdMonthly: 50, origin: "default" });
    // Without a subscription source the allowance is never asked for.
    const d = scripted(["", "", ""]);
    const reportD = await runSetup(new MemoryVault({}), {
      nonInteractive: false,
      prompt: d.prompt,
      fetchImpl,
      env: { FORERUNNER_HOME: join(home, "interactive-d") },
    });
    expect(d.asked.map((q) => q.header)).toEqual([
      "GitHub token",
      "Anthropic API key",
      "Claude subscription token",
    ]);
    expect(reportD.sources).toEqual({ subscription: false, apiKey: false, planAllowance: null });
  });

  it("takes FORERUNNER_SUBSCRIPTION_TOKEN and leaves the API-key path as it is", async () => {
    const vault = new MemoryVault({});
    const env = { FORERUNNER_HOME: join(home, "env"), FORERUNNER_SUBSCRIPTION_TOKEN: OAUTH };
    const report = await runSetup(vault, { nonInteractive: true, env });
    expect(await vault.has(SECRET_NAMES.anthropicOauth)).toBe(true);
    expect(await vault.has(SECRET_NAMES.anthropic)).toBe(false);
    expect(report.sources).toEqual({
      subscription: true,
      apiKey: false,
      planAllowance: { usdMonthly: 50, usdMicro: 50_000_000, origin: "default" },
    });
    expect(report.skipped).toEqual(["github", "anthropic"]);
    expect(report.results.anthropic).toBeUndefined();
  });

  it("rejects a value that is not a subscription token in non-interactive mode and stores nothing", async () => {
    const vault = new MemoryVault({});
    const env = { FORERUNNER_HOME: join(home, "bad") };
    let err: unknown = null;
    try {
      await runSetup(vault, { nonInteractive: true, subscriptionToken: API_KEY, env });
    } catch (e) {
      err = e;
    }
    expect(isForerunnerError(err, "validation")).toBe(true);
    expect(String((err as Error).message)).toMatch(/Subscription token rejected/);
    expect(String((err as Error).message)).not.toContain(API_KEY);
    expect(await vault.list()).toEqual([]);
    const short = validateSubscriptionTokenFormat("sk-ant-oat01-short");
    expect(short.ok).toBe(false);
    expect(short.problems).toEqual([expect.stringMatching(/too short/)]);
    expect(validateSubscriptionTokenFormat(`${OAUTH} `).ok).toBe(true);
    expect(validateSubscriptionTokenFormat("ghp_x").problems[0]).toMatch(/starts with sk-ant-oat/);
  });

  it("the CLI exposes the flag and the request text says where the token comes from", () => {
    const setup = buildProgram({ env: {}, out: () => undefined }).commands.find(
      (c) => c.name() === "setup",
    );
    expect(setup?.options.some((o) => o.long === "--subscription-token")).toBe(true);
    expect(setup?.options.some((o) => o.long === "--plan-usd-monthly")).toBe(true);
    expect(CREDENTIAL_REQUESTS.subscription.whereToClick).toContain("claude setup-token");
    expect(CREDENTIAL_REQUESTS.subscription.howVerified).toMatch(/No request is made during setup/);
    expect(billingSourcesLine({ subscription: false, apiKey: false, planAllowance: null })).toMatch(
      /none yet/,
    );
  });
});
