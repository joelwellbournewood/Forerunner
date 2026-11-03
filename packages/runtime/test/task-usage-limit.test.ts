import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import type { CommandResultJson, TaskView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { BILLING_REST_AUDIT_TOOL } from "../src/wiring/billing-pick.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * U-078 (ADR 0100 amended 2026-11-03, the owner's decision of 2026-11-02): a task run on the
 * Claude subscription that meets the plan's usage limit is no failure of the work. The
 * subscription rests until the reset Claude Code reported and the task goes back to ready with
 * the same attempt count (the retry ladder does not advance and no critic reviews it). Then the
 * person's setting "When my first choice runs out mid-session" decides, and the log says what
 * really happens:
 * - "Wait" (the default): nothing moves onto the API key; the task waits for the reset, the
 *   sentence says so, and a session starts by itself at the reset.
 * - "Use the other one": the task goes on at once, in the same session, on the API key.
 * Before, the task was held out of the session, its sentence promised "runs on the next
 * credential", and the session's other tasks moved onto the API key with no start scheduled.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "tasklimit", "5".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "tasklimit", "6".repeat(40)].join(""); // not-a-secret

function limitedClaudeCode(resetAt: string, calls: string[], limitedCalls = 1): QueryLike {
  return ({ prompt }) => {
    calls.push(prompt);
    const limited = calls.length <= limitedCalls;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-limit" };
      if (!limited) {
        yield {
          type: "assistant",
          message: {
            id: `m${calls.length}`,
            content: [{ type: "text", text: "Wrote it on the subscription. Lesson: none." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Wrote it on the subscription. Lesson: none.",
        };
        return;
      }
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
}

async function compose(clock: SimulatedClock, sdkQuery: QueryLike, provider: ScriptedProvider) {
  const home = mkdtempSync(join(tmpdir(), "fr-task-limit-"));
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault({
      [SECRET_NAMES.anthropicOauth]: OAUTH,
      [SECRET_NAMES.anthropic]: API_KEY,
    }),
    // The critic reviews every task (ADR 0104): it accepts here; `provider` sees the rest.
    provider: new AcceptingCriticProvider(provider),
    sdkQuery,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
  });
  const { app, token } = createDaemonApp(rt);
  const req = async <T>(path: string, body?: unknown): Promise<T> =>
    (await (
      await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).json()) as T;
  return { rt, req };
}

const start = (
  rt: RuntimeApp,
  projectId: string,
  events: { type: string; payload: Record<string, unknown> }[],
) =>
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

async function changelogTask(rt: RuntimeApp) {
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
  return { project, task };
}

describe("a task run that meets the subscription's usage limit, under 'Wait' (U-078)", () => {
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const resetAt = "2026-10-31T14:00:00.000Z";
  const sdkCalls: string[] = [];
  let provider: ScriptedProvider;

  beforeAll(async () => {
    provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    ({ rt, req } = await compose(clock, limitedClaudeCode(resetAt, sdkCalls), provider));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("waits for the reset with nothing on the API key, says so, and starts by itself at the reset", async () => {
    const { project, task } = await changelogTask(rt);
    expect(task.attempt).toBe(0);

    // The default order for task runs: the subscription first, on the Agent SDK.
    const first: { type: string; payload: Record<string, unknown> }[] = [];
    const result = await start(rt, project.id, first);
    expect(sdkCalls).toHaveLength(1);
    // Nothing moved onto the API key (the owner's 'Wait': plan-limit work never becomes money).
    expect(provider.calls).toHaveLength(0);
    const after = await rt.store.task.mustGet(task.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(0);
    expect(after.claimed_by).toBeNull();
    // Never through `failed` (which would count an attempt), and no critic review.
    expect(first.some((e) => e.type === "critic.review_started")).toBe(false);
    const finished = first.find((e) => e.type === "task.finished");
    expect(finished?.payload.outcome).toBe("usage_limit");
    // The session log's sentence, as the person reads it: what is really scheduled.
    const fallback = first.find((e) => e.type === "billing.fallback");
    expect(describeEvent("billing.fallback", fallback?.payload ?? {})).toBe(
      'Your Claude subscription reached its usage limit; "Write the changelog" waits until 15:00 (your subscription\'s limit) and starts by itself.',
    );
    expect(result.summary.split("\n")[0]).toBe(
      "Waits until 15:00 (your subscription's limit) and starts by itself.",
    );
    // The row says the same.
    const rows = await req<TaskView[]>(`/projects/${project.id}/tasks`);
    expect(rows[0]?.display?.label).toBe("Waits until 15:00, your subscription's limit");
    // The subscription rests until the reset Claude Code reported, on its row and in the audit.
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect(sub?.limits.restingUntil).toBe(resetAt);
    const rests = await rt.store.auditLog.list({ tool: BILLING_REST_AUDIT_TOOL } as never, {
      limit: 10,
    });
    expect(rests).toHaveLength(1);

    // A session started before the reset waits too: still nothing on the API key.
    await start(rt, project.id, []);
    expect(sdkCalls).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);

    // At the reset the scheduler starts the project's session by itself, on the subscription.
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    await rt.scheduler.tick();
    const end = Date.now() + 20_000;
    while ((await rt.store.task.mustGet(task.id)).status !== "done" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    const done = await rt.store.task.mustGet(task.id);
    expect(done.status, "the task the reset's session ran").toBe("done");
    expect(done.attempt).toBe(0);
    expect(sdkCalls).toHaveLength(2);
    expect(
      provider.calls.filter((c) => !(c.tools ?? []).some((t) => t.name === "submit_review")),
    ).toHaveLength(0);
  }, 60_000);
});

describe("a task run that meets the subscription's usage limit, under 'Use the other one' (U-078)", () => {
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const sdkCalls: string[] = [];
  let provider: ScriptedProvider;

  beforeAll(async () => {
    provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    ({ rt, req } = await compose(
      clock,
      limitedClaudeCode("2026-10-31T14:00:00.000Z", sdkCalls),
      provider,
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("goes on at once in the same session on the API key, and the log says so", async () => {
    // Settings: "When my first choice runs out mid-session: Use the other one" (a yes, since it
    // moves plan-limit work onto money: the screen's tap).
    const set = await req<CommandResultJson>("/commands/execute", {
      commands: [
        { name: "settings.set", params: { key: "mid_session_limit", value: "use_other" } },
      ],
      source: "ui",
      confirm: "tap",
    });
    expect(set.status).toBe("done");
    const { project, task } = await changelogTask(rt);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    await start(rt, project.id, events);
    expect(sdkCalls).toHaveLength(1);
    const done = await rt.store.task.mustGet(task.id);
    expect(done.status).toBe("done");
    expect(done.attempt).toBe(0);
    expect(provider.calls.length).toBeGreaterThan(0);
    const fallback = events.find((e) => e.type === "billing.fallback");
    expect(describeEvent("billing.fallback", fallback?.payload ?? {})).toBe(
      'Your Claude subscription reached its usage limit; "Write the changelog" continues on your API key now.',
    );
  }, 60_000);
});
