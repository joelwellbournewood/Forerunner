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
  /** `services`: the daemon's services run (the scheduler a Continue starts its session on). */
  const open = async (home: string, opts: { services?: boolean } = {}) => {
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
    // The footer's work bills USD 0.01 (two calls of 1,000 tokens in and 300 out): of its
    // budget of USD 0.075 (CHF 0.06), 65,000 is left, below the light review's output cap of
    // 8,192 tokens on Sonnet 5.5 (USD 0.08192).
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
      expect(task.reason).toBe('"Write the footer" paused at its budget of CHF 0.06.');
      const lines = await linesOf(o, sessionId);
      expect(lines).toContain(
        '"Write the footer" paused before its review: its own budget of CHF 0.06 has no room for it.',
      );
      expect(lines.join(" | ")).not.toMatch(/this session's budget/);
      const cards = await cardsOf(o, taskId);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.title).toBe('"Write the footer" paused at its budget of CHF 0.06');
      expect(cards[0]?.body).toBe("The work is done; its review waits for room in the budget.");
      expect(cards[0]?.options).toEqual([
        expect.stringMatching(/^Continue \(CHF \d+\.\d{2} more\)$/),
        "Cancel task",
      ]);
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

  it("BA-3: a review is capped at what is left of its task's budget: its first call, refused by the precheck, is never made, and the task pauses at its budget", async () => {
    const TITLE = "Write the contact page";
    // The work bills USD 0.0525 of the budget of USD 0.1375 (CHF 0.11): 85,000 is left, above
    // the review's floor (81,920) but below its first call's worst case (the critic's whole
    // input plus 8,192 tokens out).
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
      // Its first call was refused before it was made: no critic request, no critic ledger row.
      expect(w.seen.filter((r) => isCritic(r) && text(r).includes(TITLE))).toEqual([]);
      const review = (await o.rt.store.run.forTask(taskId)).find((r) => r.specialist === "critic");
      expect(review?.outcome).toBe("budget_exceeded");
      expect(review?.cost_usd_micro).toBe(0);
      const task = await o.rt.store.task.mustGet(taskId);
      expect(task.actual_cost_usd_micro).toBe(52_500);
      expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(137_500);
      expect(task.status).toBe("needs_human");
      expect(task.reason).toBe('"Write the contact page" paused at its budget of CHF 0.11.');
      expect(await linesOf(o, sessionId)).toContain(
        '"Write the contact page" paused before its review: its own budget of CHF 0.11 has no room for it.',
      );
      const cards = await cardsOf(o, taskId);
      expect(cards.map((c) => c.body)).toEqual([
        "The work is done; its review waits for room in the budget.",
      ]);
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
      const { projectId, taskId } = await projectWithTask(o, TITLE, {
        budgetUsdMicro: 75_000,
        file: "footer.html",
      });
      const first = await start(o, projectId);
      await ended(o, first);
      await settleSessions(o.rt);
      expect((await o.rt.store.task.mustGet(taskId)).status).toBe("needs_human");
      const [card] = await cardsOf(o, taskId);
      expect(card?.body).toBe("The work is done; its review waits for room in the budget.");
      // The card stores what the review needs beyond the 65,000 left: the review part and one
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
      expect(stored.needs_usd_micro).toBe(review + (price?.worstUsdMicro ?? 0) - 65_000);
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
