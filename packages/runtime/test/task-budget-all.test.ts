import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  FakeProvider,
  messagesApiStandIn,
  type ScriptedReply,
  standInFetch,
  textReply,
  toolReply,
} from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { composeRuntime } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ModelRequest } from "../src/provider/types.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { pricingFor } from "../src/wiring/billing-ports.ts";
import { removeHomes, settleSessions } from "./helpers.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * d1116-budget-all (the owner's answer of 2026-11-16 to run L3's question, verbatim: "yes it
 * should count critics reviews, and fixes."): a task's budget counts everything spent on the
 * task, its work, the critic's reviews of it and the fixes after a review, as one figure.
 *
 * Through the composed runtime on an API key: the Messages API stand-in, so the runtime prices
 * every call as Sonnet 5.5 (USD 2 / 10 per million tokens) and the critic's calls are prechecked
 * as they are live (budget-pause.test.ts' W15-13 harness). The model behind it is a script.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const KEY = ["sk-ant-api03-", "d1116-budget-", "8".repeat(40)].join(""); // not-a-secret
type Json = Record<string, unknown>;

const text = (r: ModelRequest) => JSON.stringify(r.messages);
const isCritic = (r: ModelRequest) => (r.tools ?? []).some((t) => t.name === "submit_review");
const isCoderOn = (title: string) => (r: ModelRequest) =>
  !isCritic(r) &&
  (r.system ?? "").includes("You are the coder specialist") &&
  text(r).includes(title);
const firstCall = (r: ModelRequest) => !text(r).includes("tool_result");

type Billed = { input_tokens: number; output_tokens: number };

/**
 * The coder on `title` writes `file` in its first call, then says it is done. `billed`: what each
 * of its two calls bills (Sonnet 5.5: 2 micro-USD an input token, 10 an output token), so a test
 * knows to the micro-USD what the work cost; the precheck still counts the request as sent.
 */
function codes(title: string, file: string, billed?: [Billed, Billed]): ScriptedReply[] {
  return [
    toolReply("write_file", { path: file, content: `<p>${title}</p>\n` }, "Writing the page.", {
      when: (r: ModelRequest) => isCoderOn(title)(r) && firstCall(r),
      times: Number.POSITIVE_INFINITY,
      ...(billed ? { usage: billed[0] } : {}),
    }),
    textReply(`Wrote ${file}.\n\nWhere I stopped: ${file} is written.\n\nLeft to do: nothing`, {
      when: isCoderOn(title),
      times: Number.POSITIVE_INFINITY,
      ...(billed ? { usage: billed[1] } : {}),
    }),
  ];
}

/** The critic's first review of `title` sends it back; every later one accepts. */
function sendsBackOnce(title: string): ScriptedReply[] {
  return [
    submitReply(
      {
        grade: 40,
        verdict: "revise",
        summary: "The page does not name the club.",
        findings: [
          {
            severity: "major",
            what: "The page does not name the club.",
            where: "index.html",
            required_action: "Name the club on the page.",
          },
        ] as never,
      },
      { when: (r: ModelRequest) => isCritic(r) && firstCall(r) && text(r).includes(title) },
    ),
  ];
}

interface Gate {
  /** Resolves when a held call arrived. */
  reached: Promise<void>;
  release: () => void;
}

function gate(): Gate & { arrive: () => void; wait: Promise<void> } {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((r) => {
    arrive = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { reached, release, arrive, wait };
}

/**
 * A composed runtime on `home` whose Anthropic API is the stand-in over `model`. `holdCritic(n)`
 * holds the n-th critic call (1-based) before it is answered, until released.
 */
function world(replies: ScriptedReply[]) {
  const clock = new SimulatedClock("2026-11-16T09:00:00Z");
  const model = new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [closingReply(), ...replies, submitReply({}, { times: Number.POSITIVE_INFINITY })],
  });
  const seen: ModelRequest[] = [];
  const holds = new Map<number, ReturnType<typeof gate> & { cutOff?: number }>();
  let criticCalls = 0;
  const stream = model.stream.bind(model);
  model.stream = (r) => {
    seen.push({ ...r, messages: structuredClone(r.messages) });
    if (!isCritic(r)) return stream(r);
    criticCalls += 1;
    const held = holds.get(criticCalls);
    if (!held) return stream(r);
    const cutOff = held.cutOff;
    if (cutOff !== undefined)
      // As the Messages API does: the input side of the bill on message_start, then nothing
      // until the call is stopped (L3-run-5's held call).
      return (async function* () {
        yield {
          type: "message_start" as const,
          model: r.model,
          usage: {
            input_tokens: cutOff,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
        held.arrive();
        await Promise.race([
          held.wait,
          new Promise<void>((resolve) => {
            if (r.signal?.aborted) resolve();
            else r.signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        yield { type: "error" as const, code: "aborted", message: "aborted", retryable: false };
      })();
    return (async function* () {
      held.arrive();
      await held.wait;
      yield* stream(r);
    })();
  };
  /** Hold the n-th critic call; `cutOffInputTokens`: it bills that input, then waits for a stop. */
  const holdCritic = (n: number, cutOffInputTokens?: number): Gate => {
    const g = gate();
    holds.set(n, {
      ...g,
      ...(cutOffInputTokens !== undefined ? { cutOff: cutOffInputTokens } : {}),
    });
    return g;
  };
  const standIn = messagesApiStandIn({ model, clock });
  /**
   * `services`: the daemon's services run (the scheduler a Continue starts its session on).
   * `everyTier`: the composition's test-only pin of the process sandbox for every risk tier, so
   * a tier 2 or 3 task runs and is reviewed here without a container engine.
   */
  const open = async (home: string, opts: { services?: boolean; everyTier?: boolean } = {}) => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
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
      startServices: opts.services === true,
      ...(opts.everyTier ? { sandboxProcessForEveryTier: true } : {}),
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
  };
  return { clock, model, seen, holdCritic, open, criticCalls: () => criticCalls };
}
type Opened = Awaited<ReturnType<ReturnType<typeof world>["open"]>>;

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

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A project with one coder task (what New task sends); returns their ids. */
async function projectWithTask(
  w: Opened,
  title: string,
  opts: { budgetUsdMicro?: number; riskTier?: number; file?: string } = {},
): Promise<{ projectId: string; taskId: string }> {
  const projectId = String(
    (await w.json("/projects", post({ name: `${title} project`, goal: "A club site" }))).id,
  );
  const task = await w.json(
    `/projects/${projectId}/tasks`,
    post({
      title,
      outcome: `${opts.file ?? "index.html"} is written`,
      acceptanceCriteria: [`${opts.file ?? "index.html"} exists`],
      priority: "high",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: opts.budgetUsdMicro ?? 0,
      specialist: "coder",
      riskTier: opts.riskTier ?? 1,
    }),
  );
  return { projectId, taskId: String(task.id) };
}

/** One more coder task in `projectId`, ready. */
async function addTask(
  w: Opened,
  projectId: string,
  title: string,
  opts: { budgetUsdMicro?: number; file?: string; priority?: string } = {},
): Promise<string> {
  const task = await w.json(
    `/projects/${projectId}/tasks`,
    post({
      title,
      outcome: `${opts.file ?? "page.html"} is written`,
      acceptanceCriteria: [`${opts.file ?? "page.html"} exists`],
      priority: opts.priority ?? "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: opts.budgetUsdMicro ?? 0,
      specialist: "coder",
      riskTier: 1,
    }),
  );
  return String(task.id);
}

/** The task's open cards in the Inbox, as the Inbox reads them. */
async function cardsOf(w: Opened, taskId: string): Promise<Json[]> {
  const inbox = await w.json("/inbox");
  return ((inbox.requests as Json[]) ?? []).filter(
    (r) => r.taskId === taskId && r.status === "open",
  );
}

/**
 * l4-selftasks-101: the review's floor for `taskId` (its first call's whole price at the smallest
 * output), and the budget that leaves `below` less than it after the work's `workUsdMicro`.
 */
async function budgetBelowFloor(
  w: Opened,
  taskId: string,
  workUsdMicro: number,
  below: number,
): Promise<{ floor: number; budget: number }> {
  const price = await w.rt.critic?.reviewCallUsdMicro?.(
    await w.rt.store.task.mustGet(taskId),
    "coder",
  );
  const floor = price?.floorUsdMicro ?? 0;
  const budget = workUsdMicro + floor - below;
  await w.rt.store.task.patch(taskId, { budget_usd_micro: budget } as never);
  return { floor, budget };
}
const chfOf = (usd: number) => `CHF ${((usd * 0.8) / 1e6).toFixed(2)}`;

/** The session's log lines. */
async function linesOf(w: Opened, sessionId: string): Promise<string[]> {
  const events = (await w.json(`/sessions/${sessionId}/events`)) as unknown as Json[];
  return events.map((e) => String(e.text ?? ""));
}

/** Start a session as the Start dialog does; returns its id. */
async function start(w: Opened, projectId: string): Promise<string> {
  const res = await w.req(
    "/sessions",
    post({ agentId: w.rt.agent.id, projectId, trigger: "manual" }),
  );
  const body = (await res.json()) as Json;
  expect(res.status, JSON.stringify(body)).toBe(202);
  return String((body.session as Json).id);
}

async function ended(w: Opened, sessionId: string): Promise<Json> {
  return waitFor(
    async () => {
      const s = await w.json(`/sessions/${sessionId}`);
      return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
        ? s
        : undefined;
    },
    async () =>
      `session ${sessionId} to end (${String((await w.json(`/sessions/${sessionId}`)).status)})`,
  );
}

const sumRuns = (runs: { cost_usd_micro: number }[]) =>
  runs.reduce((s, r) => s + r.cost_usd_micro, 0);

describe("d1116-budget-all", () => {
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), "fr-budget-all-"));
    homes.push(h);
    return h;
  };

  it("BA-1: a task the critic sends back once counts its two work runs and both reviews as one figure, the ledger's, on the row and on Costs", async () => {
    const TITLE = "Write the club page";
    const w = world([...sendsBackOnce(TITLE), ...codes(TITLE, "index.html")]);
    // The first review's two calls (its verdict, then its closing call) are held in turn.
    const first = w.holdCritic(1);
    const second = w.holdCritic(2);
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, { budgetUsdMicro: 2_000_000 });
      const sessionId = await start(o, projectId);
      await first.reached;
      const atReview = await o.rt.store.task.mustGet(taskId);
      expect(atReview.status).toBe("in_review");
      // The work run is on the task when its review starts.
      const work1 = (await o.rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
      expect(atReview.actual_cost_usd_micro).toBe(sumRuns(work1));
      first.release();
      await second.reached;
      // The review's first call is on the task while the review goes on; the version is the same.
      const midReview = await o.rt.store.task.mustGet(taskId);
      const criticSoFar = (await o.rt.store.costLedger.sum({ taskId })).usd_micro - sumRuns(work1);
      expect(criticSoFar).toBeGreaterThan(0);
      expect(midReview.actual_cost_usd_micro).toBe(atReview.actual_cost_usd_micro + criticSoFar);
      expect(midReview.version).toBe(atReview.version);
      second.release();
      const s = await ended(o, sessionId);
      expect(s.status).toBe("completed");
      await settleSessions(o.rt);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.status).toBe("done");
      const runs = await o.rt.store.run.forTask(taskId);
      // Two work runs and two reviews: sent back once, then accepted.
      expect(runs.filter((r) => r.specialist === "critic")).toHaveLength(2);
      expect(runs.filter((r) => r.specialist !== "critic")).toHaveLength(2);
      const ledger = (await o.rt.store.costLedger.sum({ taskId })).usd_micro;
      expect(task.actual_cost_usd_micro).toBe(ledger);
      expect(task.actual_cost_usd_micro).toBe(sumRuns(runs));
      // The Tasks row and Costs > By task show that one figure.
      const row = ((await o.json(`/projects/${projectId}/tasks`)) as unknown as Json[]).find(
        (t) => t.id === taskId,
      ) as Json;
      expect((row.actual as Json).usdMicro).toBe(ledger);
      expect((row.spent as Json).usdMicro).toBe(ledger);
      const costs = await o.json(`/costs?projectId=${projectId}`);
      const byTask = (costs.byTask as Json[]).find((b) => b.key === taskId) as Json;
      expect((byTask.cost as Json).usdMicro).toBe(ledger);
    } finally {
      first.release();
      second.release();
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-1: a review Stop now cuts off has its cut-off call in the task's figure, the ledger's", async () => {
    const TITLE = "Write the opening hours page";
    const w = world(codes(TITLE, "hours.html"));
    // The review's first call bills 20,000 input tokens on message_start, then is stopped.
    const held = w.holdCritic(1, 20_000);
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 2_000_000,
        file: "hours.html",
      });
      const sessionId = await start(o, projectId);
      await held.reached;
      const work = await o.rt.store.task.mustGet(taskId);
      expect(work.status).toBe("in_review");
      // Stop now, as the session page sends it.
      await o.json(`/sessions/${sessionId}/stop`, { method: "POST" });
      await ended(o, sessionId);
      await settleSessions(o.rt);
      const runs = await o.rt.store.run.forTask(taskId);
      const review = runs.find((r) => r.specialist === "critic");
      // The cut-off call is billed: 20,000 input tokens on Sonnet 5.5 is USD 0.04.
      expect(review?.cost_usd_micro).toBe(40_000);
      const task = await o.rt.store.task.mustGet(taskId);
      const ledger = (await o.rt.store.costLedger.sum({ taskId })).usd_micro;
      expect(task.actual_cost_usd_micro).toBe(ledger);
      expect(task.actual_cost_usd_micro).toBe(work.actual_cost_usd_micro + 40_000);
    } finally {
      held.release();
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-2: a task written before, whose figure held its work only, counts its review after the upgrade, across restarts, and pauses before its next run at its budget with one card", async () => {
    const TITLE = "Write the members page";
    const w = world(codes(TITLE, "members.html"));
    const h = home();
    let o = await w.open(h);
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 400_000,
        file: "members.html",
      });
      // As a v9 install left it: the work (300_000) on the task, the work and its review
      // (150_000) on the ledger under its task id; migration 10 not applied yet.
      const row = { humanId: o.rt.human.id, projectId, taskId, kind: "api" as const };
      const book = (usdMicro: number, specialist: string) =>
        o.rt.store.costLedger.record({
          human_id: row.humanId,
          agent_id: o.rt.agent.id,
          project_id: projectId,
          session_id: null,
          task_id: taskId,
          run_id: null,
          billing_source_id: null,
          kind: "api",
          usd_micro: usdMicro,
          chf_micro: 0,
          rate_chf_per_usd: 0,
          plan_usage_share: null,
          model: "claude-sonnet-5-5",
          specialist,
          tokens_in: 0,
          tokens_out: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        } as never);
      await book(300_000, "coder");
      await book(150_000, "critic");
      await o.rt.store.db.query(`UPDATE "task" SET "actual_cost_usd_micro" = ? WHERE "id" = ?`, [
        300_000,
        taskId,
      ]);
      await o.rt.store.db.query(`DELETE FROM "schema_migrations" WHERE "version" = ?`, [10]);
      const before = await o.rt.store.task.mustGet(taskId);
      expect(before.actual_cost_usd_micro).toBe(300_000);
      await o.rt.close();
      // The upgrade: composing the runtime applies migration 10.
      o = await w.open(h);
      expect(o.rt.store.migration?.applied).toEqual([10]);
      const upgraded = await o.rt.store.task.mustGet(taskId);
      expect(upgraded.actual_cost_usd_micro).toBe(450_000);
      expect(upgraded.version).toBe(before.version);
      expect(upgraded.updated_at).toBe(before.updated_at);
      await o.rt.close();
      // Composed again: the figure stays.
      o = await w.open(h);
      expect(o.rt.store.migration?.applied).toEqual([]);
      expect((await o.rt.store.task.mustGet(taskId)).actual_cost_usd_micro).toBe(450_000);
      // Its next run pauses before it starts: its budget of CHF 0.32 is spent.
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      const paused = await o.rt.store.task.mustGet(taskId);
      expect(paused.status).toBe("needs_human");
      expect(
        (await o.rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic"),
      ).toEqual([]);
      const events = (await o.json(`/sessions/${sessionId}/events`)) as unknown as Json[];
      const finished = events.find((e) => e.type === "task.finished");
      expect(finished?.text).toBe('"Write the members page" paused at a budget.');
      expect((finished?.payload as Json | undefined)?.summary).toBe(
        "Its budget of CHF 0.32 is spent (CHF 0.36 so far), so nothing ran.",
      );
      const inbox = (await o.json("/inbox")) as Json;
      const cards = ((inbox.requests as Json[]) ?? []).filter((r) => r.taskId === taskId);
      expect(cards).toHaveLength(1);
      expect((cards[0]?.options as string[]) ?? []).toEqual([
        expect.stringMatching(/^Continue \(CHF \d+\.\d{2} more\)$/),
        "Cancel task",
      ]);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-3: a review its task's budget cannot pay a first call for is not started: the task pauses at its budget with its work kept and one card, and the session goes on with the next task", async () => {
    const FOOTER = "Write the footer";
    const HEADER = "Write the header";
    // The footer's work bills USD 0.01 (two calls of 1,000 tokens in and 300 out); its budget
    // leaves 1,000 less than the review's floor after it: the first call's whole price at its
    // smallest output (l4-selftasks-101: 2,048 tokens out plus the critic's prompt and a typical
    // task's evidence in; before, the floor was 8,192 tokens out alone and the budget USD 0.075).
    const w = world([
      ...codes(FOOTER, "footer.html", [
        { input_tokens: 1_000, output_tokens: 300 },
        { input_tokens: 1_000, output_tokens: 300 },
      ]),
      ...codes(HEADER, "header.html"),
    ]);
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, FOOTER, {
        budgetUsdMicro: 75_000,
        file: "footer.html",
      });
      const header = await addTask(o, projectId, HEADER, { file: "header.html" });
      const { budget } = await budgetBelowFloor(o, taskId, 10_000, 1_000);
      const sessionId = await start(o, projectId);
      const s = await ended(o, sessionId);
      await settleSessions(o.rt);
      const runs = await o.rt.store.run.forTask(taskId);
      // No critic Run row: the review never started, and nothing was spent on it.
      expect(runs.filter((r) => r.specialist === "critic")).toEqual([]);
      const work = runs.filter((r) => r.specialist !== "critic");
      expect(work.map((r) => r.outcome)).toEqual(["completed"]);
      expect(sumRuns(work)).toBe(10_000);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.actual_cost_usd_micro).toBe(10_000);
      expect(task.status).toBe("needs_human");
      // l4-money-pause (L4-money-111, live check 4): the work is done and only its review waits
      // (before: '"Write the footer" paused at its budget of CHF 0.06.' beside "The work is done").
      expect(task.reason).toBe(
        '"Write the footer" is done; its review waits for room in its budget.',
      );
      const lines = await linesOf(o, sessionId);
      expect(lines).toContain(
        `"Write the footer" is done; its review waits for room in its budget of ${chfOf(budget)}.`,
      );
      expect(lines.join(" | ")).not.toMatch(/this session's budget/);
      const cards = await cardsOf(o, taskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.title).toBe(
        '"Write the footer" is done; its review waits for room in its budget',
      );
      expect(cards[0]?.body).toBe("The work is done; its review waits for room in the budget.");
      const paused = new RegExp(`paused at its budget of ${chfOf(budget).replace(".", "\\.")}`);
      expect(JSON.stringify(cards)).not.toMatch(paused);
      expect(cards[0]?.options).toEqual([
        expect.stringMatching(/^Continue \(CHF \d+\.\d{2} more\)$/),
        "Cancel task",
      ]);
      // C4b-left-6 (d1109-cred-screens): Continue says the next session runs only its review, and
      // the row says what the card says (before: "... goes on from where it stopped." and only
      // "Paused at its budget").
      const choices = (cards[0]?.choices ?? []) as { explain?: string }[];
      expect(choices[0]?.explain).toMatch(
        /^Adds CHF \d+\.\d{2} to its budget and starts a session that runs only its review\.$/,
      );
      const rows = (await o.json(`/projects/${projectId}/tasks`)) as unknown as Json[];
      const row = rows.find((t) => t.id === taskId) as { display?: { detail?: string } };
      expect(row?.display?.detail).toBe(
        "The work is done; its review waits for room in the budget.",
      );
      // L4-money-111: the row's label says the review waits (before: "Paused at its budget").
      expect((row?.display as { label?: string } | undefined)?.label).toBe(
        "Review waits for room in its budget",
      );
      // The session's result and the card's notification say it too.
      expect(String(s.summary)).toContain(
        `"Write the footer" is done; its review waits for room in its budget of ${chfOf(budget)}: continue or cancel it in the Inbox.`,
      );
      expect(String(s.summary)).not.toMatch(paused);
      const notes = (
        (await o.json("/notifications/recent?limit=200")) as unknown as { notifications: Json[] }
      ).notifications.filter((n) => n.kind === "request_blocking");
      expect(notes.map((n) => String(n.title)).join(" | ")).toContain("is done; its review");
      expect(notes.map((n) => `${n.title} ${n.body}`).join(" | ")).not.toMatch(paused);
      // The session went on: the next task ran and was reviewed.
      expect(s.status).toBe("completed");
      const next = await o.rt.store.task.mustGet(header);
      expect(next.status).toBe("done");
      expect(
        (await o.rt.store.run.forTask(header)).filter((r) => r.specialist === "critic"),
      ).toHaveLength(1);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  // l4-selftasks-101 (live check 4, LC-C30; D-L4-8 changes C4b's per-call floor): before, the
  // review's first call asked for 8,192 tokens out whatever was left, so 85,000 left was refused
  // by the precheck and the task paused; now each call is sized to the room and the review fits.
  it("BA-3: a review is capped at what is left of its task's budget: each call is sized to the room (2,048 to 8,192 tokens out), the review is made and the task never passes its budget", async () => {
    const TITLE = "Write the contact page";
    // The work bills USD 0.0525 of the budget of USD 0.1375 (CHF 0.11): 85,000 is left, below
    // the first call's worst case at 8,192 tokens out but above it at the room's size.
    const w = world(
      codes(TITLE, "contact.html", [
        { input_tokens: 2_000, output_tokens: 1_000 },
        { input_tokens: 4_750, output_tokens: 2_900 },
      ]),
    );
    const o = await w.open(home());
    const issued: { agentId: string; taskId?: string; budgetUsdMicro: number }[] = [];
    const issue = o.rt.tokens.issue.bind(o.rt.tokens);
    o.rt.tokens.issue = (claims) => {
      issued.push(claims);
      return issue(claims);
    };
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 137_500,
        file: "contact.html",
      });
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      // The critic's token for this task's review carries what was left: 85,000.
      const criticTokens = issued.filter(
        (c) => c.agentId === o.rt.criticAgent.id && c.taskId === taskId,
      );
      expect(criticTokens.map((c) => c.budgetUsdMicro)).toEqual([85_000]);
      // Its calls asked for what fits the room, never the whole 8,192 and never below 2,048.
      const calls = w.seen.filter((r) => isCritic(r) && text(r).includes(TITLE));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.max_tokens).toBeGreaterThanOrEqual(2_048);
        expect(c.max_tokens).toBeLessThan(8_192);
      }
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.status).toBe("done");
      expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(137_500);
      expect(task.actual_cost_usd_micro).toBe(
        (await o.rt.store.costLedger.sum({ taskId })).usd_micro,
      );
      expect(await cardsOf(o, taskId)).toEqual([]);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-3: a task without a budget of its own keeps the session's token for its review", async () => {
    const TITLE = "Write the about page";
    const w = world(codes(TITLE, "about.html"));
    const o = await w.open(home());
    const issued: { agentId: string; taskId?: string; budgetUsdMicro: number }[] = [];
    const issue = o.rt.tokens.issue.bind(o.rt.tokens);
    o.rt.tokens.issue = (claims) => {
      issued.push(claims);
      return issue(claims);
    };
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, { file: "about.html" });
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      expect((await o.rt.store.task.mustGet(taskId)).status).toBe("done");
      const session = await o.rt.store.session.mustGet(sessionId);
      const criticTokens = issued.filter(
        (c) => c.agentId === o.rt.criticAgent.id && c.taskId === taskId,
      );
      expect(criticTokens.map((c) => c.budgetUsdMicro)).toEqual([session.budget_cap_usd_micro]);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-4: a fix after a send-back keeps room in its task's budget for its review, and its start line says so; the task never passes its budget", async () => {
    const TITLE = "Write the club history page";
    const w = world([...sendsBackOnce(TITLE), ...codes(TITLE, "history.html")]);
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 2_000_000,
        file: "history.html",
      });
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.status).toBe("done");
      const kept = (await linesOf(o, sessionId)).filter((l) =>
        /^This run may spend CHF \d+\.\d\d \(CHF \d+\.\d\d of the task's budget is kept for its review\): /.test(
          l,
        ),
      );
      // Both work runs (the first and the fix after the send-back) kept room for the review.
      expect(kept).toHaveLength(2);
      expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(2_000_000);
      expect(task.actual_cost_usd_micro).toBe(
        (await o.rt.store.costLedger.sum({ taskId })).usd_micro,
      );
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-5, BA-3: a review that waits at its task's budget gets what it needs from one Continue: a reading review of two calls runs in the next session without the specialist, also after a restart, and no second card comes", async () => {
    const TITLE = "Write the footer";
    const isFooterReview = (r: ModelRequest) => isCritic(r) && text(r).includes(TITLE);
    const w = world([
      // A reading review: it lists the folder, then gives its verdict.
      toolReply("list_dir", { path: "." }, "Reading the folder.", {
        when: (r: ModelRequest) => isFooterReview(r) && firstCall(r),
        times: Number.POSITIVE_INFINITY,
      }),
      submitReply(
        {},
        {
          when: (r: ModelRequest) =>
            isFooterReview(r) && !firstCall(r) && !text(r).includes("Review recorded"),
          times: Number.POSITIVE_INFINITY,
        },
      ),
      ...codes(TITLE, "footer.html", [
        { input_tokens: 1_000, output_tokens: 300 },
        { input_tokens: 1_000, output_tokens: 300 },
      ]),
    ]);
    const h = home();
    let o = await w.open(h);
    try {
      // l4-selftasks-101: the budget leaves 1,000 less than the review's floor after the work.
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 75_000,
        file: "footer.html",
      });
      const { floor } = await budgetBelowFloor(o, taskId, 10_000, 1_000);
      const first = await start(o, projectId);
      await ended(o, first);
      await settleSessions(o.rt);
      expect((await o.rt.store.task.mustGet(taskId)).status).toBe("needs_human");
      const [card] = await cardsOf(o, taskId);
      expect(card?.body).toBe("The work is done; its review waits for room in the budget.");
      // The card stores what the review needs beyond what is left: the review part and one
      // call's worst case.
      const stored = (await o.rt.store.humanRequest.mustGet(String(card?.id))).change_card as Json;
      const task = await o.rt.store.task.mustGet(taskId);
      const price = await o.rt.critic?.reviewCallUsdMicro?.(task, "coder");
      const review =
        o.rt.estimates.estimate({
          specialist: "coder",
          risk_tier: 1,
          outcome: task.outcome,
          acceptance_criteria: task.acceptance_criteria,
        }).reviewUsdMicro ?? 0;
      expect(stored.needs_usd_micro).toBe(review + (price?.worstUsdMicro ?? 0) - (floor - 1_000));
      // Composed again between the pause and Continue (with its services: Continue is the
      // person's start, on the daemon's scheduler).
      await o.rt.close();
      o = await w.open(h, { services: true });
      const [again] = await cardsOf(o, taskId);
      const coderBefore = w.seen.filter(isCoderOn(TITLE)).length;
      const answered = await o.req(`/requests/${String(again?.id)}/answer`, {
        method: "POST",
        body: JSON.stringify({
          version: again?.version,
          answer: ((again?.options as string[] | undefined) ?? [])[0],
        }),
      });
      expect(answered.status).toBe(200);
      const done = await waitFor(
        async () => {
          const t = await o.rt.store.task.mustGet(taskId);
          return t.status === "done" ? t : undefined;
        },
        async () => {
          const t = await o.rt.store.task.mustGet(taskId);
          return `the footer to be done (${t.status}: ${t.reason})`;
        },
      );
      await settleSessions(o.rt);
      // Only the critic ran: no coder request after the pause, one coder run in all.
      expect(w.seen.filter(isCoderOn(TITLE)).length).toBe(coderBefore);
      expect(
        (await o.rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic"),
      ).toHaveLength(1);
      // The review read the folder, then gave its verdict: two calls, both admitted.
      expect(w.seen.filter(isFooterReview).length).toBeGreaterThanOrEqual(2);
      expect(await cardsOf(o, taskId)).toEqual([]);
      expect(done.actual_cost_usd_micro).toBeLessThanOrEqual(done.budget_usd_micro);
      expect(done.actual_cost_usd_micro).toBe(
        (await o.rt.store.costLedger.sum({ taskId })).usd_micro,
      );
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("BA-11: Redo of a done task keeps its figure; with nothing left of its budget it pauses before it runs, with one card and Continue", async () => {
    const TITLE = "Write the about page";
    const w = world([...codes(TITLE, "about.html")]);
    const o = await w.open(home(), { services: true });
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 2_000_000,
        file: "about.html",
      });
      const first = await start(o, projectId);
      await ended(o, first);
      await settleSessions(o.rt);
      const done = await o.rt.store.task.mustGet(taskId);
      expect(done.status).toBe("done");
      const figure = done.actual_cost_usd_micro;
      expect(figure).toBeGreaterThan(0);
      expect(figure).toBe((await o.rt.store.costLedger.sum({ taskId })).usd_micro);
      // Its budget is what it spent (as a CHF 0.20 task whose work and review used it all).
      await o.rt.store.task.patch(taskId, { budget_usd_micro: figure } as never);
      const before = await o.rt.store.task.mustGet(taskId);
      const redo = await o.req(
        `/tasks/${taskId}/action`,
        post({ action: "redo", version: before.version }),
      );
      expect(redo.status, await redo.clone().text()).toBe(200);
      const ready = await o.rt.store.task.mustGet(taskId);
      expect(ready.status).toBe("ready");
      // Redo never resets nor raises the figure.
      expect(ready.actual_cost_usd_micro).toBe(figure);
      expect(ready.budget_usd_micro).toBe(figure);
      const coderBefore = w.seen.filter(isCoderOn(TITLE)).length;
      const second = await start(o, projectId);
      await ended(o, second);
      await settleSessions(o.rt);
      const paused = await o.rt.store.task.mustGet(taskId);
      expect(paused.status).toBe("needs_human");
      expect(paused.actual_cost_usd_micro).toBe(figure);
      // Nothing ran: no coder call, no new work run.
      expect(w.seen.filter(isCoderOn(TITLE)).length).toBe(coderBefore);
      const events = (await o.json(`/sessions/${second}/events`)) as unknown as Json[];
      const finished = events.find((e) => e.type === "task.finished");
      const chf = (usd: number) => `CHF ${((usd * 0.8) / 1e6).toFixed(2)}`;
      expect((finished?.payload as Json | undefined)?.summary).toBe(
        `Its budget of ${chf(figure)} is spent (${chf(figure)} so far), so nothing ran.`,
      );
      const cards = await cardsOf(o, taskId);
      expect(cards).toHaveLength(1);
      expect((cards[0]?.options as string[]) ?? []).toEqual([
        expect.stringMatching(/^Continue \(CHF \d+\.\d{2} more\)$/),
        "Cancel task",
      ]);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);
});

/**
 * l4-selftasks-check, run L4 (L4-selftasks-101 with L4-money-303; live check 4's LC-C30: the
 * README task, budget CHF 0.08, did its work for CHF 0.02 and then "paused before its review: its
 * own budget of CHF 0.08 has no room for it"; the owner, 2026-11-16: a task's budget counts
 * "critics reviews, and fixes"). Through the composed runtime on the Messages API stand-in.
 */
describe("l4-selftasks-check, run L4", () => {
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), "fr-l4-review-room-"));
    homes.push(h);
    return h;
  };

  it("L4-selftasks-101: a small task whose work used a quarter of its budget is reviewed within what is left: a critic Run row, Done, no budget card, each call sized to the room", async () => {
    const TITLE = "Write the README";
    // The work bills USD 0.024 (two calls of 2,000 tokens in and 800 out) of USD 0.10.
    const w = world(
      codes(TITLE, "README.md", [
        { input_tokens: 2_000, output_tokens: 800 },
        { input_tokens: 2_000, output_tokens: 800 },
      ]),
    );
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 100_000,
        file: "README.md",
      });
      const sessionId = await start(o, projectId);
      const s = await ended(o, sessionId);
      await settleSessions(o.rt);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.status).toBe("done");
      const runs = await o.rt.store.run.forTask(taskId);
      expect(runs.filter((r) => r.specialist === "critic").length).toBeGreaterThan(0);
      expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(100_000);
      expect(await cardsOf(o, taskId)).toEqual([]);
      expect(s.status).toBe("completed");
      const calls = w.seen.filter((r) => isCritic(r) && text(r).includes(TITLE));
      for (const c of calls) {
        expect(c.max_tokens).toBeGreaterThanOrEqual(2_048);
        expect(c.max_tokens).toBeLessThanOrEqual(8_192);
      }
      expect(calls[0]?.max_tokens).toBeLessThan(8_192);
      // The row reads its one figure against the budget, in CHF.
      const rows = (await o.json(`/projects/${projectId}/tasks`)) as unknown as Json[];
      const row = rows.find((t) => t.id === taskId) as Json;
      expect((row.spent as Json).usdMicro).toBe(task.actual_cost_usd_micro);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  it("L4-money-303: left above the price of the smallest output but below the first call's whole price: no check runs, no critic call or Run row, one review-waits card", async () => {
    const TITLE = "Write the opening times";
    const w = world(
      codes(TITLE, "times.html", [
        { input_tokens: 2_500, output_tokens: 2_000 },
        { input_tokens: 2_500, output_tokens: 2_000 },
      ]),
    );
    const o = await w.open(home());
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 75_000,
        file: "times.html",
      });
      // The work bills 50,000; what is left lies between the price of 2,048 tokens out alone
      // (20,480 on Sonnet 5.5) and the first call's whole price (the floor).
      const price = await o.rt.critic?.reviewCallUsdMicro?.(
        await o.rt.store.task.mustGet(taskId),
        "coder",
      );
      const floor = price?.floorUsdMicro ?? 0;
      const left = Math.round((20_480 + floor) / 2);
      expect(left).toBeGreaterThan(20_480);
      expect(left).toBeLessThan(floor);
      await o.rt.store.task.patch(taskId, { budget_usd_micro: 50_000 + left } as never);
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      expect(w.seen.filter((r) => isCritic(r) && text(r).includes(TITLE))).toEqual([]);
      expect(
        (await o.rt.store.run.forTask(taskId)).filter((r) => r.specialist === "critic"),
      ).toEqual([]);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.status).toBe("needs_human");
      expect(task.actual_cost_usd_micro).toBe(50_000);
      const cards = await cardsOf(o, taskId);
      expect(cards.map((c) => c.body)).toEqual([
        "The work is done; its review waits for room in the budget.",
      ]);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);

  // The review of fix/l4-selftasks-check (non-blocking 2): a tier 3 review runs at effort max and
  // is never sized down, so its first call asks for at least 8,192 tokens out. Its floor was the
  // first call's price at 2,048 out, so with room between the two prices the review started (its
  // checks ran, a critic Run row was written) and its first call was then refused: L4-money-303's
  // symptom at effort max. Tier 3 runs here on the composition's test-only process pin.
  it("L4-money-303 at effort max: a tier 3 task whose left lies above the price at 2,048 tokens out but below its first call's at 8,192: no review starts, no critic Run row, one review-waits card", async () => {
    const TITLE = "Write the payment page";
    // The work bills 100,000: two calls of 2,500 tokens in and 2,000 out on the tier 3 coder's
    // model (Opus 5.5 prices, USD 4 / 20 per million tokens).
    const WORK = 100_000;
    const w = world(
      codes(TITLE, "pay.html", [
        { input_tokens: 2_500, output_tokens: 2_000 },
        { input_tokens: 2_500, output_tokens: 2_000 },
      ]),
    );
    const o = await w.open(home(), { everyTier: true });
    try {
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 10_000_000,
        file: "pay.html",
        riskTier: 3,
      });
      const price = await o.rt.critic.reviewCallUsdMicro(
        await o.rt.store.task.mustGet(taskId),
        "coder",
      );
      expect(price.maxEffort).toBe(true);
      // The review's model and its prices, as the critic prices a call: the worst case is the
      // input (system prompt and evidence allowance) with 24,000 tokens out.
      const project = await o.rt.store.project.mustGet(projectId);
      const pricing = pricingFor(
        o.rt.critic.service.modelFor(3, { projectSettings: project.settings } as never).model,
      );
      const input = price.worstUsdMicro - pricing.estimate(0, 24_000);
      const at2048 = input + pricing.estimate(0, 2_048);
      const at8192 = input + pricing.estimate(0, 8_192);
      const left = at2048 + Math.round((at8192 - at2048) / 4);
      await o.rt.store.task.patch(taskId, { budget_usd_micro: WORK + left } as never);
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.actual_cost_usd_micro).toBe(WORK);
      expect(w.seen.filter((r) => isCritic(r) && text(r).includes(TITLE))).toEqual([]);
      expect(
        (await o.rt.store.run.forTask(taskId)).filter((r) => r.specialist === "critic"),
      ).toEqual([]);
      expect(task.status).toBe("needs_human");
      expect((await cardsOf(o, taskId)).map((c) => c.body)).toEqual([
        "The work is done; its review waits for room in the budget.",
      ]);
      // The floor the runner read: the first call's whole price at 8,192 tokens out.
      expect(price.floorUsdMicro).toBe(at8192);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);
});

/**
 * fixup-w8-l4-leftovers, wave 8 (L4i-left-31, the review's blocking item 1): a done task whose
 * review waits for room is said one way wherever the session's end is shown. Before, its row
 * said 'Done; its review waits for room in its budget of CHF 0.01' while the session page's
 * badge (GET /sessions/:id statusText) said "Ended: 1 paused", the Sessions row "1 done, 1 paused
 * · Ended: 1 paused" and the log's end line "Session over: 1 done, 1 paused. CHF 0.02.": the
 * daemon's `stillBlocked`, the list's counts and the end event never told the review apart.
 */
describe("w8-l4-leftovers, wave 8: a review that waits is said one way where the session's end is shown (L4i-left-31)", () => {
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));

  it("the session page's badge, the Sessions row and the log's end line say the review waits, also after a restart", async () => {
    const FOOTER = "Write the footer";
    const HEADER = "Write the header";
    const w = world([
      ...codes(FOOTER, "footer.html", [
        { input_tokens: 1_000, output_tokens: 300 },
        { input_tokens: 1_000, output_tokens: 300 },
      ]),
      ...codes(HEADER, "header.html"),
    ]);
    const h = mkdtempSync(join(tmpdir(), "fr-budget-all-"));
    homes.push(h);
    let o = await w.open(h);
    try {
      const { projectId, taskId } = await projectWithTask(o, FOOTER, {
        budgetUsdMicro: 75_000,
        file: "footer.html",
      });
      const header = await addTask(o, projectId, HEADER, { file: "header.html" });
      await budgetBelowFloor(o, taskId, 10_000, 1_000);
      const sessionId = await start(o, projectId);
      await ended(o, sessionId);
      await settleSessions(o.rt);
      expect((await o.rt.store.task.mustGet(taskId)).status).toBe("needs_human");
      expect((await o.rt.store.task.mustGet(header)).status).toBe("done");
      // The log's end line, as the session page shows it.
      const lines = await linesOf(o, sessionId);
      expect(lines.filter((l) => l.startsWith("Session over"))).toEqual([
        expect.stringMatching(
          /^Session over: 1 done, 1 review waits for room\. (?:Less than )?CHF \d+\.\d{2}\.$/,
        ),
      ]);
      expect(lines.join(" | ")).not.toMatch(/\b1 paused\b/);
      const said = async (x: Opened) => {
        const s = await x.json(`/sessions/${sessionId}`);
        const list = await x.json(`/projects/${projectId}/sessions`);
        const row = ((list.rows as Json[]) ?? []).find((r) => r.id === sessionId) as Json;
        return {
          statusText: s.statusText,
          countsWords: row?.countsWords,
          endedWords: row?.endedWords,
          tasks: row?.tasks,
        };
      };
      const expected = {
        statusText: "Ended: 1 review waits for room",
        countsWords: "1 done, 1 review waits for room",
        endedWords: "Ended: 1 review waits for room",
        tasks: {
          done: 1,
          failed: 0,
          paused: 0,
          reviewWaits: 1,
          needsYou: 0,
          cancelled: 0,
          leftForYou: 0,
        },
      };
      expect(await said(o)).toEqual(expected);
      // Persisted (validation rule 4): composed again on the same home, the same words.
      await o.rt.close();
      o = await w.open(h);
      expect(await said(o)).toEqual(expected);
    } finally {
      await settleSessions(o.rt);
      await o.rt.close();
    }
  }, 120_000);
});
