import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { type HumanRequestRow, type JsonObject, openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { requestView } from "../src/daemon/views.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import type { CriticPort } from "../src/loop/ports.ts";
import {
  fileReviewFailedRequest,
  REVIEW_FAILED_KEY,
  REVIEW_FAILED_OPTIONS,
} from "../src/session/findings.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { ANSWER_CARD_KEYS } from "../src/wiring/request-answers.ts";
import { seedWorld } from "./context-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-045: when the critic's review of a task failed (an error, not a verdict), the task stayed
 * "in review" for good with no card: the runner only emitted `critic.review_failed`, no later
 * session plans a task in review, and nothing else moves one. Now the failure files one
 * blocking Inbox card for the task (the error, and what each option does) whose options act:
 * rework runs the task again (and the critic reviews the new run), accept closes it as it is,
 * cancel cancels it.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

const keyOf = (r: HumanRequestRow) => (r.change_card as JsonObject | null)?.key;

describe("a failed critic review files a card instead of leaving the task in review (U-045)", () => {
  it("the session files one card per task whose review failed, names it in the summary and goes on", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store, {}, { session: false });
    const add = (title: string, priority: number) =>
      store.task.insert({
        project_id: w.project,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status: "ready",
        priority,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    const first = await add("Add the export", 9);
    const second = await add("Add the import", 1);
    const executor: TaskExecutor = {
      async execute() {
        return {
          outcome: "done",
          summary: "done",
          costUsdMicro: 0,
          checksPassed: true,
          runId: "run-1",
        };
      },
    };
    const reviewed: string[] = [];
    // The first review fails (the critic's model is unreachable); the second gives a verdict.
    const critic: CriticPort = {
      async reviewTask(req) {
        reviewed.push(req.task.id);
        if (req.task.id === first.id) throw new Error("critic provider unavailable (503)");
        const t = await store.task.mustGet(req.task.id);
        await store.task.transition(t.id, t.version, "done", "accepted", { agentId: w.agent });
        return {
          reviewId: null,
          tier: 1,
          verdict: "accept",
          grade: 90,
          confidence: 0.9,
          findings: [],
          openFindings: 0,
          decision: "accepted",
          attempt: 0,
          summary: "fine",
          costUsdMicro: 0,
          resolvedFindingIds: [],
          quarantinedLessons: [],
          task: await store.task.mustGet(req.task.id),
        } as never;
      },
      async reviewSession() {
        throw new Error("not under test");
      },
    };
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const r = await new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
      critic,
    }).start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(reviewed).toEqual([first.id, second.id]);
    expect(r.completed).toEqual([second.id]);
    expect(r.inReview).toEqual([first.id]);
    // The person's Inbox has one card for the task the critic could not review.
    const cards = (await store.humanRequest.open({ humanId: w.human })).filter(
      (q) => q.task_id === first.id,
    );
    expect(cards.map(keyOf)).toEqual([REVIEW_FAILED_KEY]);
    expect(r.summary).toContain(
      "Review failed: 1 (asked you in the Inbox: rework, accept or cancel).",
    );
    expect(r.reviewFailed).toEqual([first.id]);
    const card = cards[0] as HumanRequestRow;
    expect(card).toMatchObject({
      task_id: first.id,
      kind: "approval",
      blocking: true,
      session_id: r.sessionId,
    });
    expect(card.why).toContain('The critic could not review "Add the export"');
    expect(card.why).toContain("critic provider unavailable (503)");
    expect(requestView(card, null).options).toEqual(["rework", "accept", "cancel"]);
    expect(events.find((e) => e.type === "critic.review_failed")?.payload).toMatchObject({
      taskId: first.id,
      humanRequestId: card.id,
    });
    await store.close();
  });

  it("a task the person moved while it was reviewed is left as they set it, with no card", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store, {}, { session: false });
    const task = await store.task.insert({
      project_id: w.project,
      title: "Move me",
      outcome: "x",
      risk_tier: 1,
      status: "ready",
      est_cost_usd_micro: 100_000,
    });
    const critic: CriticPort = {
      async reviewTask() {
        // The person cancels the task while its review runs; the review then fails.
        const t = await store.task.mustGet(task.id);
        await store.task.transition(t.id, t.version, "cancelled", "Not needed", {
          humanId: w.human,
        });
        throw new Error("review aborted");
      },
      async reviewSession() {
        throw new Error("not under test");
      },
    };
    const r = await new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor: {
        async execute() {
          return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
        },
      },
      critic,
    }).start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect((await store.task.mustGet(task.id)).status).toBe("cancelled");
    expect(r.cancelled).toEqual([task.id]);
    expect(r.inReview).toEqual([]);
    expect(r.reviewFailed).toEqual([]);
    expect(
      (await store.humanRequest.open({ humanId: w.human })).filter(
        (q) => keyOf(q) === REVIEW_FAILED_KEY,
      ),
    ).toEqual([]);
    await store.close();
  });
});

describe("the review-failed card's options act, answered as the Inbox shows them (U-045)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u045-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = (await rt.store.project.insert({ name: "Reviews", goal: "No task stuck" })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** A task left in review by a failed review, and its card as the session files it. */
  const stuck = async (title: string) => {
    const t = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: "x",
      risk_tier: 1,
      status: "in_review",
      attempt: 1,
    });
    const { request } = await fileReviewFailedRequest({
      store: rt.store,
      task: t,
      session: null,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runId: null,
      error: "critic provider unavailable (503)",
    });
    return { task: t, card: request };
  };
  /** The Inbox's click: the option's text exactly as `requestView` shows it. */
  const click = (card: HumanRequestRow, option: string) =>
    app.request(`/requests/${card.id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: card.version, answer: option }),
    });

  it("its key has a reader the answer route checks, and its options are the reader's words", () => {
    expect(ANSWER_CARD_KEYS.reviewFailed).toBe(REVIEW_FAILED_KEY);
    expect([...REVIEW_FAILED_OPTIONS]).toEqual(["rework", "accept", "cancel"]);
  });

  it("rework: the task goes back to ready (its attempt counted), so the next session runs it and the critic reviews it again", async () => {
    const { task, card } = await stuck("Rework me");
    const option = requestView(card, null).options[0] as string;
    expect(option).toBe("rework");
    expect((await click(card, option)).status).toBe(200);
    const after = await rt.store.task.mustGet(task.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(2);
    expect(((await rt.store.humanRequest.mustGet(card.id)).change_card as JsonObject).outcome).toBe(
      "rework",
    );
    expect((await rt.store.task.readyTasks(projectId)).map((t) => t.id)).toContain(task.id);
  });

  it("accept: the work stands without a review and the task is done", async () => {
    const { task, card } = await stuck("Accept me");
    expect((await click(card, requestView(card, null).options[1] as string)).status).toBe(200);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
  });

  it("cancel: the task is cancelled", async () => {
    const { task, card } = await stuck("Cancel me");
    expect((await click(card, requestView(card, null).options[2] as string)).status).toBe(200);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("cancelled");
  });

  it("a typed answer none of the options is refused with them; the card stays open", async () => {
    const { task, card } = await stuck("Ask me properly");
    const res = await click(card, "maybe later");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "Choose one of: rework, accept, cancel",
    );
    expect((await rt.store.humanRequest.mustGet(card.id)).status).toBe("open");
    expect((await rt.store.task.mustGet(task.id)).status).toBe("in_review");
  });

  it("a second failure while the card is open reuses it", async () => {
    const { task, card } = await stuck("Fails twice");
    const again = await fileReviewFailedRequest({
      store: rt.store,
      task: await rt.store.task.mustGet(task.id),
      session: null,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runId: null,
      error: "again",
    });
    expect(again).toMatchObject({ reused: true, request: { id: card.id } });
  });
});
