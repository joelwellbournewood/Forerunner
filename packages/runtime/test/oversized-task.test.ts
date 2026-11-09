import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { handoffOf } from "../src/session/budget-pause.ts";

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
    expect(card?.title).toBe(
      '"Build the shop in shop.md" paused at this session\'s budget of CHF 1.60',
    );
    expect(String(ended.stopReason)).toMatch(/^budget_/);

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

  it("with two tasks that fit first, they are done and reviewed before the larger task starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-oversized-fit-"));
    const w = await compose(home, clock);
    opened.push(w.rt);
    const projectId = await newProject(w, "Shop two");
    const shop = await addTask(w, projectId, "Build the shop in shop.md", "shop.md", 8, "high");
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
