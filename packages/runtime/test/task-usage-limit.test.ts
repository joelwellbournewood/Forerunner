import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { BILLING_REST_AUDIT_TOOL } from "../src/wiring/billing-pick.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-078 (ADR 0100): a task run on the Claude subscription that meets the plan's usage limit is
 * no failure of the work. The subscription rests until the reset Claude Code reported, the task
 * goes back to ready with the same attempt count (the retry ladder does not advance and no
 * critic reviews it), the session log says so in a plain sentence, and the next session runs
 * the task on the API key.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "tasklimit", "5".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "tasklimit", "6".repeat(40)].join(""); // not-a-secret

describe("a task run that meets the subscription's usage limit (U-078)", () => {
  let rt: RuntimeApp;
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const resetAt = "2026-10-31T14:00:00.000Z";
  const sdkCalls: string[] = [];
  const sdkQuery: QueryLike = ({ prompt }) => {
    sdkCalls.push(prompt);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-limit" };
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Date.parse(resetAt) / 1000,
          rateLimitType: "five_hour",
        },
      };
      yield {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 2pm" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
    })();
  };
  let provider: ScriptedProvider;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-task-limit-"));
    provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({
        [SECRET_NAMES.anthropicOauth]: OAUTH,
        [SECRET_NAMES.anthropic]: API_KEY,
      }),
      provider,
      sdkQuery,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const start = (projectId: string, events: { type: string; payload: Record<string, unknown> }[]) =>
    rt.runner.start({
      agentId: rt.agent.id,
      projectId,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant: {
        allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
      },
      onEvent: (type, payload) => events.push({ type, payload }),
    });

  it("goes back to ready with the same attempt count, the subscription rests, and the next session uses the API key", async () => {
    const project = await rt.store.project.insert({
      name: "Limits",
      goal: "Keep working",
      autonomy_level: 2,
    });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the changelog",
      outcome: "the changelog is written",
      acceptance_criteria: ["it is written"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 100_000,
      reason: "seed",
    });
    expect(task.attempt).toBe(0);

    // The default order for task runs: the subscription first, on the Agent SDK.
    const first: { type: string; payload: Record<string, unknown> }[] = [];
    await start(project.id, first);
    expect(sdkCalls).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    const after = await rt.store.task.mustGet(task.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(0);
    expect(after.claimed_by).toBeNull();
    // Never through `failed` (which would count an attempt), and no critic review.
    expect(first.some((e) => e.type === "critic.review_started")).toBe(false);
    const finished = first.find((e) => e.type === "task.finished");
    expect(finished?.payload.outcome).toBe("usage_limit");
    // The session log's sentence, as the person reads it.
    const fallback = first.find((e) => e.type === "billing.fallback");
    expect(fallback).toBeDefined();
    expect(describeEvent("billing.fallback", fallback?.payload ?? {})).toBe(
      'The Claude subscription reached its usage limit and rests until 2026-10-31 14:00 UTC; "Write the changelog" goes back to ready and runs on the next credential, without counting a retry.',
    );
    // The subscription rests until the reset Claude Code reported, on its row and in the audit.
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect(sub?.limits.restingUntil).toBe(resetAt);
    const rests = await rt.store.auditLog.list({ tool: BILLING_REST_AUDIT_TOOL } as never, {
      limit: 10,
    });
    expect(rests).toHaveLength(1);

    // The next session picks the API key (the subscription rests) and finishes the task.
    const second: { type: string; payload: Record<string, unknown> }[] = [];
    await start(project.id, second);
    expect(sdkCalls).toHaveLength(1);
    expect(provider.calls.length).toBeGreaterThan(0);
    const done = await rt.store.task.mustGet(task.id);
    expect(done.status).toBe("done");
    expect(done.attempt).toBe(0);
  });
});
