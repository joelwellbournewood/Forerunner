import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  FakeProvider,
  messagesApiStandIn,
  standInFetch,
  textReply,
  toolReply,
} from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WRAP_UP_MARK, wrapUpText } from "../src/agent/loop.ts";
import { composeRuntime, type DynamicCaps, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ChatMessage, ModelRequest } from "../src/provider/types.ts";
import { wakeBudgetWaits } from "../src/session/budget-card.ts";
import {
  budgetLineWords,
  handoffOf,
  limitWords,
  parseHandoff,
  pauseSentence,
  WRAP_UP_BRIEF_LINE,
  wrapUpSentWords,
} from "../src/session/budget-pause.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

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
const WRAP = WRAP_UP_MARK;

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
      textReply("Wrote members-chart.html.\n\nLeft to do: nothing", {
        when: coderOn("Members chart"),
        times: Number.POSITIVE_INFINITY,
      }),
      // One cheap call that finishes: its review is what meets the project's budget.
      textReply("Wrote review-page.html.\n\nLeft to do: nothing", {
        when: coderOn("Review page"),
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 500, output_tokens: 20 },
      }),
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
  return { rt, req };
}

/** Polls in real time (at least 10 s); the error says what was seen last. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: () => Promise<string>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${await what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Req = Awaited<ReturnType<typeof compose>>["req"];

/** A project with one task (what New task sends), a session on it, run to its end. */
async function runOne(
  req: Req,
  rt: RuntimeApp,
  title: string,
  opts: {
    budgetUsdMicro?: number;
    sessionBudgetUsdMicro?: number;
    /** The project's own budget (0: none), set before its task is added. */
    projectBudgetUsdMicro?: number;
  } = {},
) {
  const projectId = (
    (await (
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: `${title} project`, goal: "Pages for the club" }),
      })
    ).json()) as Json
  ).id as string;
  if (opts.projectBudgetUsdMicro)
    await rt.store.project.patch(projectId, { budget_usd_micro: opts.projectBudgetUsdMicro });
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
  const sessionId = (((await started.json()) as Json).session as Json).id as string;
  const session = await waitFor(
    async () => {
      const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
      return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
        ? s
        : undefined;
    },
    async () =>
      `the session of "${title}" to end (${(await rt.store.task.mustGet(taskId)).status})`,
  );
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

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const coderCalls = (title: string) => calls.filter(coderOn(title));
  const reviewOf = async (taskId: string) => rt.store.review.latestForTask(taskId);
  /** The session's own review (no task) and its findings' descriptions. */
  const sessionReviewOf = async (sessionId: string) =>
    (await rt.store.review.list({ session_id: sessionId } as never, { limit: 10 })).filter(
      (x) => x.task_id === null,
    );
  const sessionFindings = async (sessionId: string) => {
    const [review] = await sessionReviewOf(sessionId);
    return review ? (await rt.store.finding.forReview(review.id)).map((f) => f.description) : [];
  };

  it("a run at its line hears the wrap-up once; with work left it is paused: no review, no try, report and handoff kept", async () => {
    const r = await runOne(req, rt, "Guide pages", { budgetUsdMicro: 300_000 });
    // Exactly one request first carried the wrap-up: one text block after the tool results.
    const mine = coderCalls("Guide pages");
    const first = mine.findIndex(heardWrapUp);
    expect(first).toBeGreaterThan(0);
    const last = mine[first]?.messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
    // W15-16: worded when it is sent, with the share of the budget really used.
    expect(blocks.filter((b) => b.type === "text")).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^Wrap up now: this task has used \d+% of its budget, and its next step could take it past the share kept to finish\./,
        ),
      },
    ]);
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
        /^This run may spend CHF [\d.]+: before a step that could take it past CHF [\d.]+ it is told to wrap up, keeping a reserve of CHF [\d.]+ to finish\.$/.test(
          l,
        ),
      ),
    ).toBe(true);
    // Said by the line (review of budget-stop: "about a fifth ... is left (it spent CHF 0.02 of
    // CHF 0.04)" was not what was left, since the call that would pass the line brings it).
    expect(
      said.some((l) =>
        /^Told the coder to wrap up: it spent CHF [\d.]+ of CHF 0\.24, and its next step could take it past CHF 0\.19\.$/.test(
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
    // The session review counts a pause as a pause (the leftovers of wave 7, R-sessreview): never
    // "No planned task was done: 1 of 1 waits for the person" (its cost against the estimate is
    // still checked: this run's fake price overran it).
    expect((await sessionFindings(r.sessionId)).join(" | ")).not.toMatch(
      /No planned task was done|no task reached done/,
    );
  }, 60_000);

  it("a run that hears the wrap-up and ends with nothing left is reviewed", async () => {
    const r = await runOne(req, rt, "Notes page", { budgetUsdMicro: 300_000 });
    expect(coderCalls("Notes page").some(heardWrapUp)).toBe(true);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
    expect(r.runs[0]?.outcome).toBe("completed");
    // A finished task is a sample, as before.
    expect(rt.estimates.recentSamples().some((x) => x.taskId === r.taskId)).toBe(true);
  }, 60_000);

  it("a run never told to wrap up that lists work left is reviewed as usual", async () => {
    const r = await runOne(req, rt, "Plan page", { budgetUsdMicro: 300_000 });
    expect(coderCalls("Plan page").some(heardWrapUp)).toBe(false);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
  }, 60_000);

  it("a tiny budget hears no wrap-up and pauses at its budget with the save only", async () => {
    // CHF 0.01: two calls are more than the whole budget.
    const r = await runOne(req, rt, "Tiny page", { budgetUsdMicro: 12_500 });
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
    expect(
      lines(r.events).some((l) =>
        /too little to wrap up .*: it pauses at its budget and keeps its work\./.test(l),
      ),
    ).toBe(true);
    // A session whose only task paused at its budget is not sent back for changes (the leftovers
    // of wave 7, R-sessreview): before, "Session review: sent back for changes (grade 70, 2
    // findings)" with "No planned task was done: 1 of 1 waits for the person" and "spent ... and
    // no task reached done".
    const [review] = await sessionReviewOf(r.sessionId);
    expect(review?.verdict, JSON.stringify(await sessionFindings(r.sessionId))).not.toBe("revise");
    expect((await sessionFindings(r.sessionId)).join(" | ")).not.toMatch(
      /No planned task was done|no task reached done/,
    );
    expect(lines(r.events).join(" | ")).not.toMatch(/Session review: sent back/);
  }, 60_000);

  // Review of budget-stop: a budget below its first call's worst case (live check 3's CHF 0.02
  // on Sonnet) was refused before its line was said, so the session log had no budget line.
  it("a budget below its first step's cost says so (save only) and pauses before that step", async () => {
    const r = await runOne(req, rt, "Stub page", { budgetUsdMicro: 1_000 });
    expect(coderCalls("Stub page")).toHaveLength(0);
    expect(
      lines(r.events).some((l) =>
        /^This run may spend .*less than its first step may cost .*: it pauses at its budget before that step\.$/.test(
          l,
        ),
      ),
      lines(r.events).join(" | "),
    ).toBe(true);
    // W14-6 (polish-words): an amount above zero never reads "CHF 0.00" in the budget line.
    expect(lines(r.events).find((l) => /first step may cost/.test(l))).not.toMatch(/CHF 0\.00/);
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("needs_human");
    expect(task.attempt).toBe(0);
    expect(await reviewOf(r.taskId)).toBeUndefined();
    expect(r.view.display).toMatchObject({ label: "Paused at its budget" });
  }, 60_000);

  it("a run is capped at what is left of the session's work budget, so its review keeps the reserve", async () => {
    // A session of USD 2 and a task with no budget of its own (the coder's limit is USD 3): the
    // run may spend the session's work budget, USD 1.60 (CHF 1.28), not the whole USD 2. (The
    // Start dialog's check needs the work budget to hold the coder's estimate of USD 1.50.)
    const r = await runOne(req, rt, "Big report", { sessionBudgetUsdMicro: 2_000_000 });
    expect(
      lines(r.events).some((l) =>
        l.startsWith("This run may spend CHF 1.28: before a step that could take it past CHF "),
      ),
    ).toBe(true);
    // It heard the wrap-up inside the work budget, finished, and the critic reviewed it.
    expect(coderCalls("Big report").some(heardWrapUp)).toBe(true);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("done");
    expect(await reviewOf(r.taskId)).toBeDefined();
    const spentByRun = r.runs[0]?.cost_usd_micro ?? 0;
    expect(spentByRun).toBeLessThanOrEqual(1_600_000);
  }, 60_000);

  it("a paused task stays paused across a restart: the card, the words and the Run row", async () => {
    const guide = (await rt.store.task.list({} as never, { limit: 100 })).find(
      (t) => t.title === "Guide pages",
    );
    expect(guide).toBeDefined();
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
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

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    // A month's cap of USD 0.125 (CHF 0.10): the task's own budget is far above it.
    await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: 125_000 });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the run's sentence and the card name this month's cap, and the session stops there", async () => {
    const r = await runOne(req, rt, "Members list", { budgetUsdMicro: 2_000_000 });
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
    expect(card?.title).toBe('"Members list" paused at this month\'s cap of CHF 0.10');
    // budget-resume: a bigger task budget does not help at the month's cap (the review of
    // budget-stop: Raise the budget started a session that stopped at once at the same cap):
    // the card offers no Continue, says where to change it and that the task goes on by itself.
    expect(((card?.choices ?? []) as Json[]).map((c) => c.label)).toEqual(["Cancel task"]);
    expect(card?.links).toEqual([
      {
        label: "Open Settings",
        to: "/settings",
        explain: "Raise it there; the task goes on by itself.",
      },
    ]);
    expect(String(card?.body)).toMatch(
      /It goes on by itself once you raise the monthly cap in Settings, or on 1 December\.$/,
    );
    expect(r.view.display).toMatchObject({
      label: "Paused at this month's cap",
      detail: "It goes on by itself once that limit is raised or resets; cancel it in the Inbox.",
    });
    expect(await rt.store.review.latestForTask(r.taskId)).toBeUndefined();
    expect(r.runs[0]?.outcome).toBe("budget_exceeded");
  }, 60_000);

  // Review of budget-stop: the run, the card and the task named the month, but the session it
  // ended said "Stopped: the budget is used" and "The session's budget is used." (at CHF 0.04 of
  // a CHF 5.00 session), the Inbox Update said the same, and the urgent notification advised
  // "Start a session with a larger budget to go on", which the month's cap refuses.
  it("the session it ends names this month's cap too: its status, its result, its log, the Update and the notification", async () => {
    const r = await runOne(req, rt, "Members page", { budgetUsdMicro: 2_000_000 });
    expect(r.session.status).toBe("stopped");
    expect(r.session.statusText).toBe("Stopped at this month's cap");
    const summary = String(r.session.summary);
    expect(summary).toContain("Stopped at this month's cap of CHF 0.10.");
    expect(summary).not.toMatch(/session's budget|budget is used/);
    // Its card offers no Continue (the fixup's bench walk: the result said "continue or cancel
    // it in the Inbox"): it says how the task goes on.
    expect(summary).toContain(
      '"Members page" paused at this month\'s cap of CHF 0.10: it goes on by itself once that limit is raised or resets.',
    );
    expect(summary).not.toContain("continue or cancel");
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
    const stop = await waitFor(
      async () =>
        (
          (await (await req("/notifications/recent?limit=200")).json()) as {
            notifications: Json[];
          }
        ).notifications.find((n) => n.kind === "budget_stop" && n.sessionId === r.sessionId),
      async () => "the session's budget_stop notification",
    );
    expect(String(stop.title)).toBe("Members page project: stopped at this month's cap");
    expect(String(stop.body)).toMatch(
      /^This month's cap is CHF 0\.10\. The session spent CHF [\d.]+\. .*Raise the monthly spending cap in Settings to go on\.$/,
    );
    expect(String(stop.body)).not.toMatch(/larger budget|session's budget/);
  }, 60_000);

  it("once the month's cap has room again the paused task goes on by itself: its card closes and it is ready (budget-resume)", async () => {
    const r = await runOne(req, rt, "Members map", { budgetUsdMicro: 2_000_000 });
    expect(r.view.display).toMatchObject({ label: "Paused at this month's cap" });
    // As the daemon's own wake asks (compose.ts): the caps read again, not from the minute's
    // cache, so the session that goes on does not meet the old cap.
    const roomFor = async (projectId: string) => {
      (rt.caps as DynamicCaps).forget({ humanId: rt.human.id, projectId });
      return (
        (await rt.caps.check({ humanId: rt.human.id, projectId }, 1, { phase: "work" }))
          .decision === "allow"
      );
    };
    // This month's cap as Settings has it now (compose's own port reads the same row).
    const limitNow = async () =>
      (await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro || Number.POSITIVE_INFINITY;
    const wake = (room = roomFor) =>
      wakeBudgetWaits({
        store: rt.store,
        clock,
        humanId: rt.human.id,
        agentId: rt.agent.id,
        limitNow,
        roomFor: room,
      });
    // Still at the cap: nothing moves.
    expect(await wake()).toBe(0);
    // Room alone is not a change (the review of budget-resume: a pause under the 80% line woke
    // at every tick and paused again at once): the cap is what the card names, so it stays.
    expect(await wake(async () => true)).toBe(0);
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("needs_human");
    // The person raises the monthly cap in Settings.
    await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: 150_000_000 });
    // It (and the other tasks paused at the month's cap) goes on.
    expect(await wake()).toBeGreaterThanOrEqual(1);
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("ready");
    expect(task.reason).toBe("its limit has room again: it continues from where it stopped");
    const card = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
      (q) => q.taskId === r.taskId,
    );
    expect(card?.status).toBe("withdrawn");
    expect(card?.outcome).toBe('"Members map" goes on: its limit has room again.');
  }, 60_000);
});

/**
 * The review of budget-resume: a task paused at an outer limit (the project's budget, this
 * month's cap) went on by itself at the next scheduler tick whenever the pause left the spend
 * under the limit's 80% line (the refused call's worst case would have reached 100%), with
 * nothing changed: every tick started a session that paused again, withdrew the card and filed
 * it anew, with urgent notifications, until the person cancelled the task. It goes on only once
 * the limit really changed (raised in Settings, or a new month), as its card says.
 */
describe("a task paused at the project's budget goes on only once that budget changes (budget-resume)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-budget-wake-"));
  const calls: ModelRequest[] = [];
  const fake = provider(clock, calls);
  let rt: RuntimeApp;
  let req: Req;

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const cardOf = async (taskId: string) =>
    ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.filter(
      (q) => q.taskId === taskId,
    );

  it("below the 80% line with nothing changed, the scheduler's ticks start nothing and keep the card; raising the budget in Settings starts one session that finishes it", async () => {
    // A project's budget of USD 0.0075 (CHF 0.01): the run's first call alone would go over
    // it, so it pauses with the project's spend under the 80% line: room for any small call.
    const r = await runOne(req, rt, "Members chart", {
      budgetUsdMicro: 2_000_000,
      projectBudgetUsdMicro: 7_500,
    });
    expect(r.view.display).toMatchObject({ label: "Paused at the project's budget" });
    expect(
      (await rt.caps.check({ humanId: rt.human.id, projectId: r.projectId }, 1, { phase: "work" }))
        .decision,
    ).toBe("allow");
    const before = await cardOf(r.taskId);
    expect(before.map((q) => q.status)).toEqual(["open"]);
    expect(before[0]?.title).toBe('"Members chart" paused at the project\'s budget of CHF 0.01');
    const sessions = async () => (await rt.store.session.forProject(r.projectId)).length;
    expect(await sessions()).toBe(1);

    // Ticks with nothing changed (before: each one woke it, a session paused again at once).
    for (let i = 0; i < 3; i++) {
      await clock.advance(30_000);
      await rt.scheduler.tick();
    }
    expect((await rt.store.task.mustGet(r.taskId)).status).toBe("needs_human");
    expect((await cardOf(r.taskId)).map((q) => [q.status, q.id])).toEqual([
      ["open", before[0]?.id],
    ]);
    expect(await sessions()).toBe(1);

    // The person raises the project's budget in Settings (the same command its row sends).
    const set = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          { name: "budget.set", params: { scope: "project", amountChf: 5, project: r.projectId } },
        ],
        wordsUsed: "Settings: Project budget to 5",
        source: "ui",
        projectId: r.projectId,
      }),
    });
    let result = (await set.json()) as Json;
    if (result.status === "pending")
      result = (await (
        await req(`/commands/${String(result.pendingId)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "tap" }),
        })
      ).json()) as Json;
    expect(result.status, JSON.stringify(result)).toBe("done");

    // The next tick wakes it: its card closes and one session starts and finishes it.
    await rt.scheduler.tick();
    const after = await cardOf(r.taskId);
    expect(after.map((q) => q.status)).toEqual(["withdrawn"]);
    expect(after[0]?.outcome).toBe('"Members chart" goes on: its limit has room again.');
    const done = await waitFor(
      async () => {
        const t = await rt.store.task.mustGet(r.taskId);
        return t.status === "done" ? t : undefined;
      },
      async () =>
        `"Members chart" to be done (${(await rt.store.task.mustGet(r.taskId)).status}, ${await sessions()} sessions)`,
    );
    expect(done.status).toBe("done");
    expect(await sessions()).toBe(2);
    // No further card: the session that went on did not pause again.
    expect((await cardOf(r.taskId)).map((q) => q.status)).toEqual(["withdrawn"]);
    // Nothing is left running for the next test.
    await waitFor(
      async () =>
        (await rt.store.session.forProject(r.projectId)).every((s) =>
          ["completed", "stopped", "failed", "killed"].includes(s.status),
        )
          ? true
          : undefined,
      async () => "the project's sessions to end",
    );
  }, 120_000);

  it("a task paused at this month's cap goes on in the new month by itself, never on room alone", async () => {
    // This month's cap just above what the month spent: the run's first call would go over it.
    const spent = (await rt.caps.check({ humanId: rt.human.id }, 0, { phase: "work" }))
      .spentUsdMicro as number;
    await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: spent + 5_000 });
    try {
      const r = await runOne(req, rt, "Members table", { budgetUsdMicro: 2_000_000 });
      expect(r.view.display).toMatchObject({ label: "Paused at this month's cap" });
      const [card] = await cardOf(r.taskId);
      expect(card?.status).toBe("open");
      const wake = (now: string) =>
        wakeBudgetWaits({
          store: rt.store,
          // Only the wake reads this clock: the runtime's own stays in November.
          clock: new SimulatedClock(now),
          humanId: rt.human.id,
          agentId: rt.agent.id,
          limitNow: async () =>
            (await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro ||
            Number.POSITIVE_INFINITY,
          // Room is there (a new month's spend starts at nothing): only the month decides.
          roomFor: async () => true,
        });
      // Later this month, with room and the cap unchanged: it stays paused.
      expect(await wake("2026-11-30T23:59:00.000Z")).toBe(0);
      expect((await rt.store.task.mustGet(r.taskId)).status).toBe("needs_human");
      // A card whose reset date is not after it was filed (one filed without the time says
      // 1 February 1970) still waits for the month after it was filed, never wakes at once.
      const row = await rt.store.humanRequest.mustGet(String(card?.id));
      await rt.store.humanRequest.patch(row.id, {
        change_card: { ...(row.change_card ?? {}), resets_at: "1970-02-01T00:00:00.000Z" },
      });
      expect(await wake("2026-11-30T23:59:00.000Z")).toBe(0);
      // On 1 December, as its card says, it goes on.
      expect(await wake("2026-12-01T00:00:00.000Z")).toBe(1);
      expect((await rt.store.task.mustGet(r.taskId)).status).toBe("ready");
      expect((await cardOf(r.taskId)).map((q) => [q.status, q.outcome])).toEqual([
        ["withdrawn", '"Members table" goes on: its limit has room again.'],
      ]);
      // It is left ready, with no session asked for: nothing runs on for the next test.
      await rt.store.task.transition(
        r.taskId,
        (await rt.store.task.mustGet(r.taskId)).version,
        "cancelled",
        "test done",
        { agentId: rt.agent.id },
      );
    } finally {
      await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: 0 });
    }
  }, 120_000);
});

/**
 * The leftovers of wave 7 (R-criticbudget, ADR 0112 point 6): a task whose run fit the project's
 * budget but whose review did not. Before, the critic made the refused review an "escalate"
 * verdict ("Critic review did not complete (budget_exceeded)"): the retry ladder ran the coder
 * again three more times, each review refused the same way, and filed '"Review page" failed 4
 * times' with Try again / Mark done anyway / Cancel task. A review a limit refused is no verdict
 * and no failed try: the task pauses at the project's budget with that limit's one card, and
 * goes on once the person raises the budget, where the critic reviews it once.
 */
describe("a review refused at the project's budget pauses the task (leftovers of wave 7)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-budget-review-"));
  const calls: ModelRequest[] = [];
  const fake = provider(clock, calls);
  let rt: RuntimeApp;
  let req: Req;

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const cardsOf = async (taskId: string) =>
    ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.filter(
      (q) => q.taskId === taskId,
    );

  it("no verdict and no failed try: paused at the project's budget with one card; raising the budget reviews it once", async () => {
    // A project's budget of USD 0.01 (CHF 0.01): the coder's one call fits, the critic's first
    // call's worst case does not.
    const r = await runOne(req, rt, "Review page", {
      budgetUsdMicro: 2_000_000,
      projectBudgetUsdMicro: 10_000,
    });
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status).toBe("needs_human");
    expect(task.attempt).toBe(0);
    expect(r.view.display).toMatchObject({
      label: "Paused at the project's budget",
      blocker: { kind: "card", cardKind: "budget" },
    });
    // The coder ran once; the critic's run was refused before its verdict: no review, no
    // finding, no retry.
    expect(r.runs.map((x) => x.outcome)).toEqual(["completed"]);
    const reviews = (await rt.store.run.forTask(r.taskId)).filter((x) => x.specialist === "critic");
    expect(reviews.map((x) => x.outcome)).toEqual(["budget_exceeded"]);
    expect(await rt.store.review.latestForTask(r.taskId)).toBeUndefined();
    expect(await rt.store.finding.openFor(r.taskId)).toEqual([]);
    // One card, the project's budget's: Cancel task and Open Settings; no "failed 4 times".
    const cards = await cardsOf(r.taskId);
    expect(cards.map((q) => [q.title, q.status])).toEqual([
      ['"Review page" paused at the project\'s budget of CHF 0.01', "open"],
    ]);
    // leftovers7-tailrun, wave 13 (TR-14): the coder finished; only the review waits. Before:
    // "It stopped before it could say where it stood; its work so far is kept."
    expect(String(cards[0]?.body)).toMatch(
      /^The work is done; its review waits for room in the budget\./,
    );
    expect(String(cards[0]?.body)).not.toContain("It stopped before it could say where it stood");
    expect(((cards[0]?.choices ?? []) as Json[]).map((c) => c.label)).toEqual(["Cancel task"]);
    expect(((cards[0]?.links ?? []) as Json[]).map((l) => l.label)).toEqual(["Open Settings"]);
    // The session log says the review paused, never that the critic sent it back.
    const said = lines(r.events);
    expect(said).toContain(
      '"Review page" paused before its review: the project\'s budget of CHF 0.01 has no room for it.',
    );
    expect(said.join(" | ")).not.toMatch(
      /sent "Review page" back|failed \d times|did not complete/,
    );
    // The project's budget ended the session there (ADR 0112 point 6).
    expect(r.session.status).toBe("stopped");
    expect(r.session.statusText).toBe("Stopped at the project's budget");

    // The person raises the project's budget in Settings: the next tick goes on with it, and the
    // critic reviews it once.
    const set = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          { name: "budget.set", params: { scope: "project", amountChf: 5, project: r.projectId } },
        ],
        wordsUsed: "Settings: Project budget to 5",
        source: "ui",
        projectId: r.projectId,
      }),
    });
    let result = (await set.json()) as Json;
    if (result.status === "pending")
      result = (await (
        await req(`/commands/${String(result.pendingId)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "tap" }),
        })
      ).json()) as Json;
    expect(result.status, JSON.stringify(result)).toBe("done");
    await rt.scheduler.tick();
    const sessions = async () => rt.store.session.forProject(r.projectId);
    await waitFor(
      async () => {
        const t = await rt.store.task.mustGet(r.taskId);
        const all = await sessions();
        return t.status === "done" &&
          all.every((s) => ["completed", "stopped", "failed", "killed"].includes(s.status))
          ? true
          : undefined;
      },
      async () =>
        `"Review page" to be done and its sessions to end (${(await rt.store.task.mustGet(r.taskId)).status}, ${(await sessions()).map((s) => s.status).join(", ")})`,
    );
    expect((await sessions()).length).toBe(2);
    const after = (await rt.store.run.forTask(r.taskId)).filter((x) => x.specialist === "critic");
    // (Both rows carry the simulated clock's one moment: their order is not the run order.)
    expect(after.map((x) => x.outcome).sort()).toEqual(["budget_exceeded", "completed"]);
    expect((await rt.store.review.latestForTask(r.taskId))?.verdict).toBe("accept");
    expect((await rt.store.task.mustGet(r.taskId)).attempt).toBe(0);
    expect((await cardsOf(r.taskId)).map((q) => q.status)).toEqual(["withdrawn"]);
  }, 120_000);
});

/**
 * w15-run, wave 15 (W15-13, live check 2's RUN-1): through the composed runtime on an API key (the
 * Messages API stand-in, so the runtime prices Sonnet 5.5 as it does live), a CHF 0.20 coder task
 * whose four files need more than the usual 4,096-token cap. Before, the write call kept the flat
 * write room of a tenth of the budget (the 4,096 floor), the reply was cut, every write in it was
 * thrown away, and the retry at 16,384 tokens passed the run's line: the coder heard "about a
 * fifth of this task's budget is left" after spending CHF 0.05, wrote nothing and paused.
 */
describe("w15-run, wave 15: a coder's multi-file write is paid from below its line and the task is done (W15-13)", () => {
  const KEY = ["sk-ant-api03-", "w15-run-", "7".repeat(40)].join(""); // not-a-secret
  const TITLE = "Write the Swiss pairing tool with tests";
  const FILES = ["src/elo.js", "src/swiss.js", "test/elo.test.js", "test/swiss.test.js"];
  const clock = new SimulatedClock("2026-11-09T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-w15-run-write-"));
  const isCoder = (r: ModelRequest) =>
    (r.system ?? "").includes("You are the coder specialist") &&
    JSON.stringify(r.messages).includes(TITLE);
  const heard = (r: ModelRequest) => JSON.stringify(r.messages).includes(WRAP_UP_MARK);
  const writes = FILES.map((path) => ({
    name: "write_file",
    input: { path, content: `// ${path}\n${"export const x = 1;\n".repeat(20)}` },
  }));
  const model = new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      // What the live model did once told to wrap up: start nothing new, list the files left.
      textReply(
        "Read the project.\n\nWhere I stopped: nothing is written yet.\n\nLeft to do:\n- write src/elo.js\n- write src/swiss.js\n- write the tests",
        { when: (r: ModelRequest) => isCoder(r) && heard(r), times: Number.POSITIVE_INFINITY },
      ),
      toolReply("list_dir", { path: "." }, "Looking at the project first.", {
        when: (r: ModelRequest) =>
          isCoder(r) && !JSON.stringify(r.messages).includes("tool_result"),
      }),
      // The four files need about 6,000 output tokens: below that the reply is cut in the fourth.
      {
        when: (r: ModelRequest) => isCoder(r) && r.max_tokens < 6_000,
        reply: { toolCalls: writes, stopReason: "max_tokens", usage: { output_tokens: 4_096 } },
        times: Number.POSITIVE_INFINITY,
      },
      {
        when: (r: ModelRequest) => isCoder(r) && !JSON.stringify(r.messages).includes("wrote "),
        reply: { toolCalls: writes, usage: { output_tokens: 6_000 } },
        times: Number.POSITIVE_INFINITY,
      },
      textReply(
        "Wrote the pairing tool and its tests.\n\nWhere I stopped: every file is written.\n\nLeft to do: nothing",
        { when: isCoder, times: Number.POSITIVE_INFINITY },
      ),
    ],
  });
  const seen: ModelRequest[] = [];
  const stream = model.stream.bind(model);
  model.stream = (r) => {
    seen.push({ ...r, messages: structuredClone(r.messages) });
    return stream(r);
  };
  const standIn = messagesApiStandIn({ model, clock });
  let rt: RuntimeApp;
  let req: Req;

  beforeAll(async () => {
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault({ [SECRET_NAMES.anthropic]: KEY }),
      fetchImpl: standInFetch(standIn, {
        fallback: async () => new Response("not here", { status: 404 }),
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
    const { app, token } = createDaemonApp(rt);
    req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("CHF 0.20: the four files are written in one call, no wrap-up comes before them, and the task is reviewed and done", async () => {
    const r = await runOne(req, rt, TITLE, { budgetUsdMicro: 250_000 });
    const coder = seen.filter(isCoder);
    // The write call asked enough for the four files; no request carried the wrap-up.
    expect(coder.length).toBeGreaterThanOrEqual(3);
    expect(coder[1]?.max_tokens).toBeGreaterThanOrEqual(6_000);
    expect(coder.some((b) => JSON.stringify(b.messages).includes(WRAP_UP_MARK))).toBe(false);
    // Done and reviewed, its files written; never "paused before its budget".
    const task = await rt.store.task.mustGet(r.taskId);
    expect(task.status, lines(r.events).join(" | ")).toBe("done");
    expect(await rt.store.review.latestForTask(r.taskId)).toBeDefined();
    expect(r.runs.map((x) => x.outcome)).toEqual(["completed"]);
    expect(lines(r.events).join(" | ")).not.toMatch(
      /paused before its budget|Told the coder to wrap up/,
    );
    // The drawer lists the four files the run wrote.
    const detail = JSON.stringify(await (await req(`/tasks/${r.taskId}`)).json());
    for (const f of FILES) expect(detail).toContain(f);
  }, 120_000);
});

/**
 * w15-run, wave 15 (W15-14, live check 2's F4): a run that heard the wrap-up and listed only
 * "Nothing for the acceptance criteria." and an optional extra was paused at its budget with its
 * work done and no review: `parseHandoff` counted both lines as work left. The live report (the
 * researcher's task.finished of session 01a1be9f, word for word) is the fixture.
 */
const LIVE_F4_REPORT = [
  'I wrote `popover-hint.md` with three MDN pages that mention `popover="hint"`. Each has its link and one sentence on what it says. I did not run any build, lint or test command.',
  "",
  "**How I found them:** I used MDN's own search endpoint, `https://developer.mozilla.org/api/v1/search?q=popover%20hint&locale=en-US`. I had no separate web_search tool. I then opened each listed page with web_fetch.",
  "",
  "**`answer.md` left unchanged:** It already holds the finished report for a different task, the MDN CSS 2026 one. Overwriting it would have destroyed that result, so I put the evidence in this message instead. `popover-hint.md` is the deliverable the brief names.",
  "",
  "Where I stopped: `popover-hint.md` is written and complete with three opened and cited pages. Nothing is half-done.",
  "",
  "Left to do:",
  "- Nothing for the acceptance criteria.",
  "- Optionally, add a `popover-hint` section to a fresh `answer.md` once the existing one is archived or moved.",
  "",
  "Lesson: When the task directory's `answer.md` belongs to an earlier task, don't overwrite it. Put the report in the final message and say so.",
].join("\n");

describe("w15-run, wave 15: 'Left to do' counts only what the criteria still need (W15-14)", () => {
  it("the live report: nothing left, the optional extra kept apart as a note", () => {
    const h = parseHandoff(LIVE_F4_REPORT);
    expect(h.leftToDo).toEqual([]);
    expect(h.optional).toEqual([
      "Optionally, add a `popover-hint` section to a fresh `answer.md` once the existing one is archived or moved.",
    ]);
    expect(h.stopped).toBe(
      "`popover-hint.md` is written and complete with three opened and cited pages. Nothing is half-done.",
    );
  });

  it("nothing with what it is about is nothing; work stays work, also when it starts with 'none' or 'nothing'", () => {
    const left = (lines: string[]) =>
      parseHandoff(["Where I stopped: here.", "", "Left to do:", ...lines].join("\n"));
    expect(left(["- None required by the criteria."]).leftToDo).toEqual([]);
    expect(left(["- Nothing left for the criteria"]).leftToDo).toEqual([]);
    expect(left(["- Nothing: all criteria are met."]).leftToDo).toEqual([]);
    expect(parseHandoff("Left to do: nothing for this task.").leftToDo).toEqual([]);
    expect(left(["- Nothing works yet: fix the build"]).leftToDo).toEqual([
      "Nothing works yet: fix the build",
    ]);
    expect(left(["- None of the tests pass"]).leftToDo).toEqual(["None of the tests pass"]);
    expect(left(["- write the last section", "- (optional) add a print style"])).toMatchObject({
      leftToDo: ["write the last section"],
      optional: ["(optional) add a print style"],
    });
    expect(left(["- Nice to have: a dark theme", "- check the links"])).toMatchObject({
      leftToDo: ["check the links"],
      optional: ["Nice to have: a dark theme"],
    });
  });

  it("a 'nothing' that goes on to name work, and a hedged item, stay work left (review of W15-14)", () => {
    const left = (lines: string[]) =>
      parseHandoff(["Where I stopped: here.", "", "Left to do:", ...lines].join("\n"));
    // Before: 'complete' inside 'incomplete' and 'task' with anything after it read as nothing.
    for (const line of [
      "Nothing - but the README is incomplete",
      "Nothing in the task works yet",
      "Nothing: the criteria are not met yet",
      "Nothing for the criteria, except the tests still fail",
      "None for the task; the parser is missing",
    ])
      expect(left([`- ${line}`]).leftToDo, line).toEqual([line]);
    // Before: filed as optional extras.
    for (const line of [
      "Perhaps the most important: finish the parser",
      "Maybe fix the failing build",
    ])
      expect(left([`- ${line}`]), line).toEqual({ stopped: "here.", leftToDo: [line] });
    // What reads as nothing still does.
    for (const line of [
      "Nothing for the task's acceptance criteria.",
      "Nothing within the scope of the brief",
      "Nothing left: the task is complete.",
      "None; every criterion is met",
    ])
      expect(left([`- ${line}`]).leftToDo, line).toEqual([]);
  });

  it("the wrap-up the model hears and the brief's line ask for what the criteria still need, or nothing", () => {
    expect(wrapUpText(10_000, 100_000)).toContain(
      "Left to do: (only what the task's criteria still need, as a list, or nothing; no optional extras).",
    );
    expect(WRAP_UP_BRIEF_LINE).toContain(
      "'Left to do:' (only what the task's criteria still need, as a list, or 'nothing'; no optional extras)",
    );
  });

  describe("through the composed runtime", () => {
    const clock = new SimulatedClock("2026-11-09T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-w15-run-left-"));
    const calls: ModelRequest[] = [];
    const fake = new FakeProvider({
      clock,
      latency: "none",
      onNoMatch: "echo",
      replies: [
        submitReply({}, { times: Number.POSITIVE_INFINITY }),
        closingReply(),
        ...works("Popover notes", 30_000, LIVE_F4_REPORT),
      ],
    });
    const stream = fake.stream.bind(fake);
    fake.stream = (r) => {
      calls.push({ ...r, messages: structuredClone(r.messages) });
      return stream(r);
    };
    let rt: RuntimeApp;
    let req: Req;
    beforeAll(async () => {
      ({ rt, req } = await compose(home, clock, fake));
    }, 120_000);
    afterAll(async () => {
      await rt?.close();
    });

    it("a run that hears the wrap-up and lists only 'Nothing for the acceptance criteria.' and an optional extra is reviewed and done, with no budget card", async () => {
      const r = await runOne(req, rt, "Popover notes", { budgetUsdMicro: 300_000 });
      const mine = calls.filter(coderOn("Popover notes"));
      const told = mine.find(heardWrapUp);
      expect(told).toBeDefined();
      // The request the model received asked for what the criteria still need, or nothing.
      expect(JSON.stringify(told?.messages.at(-1))).toContain(
        "only what the task's criteria still need, as a list, or nothing; no optional extras",
      );
      // Reviewed and done; never paused at its budget.
      const task = await rt.store.task.mustGet(r.taskId);
      expect(task.status).toBe("done");
      expect(await rt.store.review.latestForTask(r.taskId)).toBeDefined();
      expect(r.runs.map((x) => x.outcome)).toEqual(["completed"]);
      expect(lines(r.events).join(" | ")).not.toMatch(/paused before its budget/);
      const cards = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.filter(
        (q) => q.taskId === r.taskId,
      );
      expect(cards).toEqual([]);
    }, 60_000);
  });
});

/**
 * w15-run, wave 15 (W15-16, live check 2's F4 and RUN-1): the wrap-up's words were not true. The
 * log said "at CHF 0.07 it is told to wrap up" and the run was told at CHF 0.02 (the wrap-up comes
 * before the step whose worst case could pass the line); the model heard "About a fifth of this
 * task's budget is left" with 87% left; and an amount under a centime read "CHF 0.00".
 */
describe("w15-run, wave 15: the wrap-up's words say what is true (W15-16)", () => {
  const line = {
    capUsdMicro: 187_500,
    reserveUsdMicro: 100_000,
    lineUsdMicro: 87_500,
    firstCallUsdMicro: 50_000,
    saveOnly: false,
  };
  const chf = (usdMicro: number) => `CHF ${((usdMicro * 0.8) / 1_000_000).toFixed(2)}`;

  it("the start line names the real trigger, and the told line agrees with it", () => {
    expect(budgetLineWords(line, chf)).toBe(
      "This run may spend CHF 0.15: before a step that could take it past CHF 0.07 it is told to wrap up, keeping a reserve of CHF 0.08 to finish.",
    );
    expect(wrapUpSentWords("researcher", 29_045, 187_500, line, chf)).toBe(
      "Told the researcher to wrap up: it spent CHF 0.02 of CHF 0.15, and its next step could take it past CHF 0.07.",
    );
  });

  it("the model hears the share it really used, not 'about a fifth is left'", () => {
    expect(wrapUpText(29_045, 187_500)).toBe(
      "Wrap up now: this task has used 15% of its budget, and its next step could take it past the share kept to finish. Start nothing new, leave the files working, and end your report with Where I stopped: and Left to do: (only what the task's criteria still need, as a list, or nothing; no optional extras).",
    );
    expect(wrapUpText(1_000, 300_000)).toMatch(
      /^Wrap up now: this task has used under 1% of its budget,/,
    );
    expect(wrapUpText(29_045, 187_500)).not.toMatch(/a fifth/);
  });

  it("amounts under a centime read 'less than CHF 0.01', never 'CHF 0.00'", () => {
    expect(limitWords("task_budget", 4_000, chf, "coder")).toBe("its budget of less than CHF 0.01");
    expect(wrapUpSentWords("coder", 3_000, 6_000, { ...line, lineUsdMicro: 4_000 }, chf)).toBe(
      "Told the coder to wrap up: it spent less than CHF 0.01 of less than CHF 0.01, and its next step could take it past less than CHF 0.01.",
    );
    expect(
      pauseSentence(
        { stopped: "", leftToDo: [], stoppedBy: "budget" },
        limitWords("task_budget", 4_000, chf, "coder"),
        3_000,
        4_000,
        chf,
      ),
    ).toBe(
      "The run stopped at its budget of less than CHF 0.01: it spent less than CHF 0.01, and its next step would have gone over.",
    );
  });
});
