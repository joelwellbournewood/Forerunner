import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { type KeyAnswer, messagesApiStandIn, standInFetch } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { InboxView, TaskView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * A session's work that waits for a Claude credential (U-078, ADR 0100 points 9 and 10), composed
 * as `fr daemon` composes it: the routed provider over the vault's key calls the Messages API
 * stand-in (testenv), which answers a call with the key's usage limit when the test says so.
 * The person's view is read through the routes the screens call.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixture, built by concatenation so no scanner sees a token.
const KEY = ["sk-ant-api03-", "cred-good-", "3".repeat(40)].join(""); // not-a-secret
/** The critic's tool: a request that offers it is a review's call. */
const SUBMIT_REVIEW = "submit_review";

const runtimes: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close().catch(() => undefined);
});

/**
 * The daemon on a key whose limit the test switches on: `limitReviews(ms)` answers the next
 * review call (and every call until then) with the usage limit for `ms` from that call.
 */
function world(clock: SimulatedClock) {
  const home = mkdtempSync(join(tmpdir(), "fr-cred-wait-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const vault = new MemoryVault();
  const model = new AcceptingCriticProvider(
    new ScriptedProvider([{ text: "Wrote the note. Lesson: none." }], clock),
  );
  let reviewLimitMs: number | null = null;
  let limitedUntil: number | null = null;
  const answerFor = (_key: string, nowMs: number): KeyAnswer => {
    if (limitedUntil === null || nowMs >= limitedUntil) return { kind: "ok" };
    // The API names the minute access comes back.
    const reset = new Date(Math.ceil(limitedUntil / 60_000) * 60_000).toISOString();
    return { kind: "limit", form: "429", resetAt: reset };
  };
  const standIn = messagesApiStandIn({ model, clock, answerFor });
  const inner = standInFetch(standIn, {
    fallback: async () => new Response("not here", { status: 404 }),
  });
  const reviewCalls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.clone().text() : "";
    if (body.includes(`"name":"${SUBMIT_REVIEW}"`)) {
      reviewCalls.push(clock.nowIso());
      if (reviewLimitMs !== null && limitedUntil === null)
        limitedUntil = clock.now() + reviewLimitMs;
    }
    return inner(request);
  }) as typeof fetch;
  const start = async () => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: `sqlite:${join(dirs.data, "state.sqlite")}`,
      vault,
      fetchImpl,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
    runtimes.push(rt);
    const { app, token } = createDaemonApp(rt);
    const req = (path: string) =>
      Promise.resolve(
        app.request(path, {
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        }),
      );
    return { rt, req };
  };
  return {
    vault,
    standIn,
    start,
    reviewCalls,
    limitReviews: (ms: number) => {
      reviewLimitMs = ms;
    },
  };
}

const run = (rt: RuntimeApp, projectId: string) =>
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
  });

async function json<T>(r: Promise<Response>): Promise<T> {
  return (await (await r).json()) as T;
}

/** Waits (polls, at most `ms` of real time) until `check` holds; says what it saw otherwise. */
async function until(what: string, check: () => Promise<string | null>, ms = 20_000) {
  const end = Date.now() + ms;
  let seen = "";
  while (Date.now() < end) {
    const r = await check();
    if (r === null) return;
    seen = r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`${what} did not happen within ${ms / 1000} s; last seen: ${seen}`);
}

/**
 * R-criticcred (the leftovers of wave 7): the task's run finished, then the critic's review met
 * the key's usage limit with no other credential to serve it. Before, the critic made the
 * refused review an "escalate" verdict: the retry ladder ran the task again (every review met
 * the same limit) and filed '"X" failed 4 times' (or, when the critic threw, a "could not be
 * reviewed" card beside the credential's own words), and nothing reviewed it at the reset.
 */
describe("a review that meets a credential's usage limit waits for it (U-078)", () => {
  it("no verdict, no failed try and no card: the task waits until the reset, and the review runs by itself then, after a restart too", async () => {
    const clock = new SimulatedClock("2026-11-03T14:00:00Z");
    const w = world(clock);
    await w.vault.set(SECRET_NAMES.anthropic, KEY);
    const first = await w.start();
    const project = await first.rt.store.project.insert({
      name: "Notes",
      goal: "A note",
      autonomy_level: 2,
    });
    const task = await first.rt.store.task.insert({
      project_id: project.id,
      title: "Write note A",
      outcome: "Write note A is written",
      acceptance_criteria: ["it is written"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 50_000,
      reason: "seed",
    });
    // The review's call meets the limit for 100 minutes: access comes back at 15:40 UTC.
    w.limitReviews(100 * 60_000);

    const result = await run(first.rt, project.id);
    expect(w.reviewCalls).toHaveLength(1);
    const row = await first.rt.store.task.mustGet(task.id);
    expect([row.status, row.attempt]).toEqual(["ready", 0]);
    expect(result.failed).toEqual([]);
    // No verdict was recorded and no finding opened.
    expect(await first.rt.store.review.latestForTask(task.id)).toBeUndefined();
    expect(await first.rt.store.finding.openFor(task.id)).toEqual([]);
    const critic = (await first.rt.store.run.forTask(task.id)).filter(
      (r) => r.specialist === "critic",
    );
    expect(critic.map((r) => r.outcome)).toEqual(["usage_limit"]);
    // The session ends on the wait's one sentence (15:40 UTC is 16:40 in Zurich).
    expect(result.summary.split("\n")[0]).toBe(
      "Waits until 16:40 (your API key's limit) and starts by itself.",
    );
    const lines = (
      await json<{ text: string; audience?: string }[]>(
        first.req(`/sessions/${result.sessionId}/events`),
      )
    ).filter((e) => e.audience !== "detail");
    const said = lines.map((e) => e.text);
    expect(said).toContain(
      'Your API key reached its usage limit; "Write note A" waits until 16:40 (your API key\'s limit) and starts by itself.',
    );
    expect(said.join(" | ")).not.toMatch(/did not run|could not be reviewed|sent .* back|failed/);
    // No card: a limit is nothing the person must do (before: the review-failed card).
    const inbox = await json<InboxView>(first.req("/inbox"));
    expect(inbox.requests.filter((r) => r.status === "open")).toEqual([]);
    // The Tasks tab says what it waits for.
    const rows = await json<TaskView[]>(first.req(`/projects/${project.id}/tasks`));
    expect(rows.map((t) => [t.display?.label, t.display?.detail])).toEqual([
      ["Waits until 16:40, your API key's limit", "It starts by itself then."],
    ]);

    // Quit and start again: the wait is kept. Before the reset nothing runs.
    await first.rt.close();
    const second = await w.start();
    await second.rt.scheduler.tick();
    expect(w.reviewCalls).toHaveLength(1);
    // At the reset the next tick starts the project's session, which runs the task again and
    // the critic reviews it.
    clock.set(Date.parse("2026-11-03T15:41:00Z"));
    await second.rt.scheduler.tick();
    await until("the session started at the reset to finish the task", async () => {
      const now = await second.rt.store.task.mustGet(task.id);
      const sessions = await second.rt.store.session.forProject(project.id);
      return now.status === "done" &&
        sessions.every((s) => ["completed", "stopped", "failed", "killed"].includes(s.status))
        ? null
        : `${now.status}; sessions ${sessions.map((s) => s.status).join(", ")}`;
    });
    expect(w.reviewCalls.length).toBeGreaterThanOrEqual(2);
    expect((await second.rt.store.review.latestForTask(task.id))?.verdict).toBe("accept");
    expect((await second.rt.store.task.mustGet(task.id)).attempt).toBe(0);
    const sessions = await second.rt.store.session.forProject(project.id);
    expect(sessions.map((s) => s.trigger).sort()).toEqual(["budget_reset", "manual"]);
  }, 120_000);
});
