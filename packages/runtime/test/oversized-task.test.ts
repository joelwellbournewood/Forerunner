import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { handoffOf, WRAP_UP_BRIEF_LINE } from "../src/session/budget-pause.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-oversize-start (U-089, OS-2; the owner's D4 of 2026-11-09: "it should get a warning, but
 * it should get done anyway. when the budget will run out, it should be the case that the agent
 * will do as much as it can, and wrap up in an organized and error free way such that the work
 * can be continued in the next run"). The whole runtime, composed as `fr daemon` composes it,
 * with the bench's role-playing stand-in model: its "Build the shop" coder writes the shop one
 * part per call (FORERUNNER_BENCH_LONG) and every call bills inflated input tokens
 * (FORERUNNER_BENCH_USAGE), so a session of USD 2.00 cannot finish it.
 *
 * Before, POST /sessions refused such a start ("Nothing can run within this budget: ..."), and
 * beside other work the task was left out of every session of that size. Now the session takes
 * it after the work that fits, with what is left of its work budget; the run is capped there,
 * hears the wrap-up, keeps its work and pauses with one budget card; the plan row lists it with
 * the room it was given. All of it reads the same after the runtime is composed again.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const BENCH_ENV = {
  FORERUNNER_BENCH_DELAY_MS: "0",
  FORERUNNER_BENCH_LONG: "Build the shop",
  FORERUNNER_BENCH_USAGE: "Build the shop:100000",
};

async function compose(home: string, clock: SimulatedClock) {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const bench = benchOptionsFromEnv(
    BENCH_ENV,
    new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
  );
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault(),
    provider: createRolePlayer(bench),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await req(path, init);
    const body = (await res.json()) as Json;
    expect(res.status, `${init.method ?? "GET"} ${path}: ${JSON.stringify(body)}`).toBeLessThan(
      300,
    );
    return body;
  };
  return { rt, req, json };
}
type World = Awaited<ReturnType<typeof compose>>;

/** Polls in real time (at least 10 s); the error says what was seen last. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: () => Promise<string>,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${await what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function newProject(w: World, name: string): Promise<string> {
  return String((await w.json("/projects", post({ name, goal: "A shop page" }))).id);
}

/** A coder task, ready, with its own estimate in USD (what the planner prices it at). */
async function addTask(
  w: World,
  projectId: string,
  title: string,
  file: string,
  usd: number,
  priority: "high" | "medium" | "low" = "medium",
): Promise<string> {
  const t = await w.json(
    `/projects/${projectId}/tasks`,
    post({
      title,
      outcome: `${file} is written`,
      acceptanceCriteria: [`${file} exists`],
      riskTier: 1,
      priority,
      status: "ready",
      dependsOn: [],
      specialist: "coder",
    }),
  );
  await w.rt.store.task.patch(String(t.id), { est_cost_usd_micro: Math.round(usd * 1_000_000) });
  return String(t.id);
}

/** Start a session as the Start dialog does, with a budget of USD 2.00; returns it ended. */
async function runSession(w: World, projectId: string): Promise<Json> {
  const started = await w.req(
    "/sessions",
    post({ agentId: w.rt.agent.id, projectId, trigger: "manual", budgetUsdMicro: 2_000_000 }),
  );
  const body = (await started.json()) as Json;
  // Before: 409 "Nothing can run within this budget: "Build the shop" needs about CHF 6.40."
  expect(started.status, JSON.stringify(body)).toBe(202);
  const sessionId = String((body.session as Json | null)?.id ?? "");
  expect(sessionId, JSON.stringify(body)).toBeTruthy();
  return waitFor(
    async () => {
      const s = await w.json(`/sessions/${sessionId}`);
      return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
        ? s
        : undefined;
    },
    async () => `the session to end (${JSON.stringify(await w.json(`/sessions/${sessionId}`))})`,
  );
}

async function personLines(w: World, sessionId: string): Promise<string[]> {
  const events = (await w.json(`/sessions/${sessionId}/events`)) as unknown as Json[];
  return events.filter((e) => e.audience === "person").map((e) => String(e.text));
}

describe("d1109-oversize-start", () => {
  const clock = new SimulatedClock("2026-11-09T09:00:00Z");
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened) await rt.close().catch(() => undefined);
  });

  it("a project whose only ready task is larger than the work budget: the start is not refused, the task works until its wrap-up and pauses with one card; the plan row lists it with the room it got; the same after a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversized-"));
    let w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop");
    const shop = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8);
    const ended = await runSession(w, projectId);
    const sessionId = String(ended.id);

    // It ran until its wrap-up and paused at this session's budget, with its work kept.
    const work = (await w.rt.store.run.forTask(shop)).filter((r) => r.specialist !== "critic");
    expect(work.map((r) => r.outcome)).toEqual(["paused"]);
    const handoff = handoffOf(work[0]?.artifacts ?? []);
    expect(handoff?.stoppedBy).toBe("wrap_up");
    expect(handoff?.leftToDo.length).toBeGreaterThan(0);
    const task = await w.rt.store.task.mustGet(shop);
    // No limit is passed: the task spent at most the session's work budget (USD 1.60).
    expect(task.actual_cost_usd_micro).toBeGreaterThan(0);
    expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(1_600_000);
    const cards = async () =>
      (await w.rt.store.humanRequest.list({ task_id: shop, status: "open" } as never)).map((r) => ({
        id: r.id,
        key: (r.change_card as Json | null)?.key,
        why: r.why,
      }));
    const open = await cards();
    expect(open).toHaveLength(1);
    const inbox = (await w.json("/inbox")).requests as Json[];
    const card = inbox.find((r) => r.taskId === shop && r.status === "open");
    // l3-handoff-checks (L3-research-2): a run that heard the wrap-up paused before the limit
    // ran out, and the card's first sentence names the amount (before: "paused at this
    // session's budget of CHF 1.60").
    expect(card?.title).toBe(
      '"Build the shop in shop.md" paused before this session\'s budget ran out',
    );
    expect(card?.body).toBe("This session's budget was CHF 1.60.");
    // l4-money-pause (L4-money-102): its wrap-up left part of the work budget unspent, so the
    // session ended with no budget stop (before: /^budget_/, "Stopped: the budget is used").
    expect(String(ended.stopReason)).toBe("completed");

    // The plan row lists it with the room it was given and the reason that names it.
    const row = await w.rt.store.session.mustGet(sessionId);
    const plan = row.plan as { items: Json[]; oversized?: Json };
    expect(plan.items).toEqual([
      expect.objectContaining({ taskId: shop, estimateUsdMicro: 1_600_000 }),
    ]);
    expect(plan.oversized).toMatchObject({ taskId: shop, roomUsdMicro: 1_600_000 });
    expect(row.reason).toBe(
      'took "Build the shop in shop.md", larger than this session\'s work budget, with what is left',
    );
    const said = await personLines(w, sessionId);
    expect(said.filter((l) => l.startsWith("Took "))).toEqual([
      'Took "Build the shop in shop.md", larger than this session\'s work budget, with about CHF 1.28 left.',
    ]);
    expect(String(ended.summary)).not.toContain("Nothing could run");

    // Composed a second time on the same home: the task, its card and its run read the same.
    const before = {
      status: task.status,
      cards: open,
      handoff,
      title: card?.title,
    };
    await w.rt.close();
    w = await compose(home, clock);
    opened.push(w.rt);
    const again = (await w.rt.store.run.forTask(shop)).filter((r) => r.specialist !== "critic");
    const reInbox = (await w.json("/inbox")).requests as Json[];
    expect({
      status: (await w.rt.store.task.mustGet(shop)).status,
      cards: await cards(),
      handoff: handoffOf(again[0]?.artifacts ?? []),
      title: reInbox.find((r) => r.taskId === shop && r.status === "open")?.title,
    }).toEqual(before);
  }, 180_000);

  it("with two tasks that fit first in the plan's order, they are done and reviewed before the larger task starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversized-fit-"));
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop two");
    // d1109-oversize-pause (OP-0, the owner's answer 5): the larger task runs in its turn, so it
    // comes after the two by its lower priority (before: at "high" it was still held until the
    // work that fits was done; at "high" it now runs first, the 'd1109-oversize-pause' cases).
    const shop = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "low");
    const intro = await addTask(w, projectId, "Write the intro in intro.md", "intro.md", 0.05);
    const about = await addTask(w, projectId, "Write the about page in about.md", "about.md", 0.05);
    const ended = await runSession(w, projectId);
    const events = (await w.rt.store.event.list(String(ended.id))).map((e) => ({
      type: e.type,
      p: (e.payload ?? {}) as Json,
    }));
    const took = events.findIndex((e) => e.type === "session.took_larger");
    expect(took).toBeGreaterThan(0);
    for (const id of [intro, about]) {
      // Done and reviewed, both before the take.
      expect((await w.rt.store.task.mustGet(id)).status).toBe("done");
      const verdict = events.findIndex((e) => e.type === "critic.verdict" && e.p.taskId === id);
      expect(verdict, `the review of ${id}`).toBeGreaterThanOrEqual(0);
      expect(verdict).toBeLessThan(took);
    }
    const startedShop = events.findIndex((e) => e.type === "task.started" && e.p.taskId === shop);
    expect(startedShop).toBeGreaterThan(took);
    // It got what the two left of the work budget, never more.
    const room = Number(events[took]?.p.roomUsdMicro);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(1_600_000);
    expect((await w.rt.store.task.mustGet(shop)).actual_cost_usd_micro).toBeLessThanOrEqual(room);
  }, 180_000);

  it("at autonomy 1 the plan card names it, and the approved session runs it", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversized-a1-"));
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop assisted");
    const project = await w.rt.store.project.mustGet(projectId);
    await w.rt.store.project.update(project.id, project.version, { autonomy_level: 1 });
    const shop = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8);
    const first = await runSession(w, projectId);
    expect(first.stopReason).toBe("plan_awaiting_approval");
    const inbox = (await w.json("/inbox")).requests as Json[];
    const plan = inbox.find((r) => r.sessionId === first.id && r.status === "open");
    expect(plan, JSON.stringify(inbox.map((r) => r.title))).toBeDefined();
    // Approved with the option the Inbox shows.
    const choices = (plan?.choices ?? []) as Json[];
    const approve = choices.find((c) => /approve/i.test(String(c.label)));
    expect(approve, JSON.stringify(choices)).toBeDefined();
    await w.json(
      `/requests/${String(plan?.id)}/answer`,
      post({ version: plan?.version, answer: approve?.value ?? approve?.label }),
    );
    await waitFor(
      async () => {
        const runs = (await w.rt.store.run.forTask(shop)).filter((r) => r.specialist !== "critic");
        const sessions = await w.rt.store.session.forProject(projectId, { limit: 10 });
        return runs.length > 0 && sessions.every((s) => !["running", "planned"].includes(s.status))
          ? runs
          : undefined;
      },
      async () =>
        `the approved session to run the task (${(await w.rt.store.task.mustGet(shop)).status})`,
    );
  }, 180_000);
});

/**
 * d1109-oversize-pause (OP-0; the owner's answer 5 of 2026-11-09: "As i said, it should work on
 * tasks even when it cannot complete them, and be able to wrap up and continue next time. Again,
 * I thought we talked about this."): no special ordering. The larger task runs in its turn in the
 * plan's order (priority first), works until its wrap-up and pauses; the tasks after it take only
 * what it leaves, else they wait for the next session, and every screen says it in that order.
 * Before, d1109-oversize-start held it out of the queue until the work that fits was done.
 */
describe("d1109-oversize-pause", () => {
  const clock = new SimulatedClock("2026-11-10T09:00:00Z");
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened) await rt.close().catch(() => undefined);
  });
  const checkOf = async (w: World, projectId: string) =>
    (await w.json(`/projects/${projectId}/start-check?budgetUsdMicro=2000000`)) as Json;

  it("A, then the larger task at its place until its wrap-up; B comes after it and runs with what it leaves; the same order after a restart between the start check and the run", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversize-pause-order-"));
    let w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop order");
    const a = await addTask(w, projectId, "Write the intro in intro.md", "intro.md", 0.05, "high");
    const big = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "medium");
    const b = await addTask(w, projectId, "Write the notes in notes.md", "notes.md", 0.05, "low");

    // The Start dialog's facts: the warning names the task before it, the note the one after.
    const check = await checkOf(w, projectId);
    const over = check.oversized as Json;
    expect(String(over.sentence)).toMatch(
      /^"Build the shop in shop\.md" needs about CHF 6\.42, more than this session's work budget of CHF 1\.28: after "Write the intro in intro\.md" it works with about CHF [\d.]+, keeps its work, and asks you to continue\.$/,
    );
    expect(over.afterSentence).toBe(
      '"Write the notes in notes.md" comes after it: it runs if "Build the shop in shop.md" leaves budget, else in your next session.',
    );
    expect((check.runnable as Json[]).map((t) => t.title)).toEqual(["Write the intro in intro.md"]);
    expect((check.overBudget as Json[]).map((t) => [t.title, t.why])).toEqual([
      ["Build the shop in shop.md", "oversized"],
      ["Write the notes in notes.md", "after_large"],
    ]);
    expect(JSON.stringify(check)).not.toMatch(
      /after the other tasks|after the work that fits|one task that large/,
    );

    // Composed again between the start check and the run: the same order and figures.
    await w.rt.close();
    w = await compose(home, clock);
    opened.push(w.rt);
    expect(await checkOf(w, projectId)).toEqual(check);

    const ended = await runSession(w, projectId);
    const sessionId = String(ended.id);
    const events = (await w.rt.store.event.list(sessionId)).map((e) => ({
      type: e.type,
      p: (e.payload ?? {}) as Json,
    }));
    const started = events.filter((e) => e.type === "task.started").map((e) => e.p.taskId);
    // A ran and was reviewed first, then the larger task; B after it, with what the larger
    // task's wrap-up left of the work budget (l4-money-pause, L4-money-102: before, B did not
    // start and waited for the next session, "used the rest of this one").
    const spent =
      (await w.rt.store.task.mustGet(a)).actual_cost_usd_micro +
      (await w.rt.store.task.mustGet(big)).actual_cost_usd_micro;
    expect(1_600_000 - spent).toBeGreaterThan(50_000);
    expect(started.filter((id) => id !== undefined)).toEqual([a, big, b]);
    expect((await w.rt.store.task.mustGet(a)).status).toBe("done");
    expect((await w.rt.store.task.mustGet(big)).status).toBe("needs_human");
    expect((await w.rt.store.task.mustGet(b)).status).toBe("done");
    const cards = (await w.rt.store.humanRequest.list({ task_id: big, status: "open" } as never))
      .length;
    expect(cards).toBe(1);
    const said = await personLines(w, sessionId);
    expect(said.filter((l) => l.startsWith("Took "))).toHaveLength(1);
    expect(String(ended.summary)).not.toContain("used the rest of this one");
    expect(String(ended.summary)).not.toMatch(
      /after the other tasks|after the work that fits|one task that large/,
    );
    // OP-1: the larger task's brief, as the model received it, has the wrap-up line word for
    // word, and its run heard the wrap-up's new words once.
    const calls = readFileSync(join(home, "model-calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { task?: string; specialist?: string; messages: unknown[] });
    const shopCalls = calls.filter(
      (c) => c.specialist === "coder" && JSON.stringify(c.messages[0]).includes("Build the shop"),
    );
    expect(shopCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(shopCalls[0]?.messages[0])).toContain(
      JSON.stringify(WRAP_UP_BRIEF_LINE).slice(1, -1),
    );
    const last = JSON.stringify(shopCalls.at(-1)?.messages ?? []);
    expect(last.split("Finish the step you are on and start nothing new.").length - 1).toBe(1);
  }, 240_000);

  it("with the larger task at the highest priority it runs first, and the others take what it leaves", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversize-pause-first-"));
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop first");
    const big = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "high");
    const a = await addTask(w, projectId, "Write the intro in intro.md", "intro.md", 0.05);
    const check = await checkOf(w, projectId);
    expect((check.runnable as Json[]).length).toBe(0);
    expect((check.oversized as Json).afterSentence).toBe(
      '"Write the intro in intro.md" comes after it: it runs if "Build the shop in shop.md" leaves budget, else in your next session.',
    );
    const ended = await runSession(w, projectId);
    const events = (await w.rt.store.event.list(String(ended.id))).filter(
      (e) => e.type === "task.started",
    );
    expect(events.map((e) => (e.payload as Json).taskId)[0]).toBe(big);
    // l4-money-pause (L4-money-102): the intro fits what the larger task's wrap-up left, so it
    // runs in the same session (before: it stayed ready, "used the rest of this one").
    expect(events.map((e) => (e.payload as Json).taskId)).toEqual([big, a]);
    expect((await w.rt.store.task.mustGet(a)).status).toBe("done");
    expect(String(ended.summary)).not.toContain("used the rest of this one");
  }, 240_000);
});

/**
 * d1109-oversize-pause (OP-0, "continue next time"; the owner's answer 5: "be able to wrap up and
 * continue next time"): after the larger task paused at the session's budget with its work kept,
 * the next plain Start (no Continue) takes it in its turn from its kept work and closes its card,
 * also after the runtime is composed again between the pause and the Start.
 */
describe("d1109-oversize-pause: the next Start continues it", () => {
  const clock = new SimulatedClock("2026-11-10T13:05:00Z");
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened) await rt.close().catch(() => undefined);
  });

  it("a plain POST /sessions after a restart lists it at its estimate left, runs it from its kept work and closes its card with the Done line; no budget grows", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversize-pause-next-"));
    let w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop next");
    const shop = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8);
    const first = await runSession(w, projectId);
    // l4-money-pause (L4-money-102): its wrap-up left room, so no budget stop ended the session.
    expect(String(first.stopReason)).toBe("completed");
    const card = (await w.json("/inbox")).requests as Json[];
    const open = card.find((r) => r.taskId === shop && r.status === "open");
    expect(open, JSON.stringify(card.map((r) => r.title))).toBeDefined();
    const continueChoice = ((open?.choices ?? []) as Json[])[0];
    expect(continueChoice?.explain).toMatch(
      /^Starts a session now with CHF [\d.]+; without it, your next Start takes it in its turn\.$/,
    );
    const budgetBefore = (await w.rt.store.task.mustGet(shop)).budget_usd_micro;
    const spentBefore = (await w.rt.store.task.mustGet(shop)).actual_cost_usd_micro;
    const rows = (await w.json(`/projects/${projectId}/tasks`)) as unknown as Json[];
    const row = rows.find((t) => t.id === shop);
    expect((row?.display as Json | undefined)?.detail).toBe(
      "Your next Start goes on with it, or Continue in the Inbox.",
    );

    // Composed again between the pause and the next Start.
    await w.rt.close();
    w = await compose(home, clock);
    opened.push(w.rt);
    const check = (await w.json(
      `/projects/${projectId}/start-check?budgetUsdMicro=2000000`,
    )) as Json;
    const over = check.oversized as Json;
    // It is planned at what is left of its estimate (OS-1), and it spent before.
    expect(over.taskId).toBe(shop);
    expect(Number((over.estimate as Json).usdMicro)).toBe(8_030_000 - spentBefore);
    expect(String(over.sentence)).toContain("spent so far");

    const second = await runSession(w, projectId);
    const work = (await w.rt.store.run.forTask(shop)).filter((r) => r.specialist !== "critic");
    expect(work.length).toBe(2);
    expect(work.map((r) => r.session_id)).toContain(second.id);
    expect(work.map((r) => r.session_id)).toContain(first.id);
    const after = (await w.rt.store.humanRequest.list({ task_id: shop } as never)).find(
      (r) => r.id === open?.id,
    );
    expect(after?.status).toBe("withdrawn");
    const inbox = (await w.json("/inbox")).requests as Json[];
    const closed = inbox.find((r) => r.id === open?.id);
    expect(closed?.outcome).toMatch(/^Your session of \d\d:\d\d went on with it\.$/);
    // Nothing grew: the task's budget and the session's cap are what they were.
    expect((await w.rt.store.task.mustGet(shop)).budget_usd_micro).toBe(budgetBefore);
    expect((await w.rt.store.session.mustGet(String(second.id))).budget_cap_usd_micro).toBe(
      2_000_000,
    );
  }, 300_000);
});

/**
 * C4b-left-5 (d1109-cred-screens, BA-12; the owner's answer of 2026-11-16: a task's budget counts
 * "critics reviews, and fixes"): the Start dialog warns when a task's own budget may leave too
 * little for its review (its estimate plus one critic call's worst case against what is left of
 * it), so the person reads before Start that its review then waits for Continue. Before, the start
 * check said nothing of it: the work ran, and the review waited with one card (BA-3).
 */
describe("d1109-cred-screens, run C: the Start check says when a task's budget may leave too little for its review (C4b-left-5)", () => {
  const clock = new SimulatedClock("2026-11-09T09:00:00Z");
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened) await rt.close().catch(() => undefined);
  });

  it("one line per task whose own budget cannot hold its estimate and its review's worst call; none for a roomy budget or a task without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-review-may-wait-"));
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Club page");
    const tight = await addTask(
      w,
      projectId,
      "Add a footer line with the club's name to index.html",
      "index.html",
      0.05,
      "high",
    );
    // Its estimate (USD 0.05 of work and its review part) and one review call's worst case are
    // more than its USD 0.09: after the work, too little is left for the review.
    await w.rt.store.task.patch(tight, { budget_usd_micro: 90_000 });
    const roomy = await addTask(w, projectId, "Write the about page", "about.html", 0.05);
    await w.rt.store.task.patch(roomy, { budget_usd_micro: 20_000_000 });
    await addTask(w, projectId, "Write the contact page", "contact.html", 0.05, "low");
    const check = (await w.json(`/projects/${projectId}/start-check`)) as Json;
    const lines = (check.reviewMayWait as Json[]).map((t) => [t.taskId, t.line]);
    expect(lines).toEqual([
      [
        tight,
        expect.stringMatching(
          /^"Add a footer line with the club's name to index\.html": its budget of CHF \d+\.\d\d may leave too little for its review, which then waits for Continue\.$/,
        ),
      ],
    ]);
    // The figure is the task's own budget in CHF at the daemon's rate, as every money line.
    const budget = check.sessionBudget as Json;
    const rate = Number(budget.chfMicro) / Number(budget.usdMicro);
    const chf = (Math.round((90_000 * rate) / 10_000) / 100).toFixed(2);
    expect(String(lines[0]?.[1])).toContain(`its budget of CHF ${chf} may`);
  }, 60_000);
});

/**
 * l4-money-pause, run L4 (L4-money-102, live check 4's LC-C7; option C, the owner's "the session
 * keeps its promise and spare budget isn't wasted"): a larger task's clean wrap-up paused at the
 * session's work budget with CHF 0.09 of it left, the session ended at once ("Stopped: the budget
 * is used" beside "CHF 0.23 of CHF 0.40") and the tagline task after it (about CHF 0.06) waited
 * for the next session, "used the rest of this one". A session ends at such a pause only when it
 * cannot take more work: the hooks refused a call at its cap, it takes no new work, or the room
 * left is less than the smallest task after the larger one.
 */
describe("l4-money-pause, run L4: a larger task's wrap-up leaves the rest of the session to the tasks after it (L4-money-102)", () => {
  const clock = new SimulatedClock("2026-11-17T06:00:00Z");
  const opened: RuntimeApp[] = [];
  const homes: string[] = [];
  afterAll(async () => {
    for (const rt of opened) {
      await settleSessions(rt);
      await rt.close().catch(() => undefined);
    }
    removeHomes(homes);
  });
  const USED = [
    "used the rest of this one",
    "The session's budget is used",
    "Stopped: the budget is used",
  ];

  it("the task after it runs in the same session when the wrap-up leaves room for it: B done, one card for the larger task, no 'budget is used'", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-l4-money-102-"));
    homes.push(home);
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Bakery");
    const big = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "high");
    const b = await addTask(w, projectId, "Write a tagline in tagline.md", "tagline.md", 0.05);
    const ended = await runSession(w, projectId);
    const sessionId = String(ended.id);
    // The larger task left more than B's estimate of the work budget (USD 1.60) unspent.
    const bigSpent = (await w.rt.store.task.mustGet(big)).actual_cost_usd_micro;
    expect(1_600_000 - bigSpent).toBeGreaterThan(50_000);
    const started = (await w.rt.store.event.list(sessionId))
      .filter((e) => e.type === "task.started")
      .map((e) => (e.payload as Json).taskId);
    expect(started).toEqual([big, b]);
    expect((await w.rt.store.task.mustGet(b)).status).toBe("done");
    expect((await w.rt.store.task.mustGet(big)).status).toBe("needs_human");
    expect(
      (await w.rt.store.humanRequest.list({ task_id: big, status: "open" } as never)).length,
    ).toBe(1);
    expect(ended.stopReason).not.toBe("budget_exceeded");
    // What the person reads: the session (its status, result and figures) and its log.
    const view = JSON.stringify(await w.json(`/sessions/${sessionId}`));
    for (const said of USED) expect(view).not.toContain(said);
    const log = (await personLines(w, sessionId)).join(" | ");
    for (const said of USED) expect(log).not.toContain(said);
    // Nothing passed the work budget: what the session's runs spent is within it.
    const runs = [
      ...(await w.rt.store.run.forTask(big)),
      ...(await w.rt.store.run.forTask(b)),
    ].filter((r) => r.specialist !== "critic" && r.session_id === sessionId);
    expect(runs.reduce((s, r) => s + r.cost_usd_micro, 0)).toBeLessThanOrEqual(1_600_000);
  }, 240_000);

  it("a task after it that does not fit what is left waits, and the result says what the larger task left: no 'used the rest', no 'budget is used'", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-l4-money-102-wait-"));
    homes.push(home);
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Bakery two");
    const big = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "high");
    // Fits the work budget (USD 1.60) alone, not what the larger task leaves of it.
    const b = await addTask(w, projectId, "Write the menu in menu.md", "menu.md", 1.5);
    const ended = await runSession(w, projectId);
    const sessionId = String(ended.id);
    const started = (await w.rt.store.event.list(sessionId))
      .filter((e) => e.type === "task.started")
      .map((e) => (e.payload as Json).taskId);
    expect(started).toEqual([big]);
    expect((await w.rt.store.task.mustGet(b)).status).toBe("ready");
    expect(ended.stopReason).not.toBe("budget_exceeded");
    expect(String(ended.summary)).toMatch(
      /"Write the menu in menu\.md" \(about CHF \d+\.\d\d\) waits for your next session: "Build the shop in shop\.md" left CHF \d+\.\d\d of this one\./,
    );
    const view = JSON.stringify(await w.json(`/sessions/${sessionId}`));
    for (const said of USED) expect(view).not.toContain(said);
    // L4-money-104 with L4-selftasks-107: the session's size is its promise, said once and
    // measured the same: no item "cut to fit the budget", the promise's two tasks and its figure
    // in the session review (before: "(1 item cut to fit the budget)", "0 of 1 planned task").
    const events = (await w.json(`/sessions/${sessionId}/events`)) as unknown as Json[];
    const said = events.map((e) => String(e.text ?? ""));
    expect(said.join(" | ")).not.toContain("cut to fit the budget");
    const promised = said
      .map((l) => /^It promised 2 tasks, about (CHF \d+\.\d\d)\.$/.exec(l))
      .find(Boolean);
    expect(promised, said.join(" | ")).toBeTruthy();
    const measured = said.find((l) => l.startsWith("Session review measured:")) ?? "";
    expect(measured).toContain("0 of 2 planned tasks done");
    expect(measured).toContain(`against an estimate of ${promised?.[1]}`);
  }, 240_000);
});
