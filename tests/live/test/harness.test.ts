import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { closingReply, specialistReportTurn, specialistTurn, submitReview } from "@forerunner/e2e";
import { join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import {
  BILLING_PICK_AUDIT_TOOL,
  loadRegistry,
  type QueryLike,
  SDK_RUN_PROVIDER,
  SECRET_NAMES,
  stateSources,
  TOOL_UNMAPPED_AUDIT,
} from "@forerunner/runtime";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRY_RUN_PRICING, dryRunCredentials } from "../src/dry-run.ts";
import {
  composeLive,
  type LiveHarness,
  repositoryRegistryDir,
  SUBSCRIPTION_RUN_AUDIT_TOOL,
  scrubHostSessionEnv,
  subscriptionSpendRow,
} from "../src/harness.ts";
import { subscriptionRows } from "../src/ledger.ts";
import {
  LIVE_CODER_OVERRIDES,
  LIVE_SDK_CODER_OVERRIDES,
  patchSpecialistFrontmatter,
  prepareLiveRegistry,
} from "../src/registry.ts";

/**
 * The dry run: the whole harness on a scripted provider. The real runtime is composed
 * (composeRuntime, in-memory store, memory vault with the key by name, fake git host, patched
 * registry), one session runs one task through the PR executor and the critic, and the spend
 * ledger, the audit log and the store's cost ledger agree on what was "spent". No network.
 */
const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("registry copy for the live coder", () => {
  it("replaces the tool list and the caps, keeps every other key and the prompt", () => {
    const original = [
      "---",
      "name: coder",
      'version: "1.0.0"',
      "description: Implements a scoped code change.",
      "default_tier: sonnet",
      "default_effort: medium",
      "max_effort: high",
      "allowed_tools:",
      "  - cc:Read",
      "  - cc:Write",
      "allowed_domains: []",
      "max_budget_usd: 3.0",
      "max_turns: 80",
      "timeout_minutes: 45",
      "risk_tier_floor: 1",
      "eval_set: evals/coder",
      "status: active",
      "requires_sandbox: true",
      "output_contract: A diff limited to the brief.",
      "---",
      "# Coder",
      "",
      "Body stays.",
      "",
    ].join("\n");
    const patched = patchSpecialistFrontmatter(original, LIVE_CODER_OVERRIDES);
    expect(patched).toContain("allowed_tools:\n  - read_file\n  - write_file\n  - list_dir\n");
    expect(patched).toContain(
      "max_budget_usd: 0.5\nmax_turns: 12\ntimeout_minutes: 5\nrequires_sandbox: false\n---",
    );
    expect(patched).not.toContain("cc:Read");
    expect(patched).not.toContain("max_turns: 80");
    expect(patched).toContain("eval_set: evals/coder");
    expect(patched.endsWith("# Coder\n\nBody stays.\n")).toBe(true);
    expect(() => patchSpecialistFrontmatter("no frontmatter", LIVE_CODER_OVERRIDES)).toThrow(
      /frontmatter/,
    );
  });

  it("the copied registry loads with the coder runnable on the built-in tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-live-registry-"));
    temps.push(dir);
    const prepared = prepareLiveRegistry(repositoryRegistryDir(), join(dir, "registry"));
    expect(prepared.patched).toEqual(["coder"]);
    const registry = loadRegistry(prepared.dir, {
      toolNames: ["read_file", "write_file", "list_dir", "run_command"],
    });
    const coder = registry.specialists.get("coder");
    expect(coder?.runnable).toBe(true);
    expect(coder?.allowed_tools).toEqual(["read_file", "write_file", "list_dir"]);
    expect(coder?.max_turns).toBe(12);
    expect(coder?.requires_sandbox).toBe(false);
    expect(coder?.prompt).toContain("You are the coder specialist of Forerunner");
  });
});

describe("live harness dry run (scripted provider, no network)", () => {
  let h: LiveHarness;
  let ledgerDir: string;
  const clock = new SimulatedClock("2026-10-20T14:00:00Z");
  const script = (): ScriptedReply[] => [
    toolReply(
      "write_file",
      {
        path: "src/greet.ts",
        content:
          "export function greet(name: string): string {\n  return `Hello, ` + name + `!`;\n}\n",
      },
      "Writing the file.",
      {
        when: specialistTurn,
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 3000, output_tokens: 120 },
      },
    ),
    textReply(
      "Summary: added greet. Criteria: met (file written).\nLesson: keep greetings short and tested.",
      {
        when: specialistReportTurn,
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 3200, output_tokens: 60 },
      },
    ),
    submitReview({}, { times: Number.POSITIVE_INFINITY }),
    closingReply(),
  ];
  const compose = (runCapUsd: number) =>
    composeLive({
      env: { FORERUNNER_LIVE_RUN: "dry-run" },
      clock,
      inner: new FakeProvider({
        mode: "script",
        clock,
        latency: "none",
        onNoMatch: "throw",
        replies: script(),
      }),
      credentials: dryRunCredentials(),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
    });

  beforeAll(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-dry-"));
    temps.push(ledgerDir);
    h = await compose(15);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("composes the real runtime on an api_key billing source with the key held by name in the vault", async () => {
    const sources = await stateSources(h.app.store)(h.app.human.id);
    expect(sources.map((s) => s.kind)).toEqual(["api_key"]);
    expect(sources[0]?.credentialRef).toBe(SECRET_NAMES.anthropic);
    expect(await h.app.vault.has(SECRET_NAMES.anthropic)).toBe(true);
    expect(await h.app.vault.has(SECRET_NAMES.github)).toBe(true);
    expect(h.app.provider?.name).toBe("fake");
    expect(h.app.registry.specialists.get("coder")?.allowed_tools).toEqual([
      "read_file",
      "write_file",
      "list_dir",
    ]);
    expect(h.app.conversation).not.toBeNull();
    expect(h.host.repo(h.repo.full)?.defaultBranch).toBe("main");
  });

  it("one session completes a task through a PR on the fake host with every call in the spend ledger, the audit log and the cost ledger", async () => {
    const project = await h.addProject({ name: "Dry run", goal: "Prove the harness" });
    const task = await h.addTask(project, {
      title: "Add greet",
      outcome: "src/greet.ts exports greet(name)",
      acceptanceCriteria: ["src/greet.ts exports greet(name: string): string"],
    });
    const events: string[] = [];
    const res = await h.startSession({
      projectId: project,
      budgetCapUsdMicro: 2_000_000,
      onEvent: (type) => events.push(type),
    });
    expect(res.status).toBe("completed");
    expect(res.failed).toEqual([]);
    expect(res.needsHuman).toEqual([]);
    expect([...res.completed, ...res.inReview]).toEqual([task.id]);
    expect(events).toContain("task.started");
    const prs = await h.app.gitHost.listPullRequests({ owner: h.repo.owner, name: h.repo.name });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.head.ref).toMatch(/^fr\//);

    // Every model call (coder turns, critic turns) is one ledger row of this run, priced.
    const rows = h.ledger.rows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.run === "dry-run" && r.usd > 0 && r.note === undefined)).toBe(true);
    expect(rows.filter((r) => r.model === "fake-sonnet").length).toBe(rows.length);
    expect(h.provider.calls).toHaveLength(rows.length);
    expect(h.budget.refusals).toEqual([]);
    expect(h.budget.snapshot().inFlightUsd).toBe(0);
    const text = readFileSync(h.ledger.path, "utf8");
    expect(text).not.toContain(dryRunCredentials().apiKey);
    // The store's cost ledger (what the product bills) saw the same tokens as the spend ledger.
    const sum = await h.app.store.costLedger.sum({ sessionId: res.sessionId });
    expect(sum.tokens_in).toBe(rows.reduce((s, r) => s + r.tokensIn, 0));
    expect(sum.tokens_out).toBe(rows.reduce((s, r) => s + r.tokensOut, 0));
    expect(sum.entries).toBeGreaterThan(0);
    // One audit row per live call, none denied; the runs stayed under the task cap.
    const audit = await h.app.store.auditLog.list(undefined, { limit: 10_000 });
    const liveRows = audit.filter((a) => a.tool === "live.model_call");
    expect(liveRows).toHaveLength(rows.length);
    expect(liveRows.every((a) => a.allowed)).toBe(true);
    const runs = await h.app.store.run.forSession(res.sessionId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((r) => r.cost_usd_micro <= 400_000)).toBe(true);
    expect(res.spentUsdMicro).toBeLessThanOrEqual(2_000_000);
  });

  it("a call the run cap cannot cover is refused in code and surfaces as a failed task with the reason", async () => {
    // A second composition on the same ledger and run id, with the per-run cap one micro-USD
    // above what the run has already spent: the next call is refused before it is sent.
    const before = h.ledger.rows().length;
    const tight = await compose(h.ledger.runUsd("dry-run") + 0.000001);
    try {
      const project = await tight.addProject({ name: "Dry run capped", goal: "Refusal path" });
      await tight.addTask(project, {
        title: "Add farewell",
        outcome: "src/farewell.ts exports farewell(name)",
        acceptanceCriteria: ["src/farewell.ts exists"],
      });
      const res = await tight.startSession({ projectId: project, budgetCapUsdMicro: 2_000_000 });
      expect(res.failed.length + res.needsHuman.length).toBe(1);
      expect(tight.budget.refusals.length).toBeGreaterThanOrEqual(1);
      expect(tight.budget.refusals[0]?.reason).toContain("per-run cap");
      expect(tight.ledger.rows()).toHaveLength(before);
      expect(tight.provider.inner).toBeInstanceOf(FakeProvider);
      expect((tight.provider.inner as FakeProvider).calls).toHaveLength(0);
      const audit = await tight.app.store.auditLog.list(undefined, { limit: 10_000 });
      const denied = audit.filter((a) => a.tool === "live.model_call" && !a.allowed);
      expect(denied.length).toBeGreaterThanOrEqual(1);
      expect(denied[0]?.denied_reason).toContain("per-run cap");
    } finally {
      await tight.close();
    }
  });
});

/**
 * The dry run of the subscription half (ADR 0044): both credentials in the vault, the router
 * picks the subscription for the human's own agent on the personal runner, the task runs
 * through the Agent SDK driver on a fake `query` (never a Claude Code subprocess) with the
 * token in the subprocess environment and the registry's `cc:` names, the hooks deny a path
 * outside the worktree as `PreToolUse`, the Run row cites the subscription source, the store's
 * rows are "subscription", and the spend ledger gets a USD 0 row with the note. The token
 * reaches the vault and the fake subprocess environment and nothing else.
 */
describe("live harness dry run of the subscription half (fake SDK query, no network)", () => {
  let h: LiveHarness;
  let ledgerDir: string;
  const clock = new SimulatedClock("2026-10-20T15:00:00Z");
  const logs: LogRecord[] = [];
  let offLogs: () => void = () => undefined;
  const token = dryRunCredentials({ subscription: true }).subscriptionToken ?? "";
  const sdkCalls: { prompt: string; options: Record<string, unknown> }[] = [];
  const hookDecisions: Record<string, string> = {};
  type PreHook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const decisionOf = (r: Record<string, unknown>): string => {
    const out = r.hookSpecificOutput as
      | { permissionDecision: string; permissionDecisionReason?: string }
      | undefined;
    return `${out?.permissionDecision ?? ""} ${out?.permissionDecisionReason ?? ""}`.trim();
  };
  const sdk: QueryLike = ({ prompt, options }) => {
    const o = options ?? {};
    sdkCalls.push({ prompt, options: o });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-dry-1" };
      const cwd = String(o.cwd);
      const hooks = o.hooks as { PreToolUse: { hooks: PreHook[] }[] };
      const pre = hooks.PreToolUse[0]?.hooks[0];
      if (pre) {
        hookDecisions.outside = decisionOf(
          await pre({
            tool_name: "Read",
            tool_input: { file_path: join(tmpdir(), "elsewhere.txt") },
            tool_use_id: "t1",
          }),
        );
        hookDecisions.inside = decisionOf(
          await pre({
            tool_name: "Write",
            tool_input: { file_path: join(cwd, "src", "greet.ts"), content: "" },
            tool_use_id: "t2",
          }),
        );
      }
      // What the subprocess's Write tool would do: the change the PR executor then commits.
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(
        join(cwd, "src", "greet.ts"),
        "export function greet(name: string): string {\n  return `Hello, ` + name + `!`;\n}\n",
        "utf8",
      );
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Added greet. Criteria: met. Lesson: none." }],
          usage: {
            input_tokens: 1_500,
            output_tokens: 300,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Added greet. Criteria: met. Lesson: none.",
        total_cost_usd: 0.0061,
      };
    })();
  };
  const criticScript = (): ScriptedReply[] => [
    submitReview({}, { times: Number.POSITIVE_INFINITY }),
    closingReply(),
  ];

  beforeAll(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-dry-sub-"));
    temps.push(ledgerDir);
    offLogs = Logger.addSink((r) => logs.push(r));
    h = await composeLive({
      env: { FORERUNNER_LIVE_RUN: "dry-run-sub" },
      clock,
      inner: new FakeProvider({
        mode: "script",
        clock,
        latency: "none",
        onNoMatch: "throw",
        replies: criticScript(),
      }),
      credentials: dryRunCredentials({ subscription: true }),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd: 15, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
      subscription: true,
      sdkQuery: sdk,
      planUsdMonthly: 100,
    });
  });
  afterAll(async () => {
    offLogs();
    await h?.close();
  });

  it("composes both billing sources, the coder on the registry's cc: names and a grant that carries them", async () => {
    const sources = await stateSources(h.app.store)(h.app.human.id);
    expect(sources.map((s) => s.kind).sort()).toEqual(["api_key", "subscription"]);
    expect(sources.find((s) => s.kind === "subscription")?.credentialRef).toBe(
      SECRET_NAMES.anthropicOauth,
    );
    expect(await h.app.vault.has(SECRET_NAMES.anthropicOauth)).toBe(true);
    expect(await h.app.vault.has(SECRET_NAMES.anthropic)).toBe(true);
    expect(h.subscription).toBe(true);
    expect(h.app.billing.planAllowance).toMatchObject({ usdMonthly: 100, origin: "option" });
    expect(h.app.billing.hostCommands).toBe(false);
    expect(h.app.registry.specialists.get("coder")?.allowed_tools).toEqual(
      LIVE_SDK_CODER_OVERRIDES.tools,
    );
    expect(h.app.registry.specialists.get("coder")?.max_turns).toBe(12);
    expect(h.grant().allowedTools).toEqual(expect.arrayContaining(["cc:Read", "cc:Write"]));
    // The loop paths (critic, chat) stay on the key; a task picks the subscription.
    expect(h.app.billingSourceId).toBe(sources.find((s) => s.kind === "api_key")?.id);
    const pick = await h.app.billing.pick.pick({
      agentId: h.app.agent.id,
      agentOwnerHumanId: h.app.human.id,
      runner: "pc",
      modelTier: "sonnet",
      purpose: "session",
    });
    expect(pick.source.kind).toBe("subscription");
    expect(pick.driver).toBe("sdk");
    expect(JSON.stringify(sources)).not.toContain(token);
    // Without a token the subscription half refuses to compose, before any resource is made.
    await expect(
      composeLive({
        subscription: true,
        credentials: dryRunCredentials(),
        ledgerPath: join(ledgerDir, "unused.json"),
        inner: new FakeProvider({ mode: "script", clock, latency: "none", replies: [] }),
        config: { capUsd: 100, runCapUsd: 15, warnShare: 0.8 },
      }),
    ).rejects.toThrow(/no subscription token/);
  });

  it("one session runs the task through the SDK driver on the subscription, the hooks apply, and the ledgers record plan usage with no USD", async () => {
    const project = await h.addProject({
      name: "Dry run sub",
      goal: "Prove the subscription half",
    });
    const task = await h.addTask(project, {
      title: "Add greet",
      outcome: "src/greet.ts exports greet(name)",
      acceptanceCriteria: ["src/greet.ts exports greet(name: string): string"],
    });
    const metered = h.provider.calls.length;
    const res = await h.startSession({ projectId: project, budgetCapUsdMicro: 2_000_000 });
    expect(res.status).toBe("completed");
    expect(res.failed).toEqual([]);
    expect([...res.completed, ...res.inReview]).toEqual([task.id]);
    const prs = await h.app.gitHost.listPullRequests({ owner: h.repo.owner, name: h.repo.name });
    expect(prs).toHaveLength(1);

    // The SDK driver ran the coder: one fake query call with the token in its environment, the
    // `cc:` names minus Bash, the worktree as its working directory.
    expect(sdkCalls).toHaveLength(1);
    const call = sdkCalls[0] as { prompt: string; options: Record<string, unknown> };
    const env = call.options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect([...(call.options.allowedTools as string[])].sort()).toEqual(
      ["Edit", "Glob", "Grep", "MultiEdit", "Read", "Write"].sort(),
    );
    expect(String(call.options.cwd).startsWith(h.app.dirs.worktrees)).toBe(true);
    expect(call.options.maxTurns).toBe(12);
    expect(call.prompt).toContain("Add greet");
    // The hooks ran as PreToolUse: a path outside the worktree denied, one inside allowed.
    expect(hookDecisions.outside).toMatch(/^deny path_not_allowed/);
    expect(hookDecisions.inside).toBe("allow");

    // The Run rows: the coder on the SDK provider and the subscription source; the critic on
    // the Messages provider and the key.
    const sources = await stateSources(h.app.store)(h.app.human.id);
    const sub = sources.find((s) => s.kind === "subscription");
    const key = sources.find((s) => s.kind === "api_key");
    const runs = await h.app.store.run.forSession(res.sessionId);
    const coder = runs.filter((r) => r.specialist === "coder");
    expect(coder).toHaveLength(1);
    expect(coder[0]).toMatchObject({
      provider: SDK_RUN_PROVIDER,
      billing_source_id: sub?.id,
      outcome: "completed",
      tokens_in: 1_500,
      tokens_out: 300,
    });
    expect(coder[0]?.artifacts[0]).toMatchObject({ driver: "sdk", sdk_cost_usd_micro: 6_100 });
    for (const r of runs.filter((r) => r.specialist !== "coder")) {
      expect(r.billing_source_id).toBe(key?.id);
      expect(r.provider).toBe("fake");
    }
    const subRows = await h.app.store.costLedger.list(
      { billing_source_id: sub?.id },
      { limit: 100 },
    );
    expect(subRows.length).toBeGreaterThan(0);
    expect(subRows.every((r) => r.kind === "subscription" && r.run_id === coder[0]?.id)).toBe(true);
    expect(subRows.every((r) => (r.plan_usage_share ?? 0) > 0)).toBe(true);
    // The key's ledger holds nothing of the subscription run.
    const keySum = await h.app.store.costLedger.sum({ billingSourceId: key?.id });
    const keySubRows = await h.app.store.costLedger.sum({
      billingSourceId: key?.id,
      kind: "subscription",
    });
    expect(keySubRows.entries).toBe(0);
    expect(keySum.entries).toBe(
      (await h.app.store.costLedger.sum({ sessionId: res.sessionId, kind: "api" })).entries,
    );
    const audit = await h.app.store.auditLog.list({ runId: coder[0]?.id ?? "" });
    expect(audit.find((a) => a.tool === BILLING_PICK_AUDIT_TOOL)?.input_summary).toContain(
      '"driver":"sdk"',
    );
    expect(audit.find((a) => a.tool === TOOL_UNMAPPED_AUDIT)).toMatchObject({
      allowed: false,
      input_summary: "coder: cc:Bash",
    });
    expect(audit.filter((a) => a.tool === "cc:Read" && !a.allowed)).toHaveLength(1);

    // The spend ledger: the critic's metered calls priced as before, plus one subscription row
    // per SDK run with USD 0 and the note; the budget's totals are the metered calls alone.
    const beforeSettle = h.ledger.rows();
    expect(subscriptionRows(beforeSettle)).toEqual([]);
    const settled = await h.settleSubscriptionRuns(res.sessionId);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      run: "dry-run-sub",
      model: "claude-sonnet-5-5",
      tokensIn: 1_500,
      tokensOut: 300,
      usd: 0,
      kind: "subscription",
      note: "subscription: plan usage, est. USD 0.0061",
    });
    expect(await h.settleSubscriptionRuns(res.sessionId)).toEqual([]);
    const rows = h.ledger.rows();
    expect(rows).toHaveLength(beforeSettle.length + 1);
    expect(subscriptionRows(rows)).toEqual([settled[0]]);
    const meteredCalls = h.provider.calls.slice(metered);
    expect(meteredCalls.length).toBeGreaterThan(0);
    expect(h.budget.snapshot().runUsd).toBe(
      Math.round(meteredCalls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
    );
    const subAudit = (await h.app.store.auditLog.list({ runId: coder[0]?.id ?? "" })).filter(
      (a) => a.tool === SUBSCRIPTION_RUN_AUDIT_TOOL,
    );
    expect(subAudit).toHaveLength(1);
    expect(subAudit[0]?.result_summary).toContain("est. USD 0.0061");
    expect(subAudit[0]?.cost_usd_micro).toBe(0);

    // The token is in the vault and the fake subprocess environment and nowhere else.
    const text = readFileSync(h.ledger.path, "utf8");
    for (const blob of [
      text,
      JSON.stringify(runs),
      JSON.stringify(await h.app.store.auditLog.list(undefined, { limit: 10_000 })),
      JSON.stringify(subRows),
      JSON.stringify(h.provider.calls),
      JSON.stringify(logs),
      JSON.stringify(res),
    ]) {
      expect(blob).not.toContain(token);
      expect(blob).not.toContain(["sk-", "ant-", "oat"].join(""));
    }
  });

  it("strips the hosting Claude Code session's variables for a real subprocess, keeps the proxy flag and everything else, and leaves a faked SDK's environment alone", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
      CLAUDE_CODE_PROXY_RESOLVES_HOSTS: "1",
      CLAUDE_PID: "7",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NODE_EXTRA_CA_CERTS: "/x/ca.crt",
      FORERUNNER_LIVE: "1",
      PATH: "/bin",
    };
    const removed = scrubHostSessionEnv(env);
    expect(removed).toEqual([
      "CLAUDECODE",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_REMOTE",
      "CLAUDE_PID",
    ]);
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
      "FORERUNNER_LIVE",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
    ]);
    expect(scrubHostSessionEnv(env)).toEqual([]);
    // The dry run above faked the SDK, so the worker's environment was left as it was.
    expect(h.hostEnvScrubbed).toEqual([]);
  });

  it("a killed or errored SDK run still gets its ledger row, with the outcome and the hooks' estimate in the note", () => {
    const base = {
      id: "run-x",
      task_id: "t",
      session_id: "s",
      specialist: "coder",
      model: "claude-sonnet-5-5",
      provider: SDK_RUN_PROVIDER,
      tokens_in: 10,
      tokens_out: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd_micro: 1_234,
      artifacts: [{ driver: "sdk", sdk_session_id: null, sdk_cost_usd_micro: 0 }],
    };
    const killed = subscriptionSpendRow(
      { ...base, outcome: "killed" } as never,
      "r9",
      "2026-10-20",
    );
    expect(killed).toMatchObject({ usd: 0, kind: "subscription", tokensIn: 10, run: "r9" });
    expect(killed.note).toBe(
      "subscription: plan usage, est. USD 0.0000; killed; no SDK cost reported, hooks est. USD 0.0012",
    );
    const done = subscriptionSpendRow(
      {
        ...base,
        outcome: "completed",
        artifacts: [{ driver: "sdk", sdk_session_id: "x", sdk_cost_usd_micro: 25_000 }],
      } as never,
      "r9",
      "2026-10-20",
    );
    expect(done.note).toBe("subscription: plan usage, est. USD 0.0250");
  });
});
