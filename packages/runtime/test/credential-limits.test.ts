import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { keyRule, messagesApiStandIn, standInFetch } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type {
  BillingOrderView,
  HumanRequestView,
  InboxView,
  TaskView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * U-078 (ADR 0100 amended 2026-11-03, the owner's decision of 2026-11-02): a refused key is named
 * on one card and the work waits for a new one; a key at its limit makes the work wait for its
 * reset and start by itself, after a restart too. The daemon is composed as `fr daemon` composes
 * it, with no injected provider: the routed provider over the vault's key calls the Messages API
 * stand-in (testenv), which refuses or limits the key by its text. The person's view is read
 * through the routes the screens call (Tasks tab, Inbox, Settings, the setup assistant).
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const REFUSED = ["sk-ant-api03-", "cred-refused-", "1".repeat(40)].join(""); // not-a-secret
const LIMITED = ["sk-ant-api03-", "cred-limited-", "2".repeat(40)].join(""); // not-a-secret
const GOOD = ["sk-ant-api03-", "cred-good-", "3".repeat(40)].join(""); // not-a-secret

const runtimes: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close().catch(() => undefined);
});

interface World {
  rt: RuntimeApp;
  req: (path: string, body?: unknown) => Promise<Response>;
  messages: () => number;
}

function world(clock: SimulatedClock, opts: { limitMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fr-cred-limits-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const vault = new MemoryVault();
  const model = new AcceptingCriticProvider(
    new ScriptedProvider([{ text: "Wrote the note. Lesson: none." }], clock),
  );
  const standIn = messagesApiStandIn({
    model,
    clock,
    answerFor: keyRule({ refuse: ["refused"], limit: ["limited"], limitMs: opts.limitMs }),
  });
  const fetchImpl = standInFetch(standIn, {
    fallback: async () => new Response("not here", { status: 404 }),
  });
  const start = async (): Promise<World> => {
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
    const req = (path: string, body?: unknown) =>
      Promise.resolve(
        app.request(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return {
      rt,
      req,
      messages: () => standIn.requests.filter((r) => r.path === "/v1/messages").length,
    };
  };
  return { vault, standIn, start };
}

async function twoTasks(rt: RuntimeApp) {
  const project = await rt.store.project.insert({
    name: "Notes",
    goal: "Two notes",
    autonomy_level: 2,
  });
  const make = (title: string) =>
    rt.store.task.insert({
      project_id: project.id,
      title,
      outcome: `${title} is written`,
      acceptance_criteria: ["it is written"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 50_000,
      reason: "seed",
    });
  return { project, a: await make("Write note A"), b: await make("Write note B") };
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

describe("a refused API key (U-078)", () => {
  it("one card names it, every task waits for a new key (none failed), and saving one starts the work", async () => {
    const clock = new SimulatedClock("2026-11-03T14:00:00Z");
    const w = world(clock);
    await w.vault.set(SECRET_NAMES.anthropic, REFUSED);
    const { rt, req, messages } = await w.start();
    const { project, a, b } = await twoTasks(rt);

    const result = await run(rt, project.id);

    // One call met the refusal; the task was not tried again at once, and the second never ran
    // on the refused key (before: four calls and two failed tasks).
    expect(messages()).toBe(1);
    for (const t of [a, b]) {
      const row = await rt.store.task.mustGet(t.id);
      expect(row.status).toBe("ready");
      expect(row.attempt).toBe(0);
    }
    expect(result.failed).toEqual([]);
    // The session ends on one sentence, not a row of failed tasks.
    expect(result.summary.split("\n")[0]).toBe("Waits for a new API key: save one in Settings.");

    // The Inbox: exactly one card, naming the key, and nothing about a failed task.
    const inbox = await json<InboxView>(req("/inbox"));
    const open = inbox.requests.filter((r) => r.status === "open");
    expect(open.map((r) => r.title)).toEqual(["Anthropic refused your API key"]);
    const card = open[0] as HumanRequestView;
    expect(card.body).toBe(
      "Save a new one in Settings. The work that needs it waits and starts by itself then.",
    );
    expect(card.links?.map((l) => [l.label, l.to])).toEqual([["Save a new key", "/setup"]]);

    // The Tasks tab: each row says what it waits for.
    const rows = await json<TaskView[]>(req(`/projects/${project.id}/tasks`));
    expect(rows.map((t) => t.display?.label)).toEqual([
      "Waits for a new API key",
      "Waits for a new API key",
    ]);

    // Settings -> Claude: which to use first says the key is refused.
    const order = await json<BillingOrderView>(req("/settings/billing-order"));
    expect(order.sources.map((s) => [s.kind, s.blocked, s.usable])).toEqual([
      ["api_key", "refused", false],
    ]);

    // A second session meets the mark, not the API: no call, no second card.
    await run(rt, project.id);
    expect(messages()).toBe(1);
    const again = await json<InboxView>(req("/inbox"));
    expect(again.requests.filter((r) => r.status === "open")).toHaveLength(1);

    // The person pastes a new key in the setup assistant: the mark and the card go, and the
    // waiting work starts by itself and finishes.
    const saved = await json<{ ok: boolean }>(req("/setup/anthropic", { value: GOOD }));
    expect(saved.ok).toBe(true);
    const after = await json<BillingOrderView>(req("/settings/billing-order"));
    expect(after.sources[0]?.blocked).toBeNull();
    const closed = await json<InboxView>(req("/inbox"));
    expect(closed.requests.filter((r) => r.status === "open")).toHaveLength(0);
    expect(closed.requests.find((r) => r.title === "Anthropic refused your API key")?.outcome).toBe(
      "A new one is saved; the work that waited for it goes on.",
    );
    await until("the waiting tasks to finish after the new key", async () => {
      const now = await Promise.all([a, b].map((t) => rt.store.task.mustGet(t.id)));
      return now.every((t) => t.status === "done") ? null : now.map((t) => t.status).join(", ");
    });
    const audit = await rt.store.auditLog.list({ tool: "billing.refused" } as never, { limit: 10 });
    expect(audit).toHaveLength(1);
  }, 120_000);
});

describe("a key at its usage limit (U-078)", () => {
  it("the work waits until the reset, says so, and starts by itself then, after a restart too", async () => {
    const clock = new SimulatedClock("2026-11-03T14:00:00Z");
    // The stand-in limits the key for 100 minutes from its first call: "regain access at 15:40".
    const w = world(clock, { limitMs: 100 * 60_000 });
    await w.vault.set(SECRET_NAMES.anthropic, LIMITED);
    const first = await w.start();
    const { project, a, b } = await twoTasks(first.rt);

    const result = await run(first.rt, project.id);
    expect(first.messages()).toBe(1);
    expect(result.failed).toEqual([]);
    for (const t of [a, b]) expect((await first.rt.store.task.mustGet(t.id)).status).toBe("ready");
    // 15:40 UTC is 16:40 in Zurich.
    expect(result.summary.split("\n")[0]).toBe(
      "Waits until 16:40 (your API key's limit) and starts by itself.",
    );
    // The session page: its badge and its last line say it waits, not "Stopped: 2 not started".
    const page = await json<{ statusText?: string }>(first.req(`/sessions/${result.sessionId}`));
    expect(page.statusText).toBe("Waiting for a Claude credential");
    const lines = (
      await json<{ text: string; audience?: string }[]>(
        first.req(`/sessions/${result.sessionId}/events`),
      )
    ).filter((e) => e.audience !== "detail");
    expect(lines.map((e) => e.text)).toContain(
      'Your API key reached its usage limit; "Write note A" waits until 16:40 (your API key\'s limit) and starts by itself.',
    );
    expect(lines.at(-1)?.text).toBe("Waiting for a Claude credential: nothing done. CHF 0.00.");
    const rows = await json<TaskView[]>(first.req(`/projects/${project.id}/tasks`));
    expect(rows.map((t) => [t.display?.label, t.display?.detail])).toEqual([
      ["Waits until 16:40, your API key's limit", "It starts by itself then."],
      ["Waits until 16:40, your API key's limit", "It starts by itself then."],
    ]);
    const order = await json<BillingOrderView>(first.req("/settings/billing-order"));
    expect(order.sources[0]?.blocked).toBe("resting");
    // No card: a limit is nothing the person must do.
    const inbox = await json<InboxView>(first.req("/inbox"));
    expect(inbox.requests.filter((r) => r.status === "open")).toHaveLength(0);

    // Quit and start again: the wait is kept. Before the reset nothing starts.
    await first.rt.close();
    const second = await w.start();
    await second.rt.scheduler.tick();
    expect(second.messages()).toBe(1);
    // At the reset the next tick starts the project's session, which finishes both tasks.
    clock.set(Date.parse("2026-11-03T15:41:00Z"));
    await second.rt.scheduler.tick();
    await until("the session started at the reset to finish both tasks", async () => {
      const now = await Promise.all([a, b].map((t) => second.rt.store.task.mustGet(t.id)));
      return now.every((t) => t.status === "done") ? null : now.map((t) => t.status).join(", ");
    });
    const sessions = await second.rt.store.session.list({ project_id: project.id } as never, {
      limit: 10,
    });
    expect(sessions.map((s) => s.trigger).sort()).toEqual(["budget_reset", "manual"]);
  }, 120_000);
});
