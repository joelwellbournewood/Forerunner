import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { planItemFor } from "../src/session/executor.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { ScriptedProvider, until } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixture, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "late", "0".repeat(40)].join(""); // not-a-secret

/**
 * R-lateusage at the Run row (leftovers of wave 7): a task's run on the subscription that Stop
 * all ends while Claude Code still reports usage. Before, the killed run's late messages were
 * never read: the ledger and the task drawer's run missed the tail. The SDK's `query` is a fake
 * that plays Claude Code winding down after the abort.
 */
describe("a killed subscription run's tail reaches the ledger and its Run row (R-lateusage)", () => {
  let rt: RuntimeApp;
  let home: string;
  const clock = new SimulatedClock("2026-11-08T09:00:00Z");
  let firstSeen = false;

  const usage = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  const q: QueryLike = ({ options }) => {
    const ac = (options as { abortController: AbortController }).abortController;
    const model = String((options as { model?: string }).model);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "cc", tools: ["Read"] };
      yield {
        type: "assistant",
        message: {
          id: "m1",
          model,
          content: [{ type: "text", text: "Working." }],
          usage: usage(1_000, 100),
        },
      };
      firstSeen = true;
      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) resolve();
        else ac.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // Claude Code winding down after Stop all: one more message and its result.
      yield {
        type: "assistant",
        message: {
          id: "m2",
          model,
          content: [{ type: "text", text: "Late." }],
          usage: usage(4_000, 400),
        },
      };
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "aborted",
        total_cost_usd: 0,
      };
    })();
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-late-usage-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, FORERUNNER_PLAN_USD_MONTHLY: "100" },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ [SECRET_NAMES.anthropicOauth]: OAUTH }),
      provider: new ScriptedProvider([{ text: "unused" }], clock),
      gitHost: new MemoryGitHost("alice"),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
      sdkQuery: q,
    });
  });
  afterAll(async () => {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the run row's cost and tokens include what Claude Code reported after the stop", async () => {
    const projectId = (await rt.store.project.insert({ name: "Docs", goal: "g", repos: [] })).id;
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Write the notes",
      outcome: "docs/notes.md lists the steps",
      risk_tier: 1,
      status: "in_progress",
      budget_usd_micro: 5_000_000,
    });
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      status: "running",
      runner: "pc",
    });
    const token = rt.tokens.issue({
      runId: `run-session-${task.id}`,
      sessionId: session.id,
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId,
      allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
      allowedPaths: (await rt.sessionGrant(projectId))?.allowedPaths ?? [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 10_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 3,
      planApproved: true,
      expiresAt: new Date(clock.now() + 600_000).toISOString(),
    });
    const running = rt.executor.execute({
      task,
      session,
      token,
      budget: new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro: 10_000_000,
        stepCap: 50,
        deadlineMs: clock.now() + 600_000,
        reserveShare: 0,
      }),
      item: planItemFor(task, "writer"),
      signal: new AbortController().signal,
    });
    await until(() => firstSeen, "the first message");
    await rt.kill.stop("all", "Stop all", { by: "stop_all" });
    const res = await running;
    expect(res.outcome).toBe("killed");
    const ledger = async () =>
      (await rt.store.costLedger.list({ task_id: task.id } as never, {
        limit: 100,
      })) as unknown as {
        usd_micro: number;
        tokens_in: number;
      }[];
    const runRow = async () => (await rt.store.run.list({ task_id: task.id } as never))[0];
    // The tail is read in the background after the run returned: wait for it (at most 10 s).
    const deadline = Date.now() + 10_000;
    let seen = { ledgerIn: 0, runIn: 0 };
    for (;;) {
      seen = {
        ledgerIn: (await ledger()).reduce((s, r) => s + r.tokens_in, 0),
        runIn: (await runRow())?.tokens_in ?? 0,
      };
      if ((seen.ledgerIn === 5_000 && seen.runIn === 5_000) || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Before: only m1 was booked (1,000 tokens in); the tail (4,000 in) was never read.
    expect(seen, "ledger and run row tokens in, after 10 s at most").toEqual({
      ledgerIn: 5_000,
      runIn: 5_000,
    });
    const booked = (await ledger()).reduce((s, r) => s + r.usd_micro, 0);
    expect((await runRow())?.cost_usd_micro).toBe(booked);
  }, 30_000);
});
