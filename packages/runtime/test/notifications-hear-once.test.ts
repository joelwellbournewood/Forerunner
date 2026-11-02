import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import {
  type BenchOptions,
  benchOptionsFromEnv,
  createRolePlayer,
} from "../../../testenv/src/bench/role-player.ts";
import { composeRuntime } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { CriticPort, SessionReviewOutcome } from "../src/loop/ports.ts";
import { type SessionEndFacts, sessionEndIsNews } from "../src/notifications/producers.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * The person hears once (core-experience design §4.3, §5.10, §5.11). Before (wave 3 review,
 * phase E #87, #88, #89, C-32, C-42), one task that failed after its retries sent three
 * notifications: "the critic sent it back" (a retry one rung up), the card's "failed 4 times",
 * and the session end's '"X" needs your decision', and the Inbox had an Update "the session
 * ended without finishing a task." under the card it did not name. The person's own Stop now
 * sent "Quote page: stopped by you" back to them, and the session log said the stop twice. A
 * session end whose result was one line had the title's sentence again in its body.
 *
 * Now a card's notification is the one about its task: an escalation inside the session is not
 * news, the session end and the Update leave out what a card says and are not sent when nothing
 * else happened, the person's own stop is not echoed, and a body never repeats its title.
 *
 * The daemon runs with the bench's role-playing stand-in model and its failure injection, the
 * model the bench journeys use; what is asserted is what the daemon's routes give the person's
 * shells (`GET /notifications/recent`, `/inbox`, `/sessions/:id/events`).
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

async function compose(env: Record<string, string>, benchClock?: SimulatedClock) {
  const home = mkdtempSync(join(tmpdir(), "fr-hear-once-"));
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const bench: BenchOptions = {
    ...benchOptionsFromEnv(
      { FORERUNNER_BENCH_DELAY_MS: "0", ...env },
      new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
    ),
    ...(benchClock ? { clock: benchClock } : {}),
  };
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: createRolePlayer(bench),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return res;
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await req(path, init);
    expect(res.status, `${init.method ?? "GET"} ${path}`).toBeLessThan(300);
    return (await res.json()) as Json;
  };
  return { rt, req, json, bench };
}

type World = Awaited<ReturnType<typeof compose>>;

/** Polls in real time (at least 10 s); the error says what was seen last. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: () => Promise<string>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${await what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function newProject(w: World, name: string): Promise<string> {
  return String((await w.json("/projects", post({ name, goal: "A small page" }))).id);
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function addTask(
  w: World,
  projectId: string,
  title: string,
  outcome: string,
  dependsOn: string[] = [],
): Promise<string> {
  const t = await w.json(
    `/projects/${projectId}/tasks`,
    post({ title, outcome, riskTier: 1, priority: "medium", status: "ready", dependsOn }),
  );
  return String(t.id);
}

/** Start a session as the project's Start does and return its id. */
async function startSession(w: World, projectId: string): Promise<string> {
  const started = await w.req(
    "/sessions",
    post({ agentId: w.rt.agent.id, projectId, trigger: "manual" }),
  );
  expect(started.status).toBe(202);
  return String((((await started.json()) as Json).session as Json).id);
}

/**
 * Wait until the session has ended and its start is over in the scheduler (the session-end
 * notification is decided there, after the run returns), then until the notifier has recorded
 * what that start sent: a session-end notification when there is one, else the next tick.
 */
async function sessionOver(w: World, sessionId: string): Promise<Json> {
  const row = await waitFor(
    async () => {
      const s = await w.json(`/sessions/${sessionId}`);
      return ["completed", "stopped", "failed", "killed"].includes(String(s.status)) &&
        !w.rt.scheduler.isActive(w.rt.agent.id)
        ? s
        : undefined;
    },
    async () =>
      `session ${sessionId} to end: ${JSON.stringify(await w.json(`/sessions/${sessionId}`))}`,
  );
  // The notifier records asynchronously: a turn of the event loop lets a pending one land.
  await new Promise((r) => setTimeout(r, 200));
  return row;
}

async function recent(w: World): Promise<Json[]> {
  return (await w.json("/notifications/recent?limit=200")).notifications as Json[];
}

describe("one notification per outcome: a task that fails after its retries (design §4.3)", () => {
  let w: World;
  beforeAll(async () => {
    // "Write the scope" never works: the specialist reports it could not do the work, the
    // critic sends it back, the retry climbs a rung, and after the last one it gets its card.
    w = await compose({ FORERUNNER_BENCH_FAIL: "Write the scope" });
  }, 120_000);
  afterAll(async () => {
    await w?.rt.close();
  });

  it("the card's notification is the only one about the task; no session end and no Update repeat it", async () => {
    const projectId = await newProject(w, "Packing list");
    const scope = await addTask(
      w,
      projectId,
      "Write the scope in docs/scope.md",
      "docs/scope.md says what is in scope",
    );
    await addTask(w, projectId, "Write the README", "README.md says how to run it", [scope]);
    const before = new Set((await recent(w)).map((n) => n.id));
    const sessionId = await startSession(w, projectId);
    await sessionOver(w, sessionId);

    const inbox = (await w.json("/inbox")) as { requests: Json[]; messages: Json[] };
    const cards = inbox.requests.filter((r) => r.projectId === projectId && r.status === "open");
    expect(cards.map((c) => c.title)).toEqual([
      expect.stringMatching(/^"Write the scope in docs\/scope\.md" failed/),
    ]);
    // The retries ran inside the session (design §4.3): more than one attempt.
    const fresh = (await recent(w)).filter((n) => !before.has(n.id));
    const about = fresh.filter((n) => /Write the scope/.test(`${n.title} ${n.body}`));
    expect(
      about.map((n) => `${n.kind}: ${n.title}`),
      JSON.stringify(fresh.map((n) => `${n.kind}: ${n.title} | ${n.body}`)),
    ).toEqual([
      expect.stringMatching(/^request_blocking: Packing list: "Write the scope.*" failed/),
    ]);
    // No critic verdict for an attempt, and the session did nothing else to tell.
    expect(fresh.map((n) => n.kind)).not.toContain("critic_verdict");
    expect(fresh.filter((n) => n.sessionId === sessionId).map((n) => n.kind)).not.toContain(
      "session_ended",
    );
    // The Inbox: the card in Needs you, and no Update of this session under it (C-32: it read
    // "the session ended without finishing a task." without naming the card above).
    expect(inbox.messages.filter((m) => m.projectId === projectId).map((m) => m.body)).toEqual([]);
    // The session's own result still says it, on the session page (one place per fact).
    const session = await w.json(`/sessions/${sessionId}`);
    expect(String(session.summary)).toMatch(/"Write the scope in docs\/scope\.md"/);
  }, 120_000);

  it("a session that also did work: its end tells the work, not the card, and its body never repeats its title", async () => {
    const projectId = await newProject(w, "Quote page");
    await addTask(
      w,
      projectId,
      "Write the notes in docs/notes.md",
      "docs/notes.md lists the ideas",
    );
    const scope = await addTask(
      w,
      projectId,
      "Write the scope in docs/scope.md",
      "docs/scope.md says what is in scope",
    );
    await addTask(w, projectId, "Write the README", "README.md says how to run it", [scope]);
    const before = new Set((await recent(w)).map((n) => n.id));
    const sessionId = await startSession(w, projectId);
    await sessionOver(w, sessionId);

    const fresh = (await recent(w)).filter((n) => !before.has(n.id));
    const about = fresh.filter((n) => /Write the scope/.test(`${n.title} ${n.body}`));
    expect(about.map((n) => n.kind)).toEqual(["request_blocking"]);
    const ended = fresh.filter((n) => n.kind === "session_ended");
    expect(
      ended.map((n) => n.title),
      JSON.stringify(fresh.map((n) => `${n.kind}: ${n.title} | ${n.body}`)),
    ).toEqual(['Quote page: did 1 task: "Write the notes in docs/notes.md"']);
    const body = String(ended[0]?.body);
    // The body says what the title does not (design §5.1: one sentence and where to look).
    expect(body).not.toContain("Did 1 task");
    expect(body).toMatch(/Open the session for the details\.$/);
    expect(body.length).toBeLessThanOrEqual(140);
    // The Update is the same news, one line.
    const inbox = (await w.json("/inbox")) as { messages: Json[] };
    expect(inbox.messages.filter((m) => m.projectId === projectId).map((m) => m.body)).toEqual([
      'Quote page: did 1 task: "Write the notes in docs/notes.md".',
    ]);
  }, 120_000);
});

describe("which session ends are told (sessionEndIsNews)", () => {
  const facts = (stopReason: string, news: string[]): SessionEndFacts => ({
    sessionId: "s-1",
    status: "stopped",
    stopReason,
    summary: news.join("\n"),
    news,
    spentUsdMicro: 0,
    completed: [],
    needsHuman: [],
  });
  it("the person's stops are not (Stop now; Stop all and Quit have the kill switch's notice), a budget stop always is, otherwise only news", () => {
    const did = ['Did 1 task: "A".', "CHF 0.01."];
    expect(sessionEndIsNews(facts("you", did))).toBe(false);
    expect(sessionEndIsNews(facts("stop_all", did))).toBe(false);
    expect(sessionEndIsNews(facts("quit", did))).toBe(false);
    expect(
      sessionEndIsNews(facts("budget_exceeded", ["The session's budget is used. CHF 0.90."])),
    ).toBe(true);
    expect(sessionEndIsNews(facts("completed", did))).toBe(true);
    // Only what waits, how it ended and the money: what the cards said, told already.
    expect(sessionEndIsNews(facts("completed", ["1 task waits on other tasks. CHF 0.03."]))).toBe(
      false,
    );
    expect(
      sessionEndIsNews(
        facts("stopped_by_message", ["Stopped after the task, as asked. CHF 0.00."]),
      ),
    ).toBe(false);
    // The plan waiting on its card: the card is the news.
    expect(sessionEndIsNews(facts("plan_awaiting_approval", ["CHF 0.00."]))).toBe(false);
  });
});

describe("a session review that asked the person is told by its card alone", () => {
  it("the bus event names the card the critic filed, so the daemon leaves the notification to it", async () => {
    // Before, the runner's `critic.session_review` event dropped the request id the review
    // returned: the daemon told "a task needs your decision" (no task) beside the card's own
    // notification. The daemon's side (an escalation with a request is left to the request
    // path) is asserted in notifications-wiring.test.ts.
    const w = await loopWorld({
      replies: [submitReply({ grade: 90, verdict: "accept" }), closingReply()],
    });
    try {
      await w.addTask("Add clamp");
      const critic = Object.create(w.critic) as CriticPort;
      critic.reviewSession = async (): Promise<SessionReviewOutcome> => ({
        reviewId: null,
        tier: 1,
        verdict: "human",
        grade: 30,
        confidence: 0.8,
        summary: "The summary counts a task twice.",
        findings: [],
        humanRequestId: "req-session-review",
        costUsdMicro: 0,
      });
      await w.start(w.runner(doneExecutor(w), { critic }));
      const review = w.events.find((e) => e.type === "critic.session_review");
      expect(review?.payload).toMatchObject({
        verdict: "human",
        escalation: true,
        humanRequestId: "req-session-review",
      });
    } finally {
      await w.close();
    }
  });
});

describe("the person's own Stop now is not echoed back (design §5.11)", () => {
  let w: World;
  // The stand-in's reply waits on a clock that never moves: the run is in flight until the
  // person stops it, however slow the machine (the wait ends on the run's abort).
  const still = new SimulatedClock("2026-11-02T09:00:00Z");
  beforeAll(async () => {
    w = await compose({ FORERUNNER_BENCH_DELAY_MS: "60000" }, still);
  }, 120_000);
  afterAll(async () => {
    await w?.rt.close();
  });

  it("no session-end or kill-switch notification, and the session log says the stop once", async () => {
    const projectId = await newProject(w, "Stop page");
    const taskId = await addTask(
      w,
      projectId,
      "Write the notes in docs/notes.md",
      "docs/notes.md lists the ideas",
    );
    const before = new Set((await recent(w)).map((n) => n.id));
    const sessionId = await startSession(w, projectId);
    // The task's run is in flight (Running on the Tasks tab), then the session page's Stop now.
    const status = async () =>
      String(
        ((await w.json(`/projects/${projectId}/tasks`)) as unknown as Json[]).find(
          (t) => t.id === taskId,
        )?.status,
      );
    await waitFor(
      async () => ((await status()) === "in_progress" ? true : undefined),
      async () => `the task to run (it is ${await status()})`,
    );
    const stopped = await w.req(`/sessions/${sessionId}/stop`, post({}));
    expect(stopped.status).toBe(200);
    const row = await sessionOver(w, sessionId);
    expect(row.status).toBe("killed");

    const fresh = (await recent(w)).filter((n) => !before.has(n.id));
    expect(
      fresh.map((n) => n.kind),
      JSON.stringify(fresh.map((n) => `${n.kind}: ${n.title} | ${n.body}`)),
    ).not.toContain("session_ended");
    expect(fresh.map((n) => n.kind)).not.toContain("kill_switch");
    // The session page's log, as the person reads it (C-42: "Stopped by you during …" then
    // "Stopped by you: nothing done. CHF 0.00.").
    const lines = ((await w.json(`/sessions/${sessionId}/events`)) as unknown as Json[])
      .filter((e) => e.audience === "person")
      .map((e) => String(e.text));
    const stopLines = lines.filter((l) => /Stopped by you/.test(l));
    expect(stopLines, lines.join("\n")).toEqual([
      'Stopped by you during "Write the notes in docs/notes.md". It is ready again.',
    ]);
    expect(lines.join("\n")).not.toMatch(/nothing done/);
  }, 120_000);
});
