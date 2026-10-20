import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, Logger, type LogRecord, type SimulatedClock } from "@forerunner/platform";
import type { AgentRow, HumanRow, ProjectRow, StateStore } from "@forerunner/state";
import { type RunnerConfig, readRunnerConfig } from "../src/config.ts";

/**
 * Shared fixtures for the runner tests: one human (J) with agent Alice and a project, a
 * configuration built from an environment the way main.ts does, and a log capture that
 * records every line a file sink would write (for the "key never in logs" assertions).
 */
export const OWNER_EMAIL = "j@example.test";

export interface Seed {
  human: HumanRow;
  agent: AgentRow;
  project: ProjectRow;
}

export async function seedWorld(
  store: StateStore,
  opts: { projectSettings?: Record<string, unknown>; timezone?: string } = {},
): Promise<Seed> {
  const human = await store.human.insert({
    name: "J",
    email: OWNER_EMAIL,
    timezone: opts.timezone ?? "Europe/Zurich",
    notify_prefs: {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 0,
    locale: "en",
  });
  const agent = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const project = await store.project.insert({
    name: "Sample",
    goal: "Ship the sample",
    repos: [],
    stage: "build",
    status: "active",
    budget_usd_micro: 0,
    autonomy_level: 2,
    summary_cache: {},
    data_assets: [],
    settings: opts.projectSettings ?? {},
    small_project_mode: false,
    active: true,
  });
  return { human, agent, project };
}

export async function addReadyTask(
  store: StateStore,
  projectId: string,
  title: string,
  over: Record<string, unknown> = {},
) {
  return store.task.insert({
    project_id: projectId,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 0,
    status: "ready",
    priority: 5,
    depends_on: [],
    budget_usd_micro: 1_000_000,
    est_cost_usd_micro: 400_000,
    actual_cost_usd_micro: 0,
    attempt: 0,
    reason: "seed",
    ...over,
  });
}

export function tempHome(prefix = "fr-runner-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A runner configuration from an environment, with test-friendly intervals. */
export function testConfig(
  home: string,
  stateUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; config: RunnerConfig } {
  const env: NodeJS.ProcessEnv = {
    FORERUNNER_HOME: home,
    FORERUNNER_STATE_URL: stateUrl,
    FORERUNNER_RUNNER_ID: "runner-test",
    FORERUNNER_RUNNER_HEALTH_PORT: "0",
    FORERUNNER_RUNNER_MAIL_VERIFIER: "header",
    FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS: "mx.example.test",
    FORERUNNER_RUNNER_MAIL_CHECK_MS: "60000",
    FORERUNNER_RUNNER_HEARTBEAT_MS: "60000",
    FORERUNNER_RUNNER_COMMAND_POLL_MS: "500",
    FORERUNNER_RUNNER_SCHEDULE_TICK_MS: "60000",
    FORERUNNER_RUNNER_UNLOCK_POLL_MS: "500",
    FORERUNNER_RUNNER_UNLOCK_TIMEOUT_MS: "600000",
    FORERUNNER_VERSION: "0.1.0-test",
    ...overrides,
  };
  return { env, config: readRunnerConfig(env) };
}

/** Every log record emitted while `fn` runs, rendered the way a file sink would write it. */
export async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[]; records: LogRecord[] }> {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const off = Logger.addSink((rec) => {
    records.push(rec);
    lines.push(
      `${rec.level} [${rec.scope}] ${rec.msg}${rec.data ? ` ${JSON.stringify(rec.data)}` : ""}`,
    );
  });
  const previous = process.env.FORERUNNER_LOG_LEVEL;
  Logger.setLevel("debug");
  try {
    const result = await fn();
    return { result, lines, records };
  } finally {
    off();
    Logger.setLevel((previous as "debug" | "info" | "warn" | "error" | undefined) ?? "info");
  }
}

/** Let promise continuations settle (one macrotask turn). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Advance a simulated clock one second at a time, yielding `realStepMs` of wall time between
 * steps so real I/O (SMTP, SQLite, key derivation) progresses, until `done` or `maxMs` of
 * simulated time passed. Returns the simulated time advanced. One simulated minute is three
 * seconds of wall time, so a "within a minute" assertion has a comfortable real budget.
 */
export async function advanceUntil(
  clock: SimulatedClock,
  done: () => boolean,
  maxMs: number,
  realStepMs = 50,
): Promise<number> {
  let elapsed = 0;
  while (!done() && elapsed < maxMs) {
    await new Promise((r) => setTimeout(r, realStepMs));
    if (done()) break;
    await clock.advance(1_000);
    elapsed += 1_000;
  }
  return elapsed;
}

/** Poll `fn` with the system clock until it returns a value or `ms` wall time passed. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  ms = 5_000,
  stepMs = 20,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`waitFor: nothing after ${ms} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
