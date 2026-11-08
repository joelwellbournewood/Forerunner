import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { type KeyAnswer, messagesApiStandIn, standInFetch } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
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

// Credential-shaped fixtures for the two-credential world below.
const OAUTH = ["sk-ant-oat01-", "waitqueue", "7".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "waitqueue", "8".repeat(40)].join(""); // not-a-secret

/** Claude Code whose first call meets the plan's usage limit (reset at `resetAt`); then serves. */
function limitedClaudeCode(resetAt: string, calls: string[]): QueryLike {
  return ({ prompt }) => {
    calls.push(prompt);
    const limited = calls.length === 1;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-wait" };
      if (!limited) {
        yield {
          type: "assistant",
          message: {
            id: `m${calls.length}`,
            content: [{ type: "text", text: "Wrote it on the subscription. Lesson: none." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "Wrote it." };
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

/**
 * R-waitqueue (the leftovers of wave 7; ADR 0100 point 10): under "When my first choice runs out
 * mid-session: Wait", only the tasks whose first choice is the resting credential wait. Before,
 * the session ended at the first task that had to wait and skipped the rest of its queue,
 * including a task whose first choice (the API key) could serve now, and every ready task of the
 * project read "Waits until ...", that one too.
 */
describe("under 'Wait' only the tasks whose first choice rests wait (U-078)", () => {
  it("the research task on the API key runs in the same session; only the code task waits, and its row alone says so", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-wait-queue-"));
    const sdkCalls: string[] = [];
    const provider = new ScriptedProvider([{ text: "Read three pages. Lesson: none." }], clock);
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
      // The critic accepts (ADR 0104); the API key's task runs on `provider`.
      provider: new AcceptingCriticProvider(provider),
      sdkQuery: limitedClaudeCode("2026-10-31T14:00:00.000Z", sdkCalls),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
      // Claude Code reads no web page here: research's first choice is the API key.
      billing: { facts: { subscriptionPages: false } },
    });
    runtimes.push(rt);
    const { app, token } = createDaemonApp(rt);
    const req = async <T>(path: string): Promise<T> =>
      (await (
        await app.request(path, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as T;
    const project = await rt.store.project.insert({
      name: "Club",
      goal: "A club site",
      autonomy_level: 2,
    });
    const make = (title: string, specialist: string, priority: number) =>
      rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["it is done"],
        risk_tier: 0,
        status: "ready",
        priority,
        specialist,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    // The code task first (higher priority): its first choice, the subscription, meets its limit.
    const code = await make("Write the changelog", "coder", 9);
    const notes = await make("Write the release notes", "coder", 7);
    const research = await make("Compare hosting offers", "researcher", 5);

    const result = await run(rt, project.id);
    // Only the first code task called Claude Code: the second one's pick waited, no call.
    expect(sdkCalls).toHaveLength(1);
    // The code tasks wait for the subscription's reset; the research task ran on the API key in
    // the same session and the critic accepted it.
    for (const t of [code, notes]) {
      const now = await rt.store.task.mustGet(t.id);
      expect([now.title, now.status, now.attempt]).toEqual([t.title, "ready", 0]);
    }
    expect((await rt.store.task.mustGet(research.id)).status).toBe("done");
    expect(result.completed).toEqual([research.id]);
    expect(
      provider.calls.filter((c) => !(c.tools ?? []).some((t) => t.name === SUBMIT_REVIEW)).length,
    ).toBeGreaterThan(0);
    // Only the waiting tasks' rows say they wait.
    const rows = await req<TaskView[]>(`/projects/${project.id}/tasks`);
    const label = (id: string) => rows.find((t) => t.id === id)?.display?.label;
    expect(label(code.id)).toBe("Waits until 15:00, your subscription's limit");
    expect(label(notes.id)).toBe("Waits until 15:00, your subscription's limit");
    expect(label(research.id)).toBe("Done");
    // The session says what it did and what waits; the person's log names the wait once and
    // starts nothing that did not run.
    expect(result.summary).toContain("Waits until 15:00 (your subscription's limit)");
    const lines = (
      await req<{ text: string; audience?: string }[]>(`/sessions/${result.sessionId}/events`)
    )
      .filter((e) => e.audience !== "detail")
      .map((e) => e.text);
    expect(lines.filter((l) => /waits until 15:00/.test(l))).toEqual([
      'Your Claude subscription reached its usage limit; "Write the changelog" waits until 15:00 (your subscription\'s limit) and starts by itself.',
    ]);
    expect(lines.some((l) => l.includes('started "Write the release notes"'))).toBe(false);
    expect(lines.some((l) => l.includes('started "Compare hosting offers"'))).toBe(true);
  }, 120_000);
});

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
