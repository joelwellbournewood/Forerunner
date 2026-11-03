import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WRAP_UP_TEXT } from "../src/agent/loop.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ChatMessage, ModelRequest } from "../src/provider/types.ts";
import { handoffOf } from "../src/session/budget-pause.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";
import { type RuntimeWatch, watchRuntime } from "./runtime-watch.ts";

/**
 * Budget-stop (ADR 0112, the owner's decision of 2026-11-02), through the composed runtime and
 * its routes: a task's run hears once that about a fifth of its budget is left; a run that then
 * ends with work under "Left to do:" is paused (no review, no failed try, its report and its
 * handoff kept, the Run row "paused"); one that ends with nothing left, or never heard it, is
 * reviewed; a tiny budget hears nothing and pauses at its budget with the save only; a stop at
 * the month's cap names the month; and a run cannot eat the share of the session kept for
 * reviews. Before, a run that reached its budget was cut off unwarned, its report replaced by
 * "The run failed: run budget would be exceeded", and any stop below the session's remainder
 * read as the task's own budget.
 *
 * Prices are the fake provider's: one token is one micro-USD.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const WRAP = "About a fifth of this task's budget is left";

const textOf = (m: ChatMessage) =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
const heardWrapUp = (req: ModelRequest) =>
  req.messages.some((m) => m.role === "user" && textOf(m).includes(WRAP));
const coderOn = (title: string) => (req: ModelRequest) =>
  (req.origin?.label ?? "").startsWith(`coder on ${title}`);

/** The coder on `title` works (a cheap tool call costing `perCall`) until it hears the wrap-up. */
function works(title: string, perCall: number, afterWrapUp: string) {
  return [
    textReply(afterWrapUp, {
      when: (r: ModelRequest) => coderOn(title)(r) && heardWrapUp(r),
      times: Number.POSITIVE_INFINITY,
      usage: { input_tokens: 1_000, output_tokens: 50 },
    }),
    toolReply("list_dir", { path: "." }, "Working on the next part.", {
      when: coderOn(title),
      times: Number.POSITIVE_INFINITY,
      usage: { input_tokens: perCall, output_tokens: 10 },
    }),
  ];
}

const LEFT =
  "Summary: wrote the first parts.\n\nWhere I stopped: the first two sections are written.\n\nLeft to do:\n- write the last section\n- check the links";
const NOTHING_LEFT =
  "Summary: wrote every section.\n\nWhere I stopped: all sections are written.\n\nLeft to do: nothing";

function provider(clock: SimulatedClock, calls: ModelRequest[]) {
  const fake = new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      ...works("Guide pages", 30_000, LEFT),
      ...works("Notes page", 30_000, NOTHING_LEFT),
      // Never told to wrap up: its first answer lists work left, and it is reviewed as usual.
      textReply("Wrote plan.html.\n\nLeft to do:\n- add a print style", {
        when: coderOn("Plan page"),
        times: Number.POSITIVE_INFINITY,
      }),
      ...works("Tiny page", 5_000, LEFT),
      ...works("Big report", 150_000, NOTHING_LEFT),
      ...works("Members list", 30_000, LEFT),
    ],
  });
  const stream = fake.stream.bind(fake);
  fake.stream = (req) => {
    calls.push({ ...req, messages: structuredClone(req.messages) });
    return stream(req);
  };
  return fake;
}

async function compose(home: string, clock: SimulatedClock, fake: FakeProvider) {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault(),
    provider: fake,
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
  // What the cases start, watched: a wait goes on while the runtime moves and stops what runs
  // (Stop now) before it gives up; `settle` before the runtime closes.
  const watch = watchRuntime(rt, { request: req });
  return { rt, req, watch };
}

type Req = Awaited<ReturnType<typeof compose>>["req"];

/** A project with one task (what New task sends), a session on it, run to its end. */
async function runOne(
  { req, rt, watch }: { req: Req; rt: RuntimeApp; watch: RuntimeWatch },
  title: string,
  opts: { budgetUsdMicro?: number; sessionBudgetUsdMicro?: number } = {},
) {
  const projectId = (
    (await (
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: `${title} project`, goal: "Pages for the club" }),
      })
    ).json()) as Json
  ).id as string;
  const created = await req(`/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      title,
      outcome: `${title.toLowerCase().replace(/\s+/g, "-")}.html exists`,
      acceptanceCriteria: ["the page exists"],
      priority: "high",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: opts.budgetUsdMicro ?? 0,
      specialist: "coder",
      riskTier: 1,
    }),
  });
  expect(created.status).toBe(201);
  const taskId = ((await created.json()) as Json).id as string;
  const started = await req("/sessions", {
    method: "POST",
    body: JSON.stringify({
      agentId: rt.agent.id,
      projectId,
      trigger: "manual",
      ...(opts.sessionBudgetUsdMicro ? { budgetUsdMicro: opts.sessionBudgetUsdMicro } : {}),
    }),
  });
  expect(started.status, await started.clone().text()).toBe(202);
  const sessionId = watch.track((((await started.json()) as Json).session as Json).id as string);
  await watch.sessionOver(sessionId, {
    seen: async () => `the task "${title}" is ${(await rt.store.task.mustGet(taskId)).status}`,
  });
  const session = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
  const view = ((await (await req(`/projects/${projectId}/tasks`)).json()) as Json[]).find(
    (t) => t.id === taskId,
  ) as Json;
  const events = (await (await req(`/sessions/${sessionId}/events`)).json()) as Json[];
  const runs = (await rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
  return { projectId, taskId, sessionId, session, view, events, runs };
}

const lines = (events: Json[]) => events.map((e) => String(e.text ?? ""));

describe("a budget stop is a clean pause (budget-stop, ADR 0112)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-budget-pause-"));
  const calls: ModelRequest[] = [];
  const fake = provider(clock, calls);
  let rt: RuntimeApp;
  let req: Req;
  let watch: RuntimeWatch;

  beforeAll(async () => {
    ({ rt, req, watch } = await compose(home, clock, fake));
  }, 120_000);
  afterAll(async () => {
    await watch?.settle();
    await rt?.close();
  });

  const coderCalls = (title: string) => calls.filter(coderOn(title));
  const reviewOf = async (taskId: string) => rt.store.review.latestForTask(taskId);

  it("a run at its line hears the wrap-up once; with work left it is paused: no review, no try, report and handoff kept", async () => {
    const r = await runOne({ req, rt, watch }, "Guide pages", { budgetUsdMicro: 300_000 });
    // Exactly one request first carried the wrap-up: one text block after the tool results.
    const mine = coderCalls("Guide pages");
    const first = mine.findIndex(heardWrapUp);
    expect(first).toBeGreaterThan(0);
    const last = mine[first]?.messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(blocks.filter((b) => b.type === "text")).toEqual([{ type: "text", text: WRAP_UP_TEXT }]);
    expect(mine.slice(0, first).some(heardWrapUp)).toBe(false);
    // Paused: the task waits on its card, no critic reviewed it, no try was counted.
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("needs_human");
    expect(task.attempt).toBe(0);
    expect(await reviewOf(r.taskId)).toBeUndefined();
    expect(calls.some((c) => (c.origin?.label ?? "").includes(r.taskId))).toBe(false);
    expect(r.view.display).toMatchObject({
      key: "answer",
      label: "Paused at its budget",
      blocker: { kind: "card", cardKind: "budget" },
    });
    // The Run row says paused, keeps the report and the handoff (data only).
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]?.outcome).toBe("paused");
    // A pause is a lower bound of what the task costs: the estimates are not fed it.
    expect(rt.estimates.recentSamples().some((x) => x.taskId === r.taskId)).toBe(false);
    expect(JSON.stringify(r.runs[0]?.artifacts)).toContain("Left to do:");
    expect(handoffOf(r.runs[0]?.artifacts)).toEqual({
      stopped: "the first two sections are written.",
      leftToDo: ["write the last section", "check the links"],
      stoppedBy: "wrap_up",
    });
    // The session's log names the run's budget line, the wrap-up and the pause.
    const said = lines(r.events);
    expect(
      said.some((l) =>
        /^This run may spend CHF [\d.]+: at CHF [\d.]+ it is told to wrap up, keeping a reserve of CHF [\d.]+ to finish\.$/.test(
          l,
        ),
      ),
    ).toBe(true);
    // Said by the line (review of budget-stop: "about a fifth ... is left (it spent CHF 0.02 of
    // CHF 0.04)" was not what was left, since the call that would pass the line brings it).
    expect(
      said.some((l) =>
        /^Told the coder to wrap up: it spent CHF [\d.]+ of CHF 0\.24, and the last CHF 0\.05 is kept to finish\.$/.test(
          l,
        ),
      ),
      said.join(" | "),
    ).toBe(true);
    expect(said.join(" | ")).not.toMatch(/a fifth of this task's budget is left/);
    expect(
      said.some((l) =>
        /^"Guide pages" paused before its budget of CHF 0\.24 ran out: it spent CHF [\d.]+ and listed 2 things left to do\.$/.test(
          l,
        ),
      ),
    ).toBe(true);
  }, 120_000);

  it("a run that hears the wrap-up and ends with nothing left is reviewed", async () => {
    const r = await runOne({ req, rt, watch }, "Notes page", { budgetUsdMicro: 300_000 });
    expect(coderCalls("Notes page").some(heardWrapUp)).toBe(true);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
    expect(r.runs[0]?.outcome).toBe("completed");
    // A finished task is a sample, as before.
    expect(rt.estimates.recentSamples().some((x) => x.taskId === r.taskId)).toBe(true);
  }, 120_000);

  it("a run never told to wrap up that lists work left is reviewed as usual", async () => {
    const r = await runOne({ req, rt, watch }, "Plan page", { budgetUsdMicro: 300_000 });
    expect(coderCalls("Plan page").some(heardWrapUp)).toBe(false);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
  }, 120_000);

  it("a tiny budget hears no wrap-up and pauses at its budget with the save only", async () => {
    // CHF 0.01: two calls are more than the whole budget.
    const r = await runOne({ req, rt, watch }, "Tiny page", { budgetUsdMicro: 12_500 });
    const mine = coderCalls("Tiny page");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some(heardWrapUp)).toBe(false);
    for (const c of mine) expect(JSON.stringify(c.messages)).not.toContain(WRAP);
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("needs_human");
    expect(task.attempt).toBe(0);
    expect(await reviewOf(r.taskId)).toBeUndefined();
    expect(r.runs[0]?.outcome).toBe("budget_exceeded");
    expect(handoffOf(r.runs[0]?.artifacts)).toEqual({
      stopped: "",
      leftToDo: [],
      stoppedBy: "budget",
    });
    // The stop's words go beside the report, never "The run failed: run budget would be exceeded".
    const artifacts = JSON.stringify(r.runs[0]?.artifacts);
    expect(artifacts).toContain("The run stopped at a budget before its next step.");
    expect(artifacts).not.toContain("would be exceeded");
    expect(r.view.display).toMatchObject({ label: "Paused at its budget" });
    expect(lines(r.events).some((l) => /too little to wrap up .*: save only/.test(l))).toBe(true);
  }, 120_000);

  // Review of budget-stop: a budget below its first call's worst case (live check 3's CHF 0.02
  // on Sonnet) was refused before its line was said, so the session log had no budget line.
  it("a budget below its first step's cost says so (save only) and pauses before that step", async () => {
    const r = await runOne({ req, rt, watch }, "Stub page", { budgetUsdMicro: 1_000 });
    expect(coderCalls("Stub page")).toHaveLength(0);
    expect(
      lines(r.events).some((l) =>
        /^This run may spend CHF [\d.]+, less than its first step may cost \(CHF [\d.]+\): save only, it pauses at its budget before that step\.$/.test(
          l,
        ),
      ),
      lines(r.events).join(" | "),
    ).toBe(true);
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("needs_human");
    expect(task.attempt).toBe(0);
    expect(await reviewOf(r.taskId)).toBeUndefined();
    expect(r.view.display).toMatchObject({ label: "Paused at its budget" });
  }, 120_000);

  it("a run is capped at what is left of the session's work budget, so its review keeps the reserve", async () => {
    // A session of USD 2 and a task with no budget of its own (the coder's limit is USD 3): the
    // run may spend the session's work budget, USD 1.60 (CHF 1.28), not the whole USD 2. (The
    // Start dialog's check needs the work budget to hold the coder's estimate of USD 1.50.)
    const r = await runOne({ req, rt, watch }, "Big report", { sessionBudgetUsdMicro: 2_000_000 });
    expect(lines(r.events).some((l) => l.startsWith("This run may spend CHF 1.28: at CHF "))).toBe(
      true,
    );
    // It heard the wrap-up inside the work budget, finished, and the critic reviewed it.
    expect(coderCalls("Big report").some(heardWrapUp)).toBe(true);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
    const spentByRun = r.runs[0]?.cost_usd_micro ?? 0;
    expect(spentByRun).toBeLessThanOrEqual(1_600_000);
  }, 120_000);

  it("a paused task stays paused across a restart: the card, the words and the Run row", async () => {
    const guide = (await rt.store.task.list({} as never, { limit: 100 })).find(
      (t) => t.title === "Guide pages",
    );
    expect(guide).toBeDefined();
    await watch.settle();
    await rt.close();
    ({ rt, req, watch } = await compose(home, clock, fake));
    await rt.syncApprovals();
    const view = (
      (await (await req(`/projects/${guide?.project_id}/tasks`)).json()) as Json[]
    ).find((t) => t.id === guide?.id) as Json;
    expect(view.display).toMatchObject({ label: "Paused at its budget" });
    const runs = (await rt.store.run.forTask(guide?.id ?? "")).filter(
      (x) => x.specialist !== "critic",
    );
    expect(runs.map((x) => x.outcome)).toEqual(["paused"]);
    expect(handoffOf(runs[0]?.artifacts)?.leftToDo).toEqual([
      "write the last section",
      "check the links",
    ]);
  }, 120_000);
});

describe("a stop at the month's cap names the month (budget-stop, ADR 0112)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-budget-month-"));
  const calls: ModelRequest[] = [];
  const fake = provider(clock, calls);
  let rt: RuntimeApp;
  let req: Req;
  let watch: RuntimeWatch;

  beforeAll(async () => {
    ({ rt, req, watch } = await compose(home, clock, fake));
    // A month's cap of USD 0.125 (CHF 0.10): the task's own budget is far above it.
    await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: 125_000 });
  }, 120_000);
  afterAll(async () => {
    await watch?.settle();
    await rt?.close();
  });

  it("the run's sentence and the card name this month's cap, and the session stops there", async () => {
    const r = await runOne({ req, rt, watch }, "Members list", { budgetUsdMicro: 2_000_000 });
    const said = lines(r.events);
    // Before: "stopped at its budget of CHF 1.60", and its card offered to raise that budget.
    expect(
      said.some((l) =>
        /^"Members list" stopped at this month's cap of CHF 0\.10: it spent CHF [\d.]+, and its next step would have gone over\.$/.test(
          l,
        ),
      ),
    ).toBe(true);
    const card = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
      (q) => q.taskId === r.taskId && q.status === "open",
    );
    expect(card?.title).toBe('"Members list" stopped at this month\'s cap of CHF 0.10');
    expect(r.view.display).toMatchObject({ label: "Paused at this month's cap" });
    expect(await rt.store.review.latestForTask(r.taskId)).toBeUndefined();
    expect(r.runs[0]?.outcome).toBe("budget_exceeded");
  }, 120_000);

  // Review of budget-stop: the run, the card and the task named the month, but the session it
  // ended said "Stopped: the budget is used" and "The session's budget is used." (at CHF 0.04 of
  // a CHF 5.00 session), the Inbox Update said the same, and the urgent notification advised
  // "Start a session with a larger budget to go on", which the month's cap refuses.
  it("the session it ends names this month's cap too: its status, its result, its log, the Update and the notification", async () => {
    const r = await runOne({ req, rt, watch }, "Members page", { budgetUsdMicro: 2_000_000 });
    expect(r.session.status).toBe("stopped");
    expect(r.session.statusText).toBe("Stopped at this month's cap");
    const summary = String(r.session.summary);
    expect(summary).toContain("Stopped at this month's cap of CHF 0.10.");
    expect(summary).not.toMatch(/session's budget|budget is used/);
    const said = lines(r.events);
    // The session's end line (before: "Stopped: the budget is used: 1 needs you. CHF 0.04.").
    expect(
      said.some((l) => /^Stopped at this month's cap: /.test(l)),
      said.join(" | "),
    ).toBe(true);
    expect(said.join(" | ")).not.toMatch(/budget is used/);
    // The Inbox Update (the card says the task's decision; the Update says how the session ended).
    const updates = ((await (await req("/inbox")).json()) as { messages: Json[] }).messages
      .filter((m) => m.projectId === r.projectId)
      .map((m) => String(m.body));
    expect(updates.join(" | ")).toContain("Stopped at this month's cap of CHF 0.10.");
    expect(updates.join(" | ")).not.toMatch(/budget is used/);
    // The urgent notification names the month and says what helps.
    const recent = async () =>
      (
        (await (await req("/notifications/recent?limit=200")).json()) as {
          notifications: Json[];
        }
      ).notifications;
    const stop = await watch.waitFor(
      "the session's budget_stop notification",
      async () =>
        (await recent()).find((n) => n.kind === "budget_stop" && n.sessionId === r.sessionId),
      {
        seen: async () =>
          `notifications of the session: ${(await recent())
            .filter((n) => n.sessionId === r.sessionId)
            .map((n) => `${n.kind}: ${n.title}`)
            .join("; ")}`,
      },
    );
    expect(String(stop.title)).toBe("Members page project: stopped at this month's cap");
    expect(String(stop.body)).toMatch(
      /^This month's cap is CHF 0\.10\. The session spent CHF [\d.]+\. .*Raise the monthly spending cap in Settings to go on\.$/,
    );
    expect(String(stop.body)).not.toMatch(/larger budget|session's budget/);
  }, 120_000);
});
