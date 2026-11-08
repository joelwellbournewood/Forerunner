import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { keyRule, messagesApiStandIn, standInFetch } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import type {
  BillingOrderView,
  HumanRequestView,
  InboxView,
  StartCheckView,
  StartSessionView,
  TaskView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { waitingOf } from "../src/wiring/billing-pick.ts";
import { AcceptingCriticProvider, ScriptedProvider, type ScriptReply } from "./helpers.ts";

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
const OAUTH = ["sk-ant-oat01-", "cred-sub-", "4".repeat(40)].join(""); // not-a-secret

const runtimes: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close().catch(() => undefined);
});

interface World {
  rt: RuntimeApp;
  req: (path: string, body?: unknown) => Promise<Response>;
  messages: () => number;
}

/**
 * A small plan, as the planning call is asked for one ("Plan size: small": one milestone with one
 * task, a README): what the stand-in's model answers once a credential serves the call.
 */
const SMALL_PLAN = JSON.stringify({
  plan: {
    reason: "planned from the brief",
    milestones: [
      {
        name: "The page",
        successCriteria: ["the page shows a quote"],
        targetDate: null,
        tasks: [
          {
            key: "page",
            title: "Write the quote page",
            outcome: "index.html shows a random quote",
            acceptanceCriteria: ["opening index.html shows a quote"],
            priority: 5,
            specialist: "coder",
          },
        ],
      },
    ],
    tasks: [],
  },
  docs: { "README.md": "# Quotes\n\nA page that shows a random quote.\n" },
  firstSession: {
    summary: "Write the page.",
    items: [{ key: "page", estimateUsdMicro: 200_000, rationale: "the whole brief" }],
  },
});

/** The project as New project creates it: the dialog's exact body, with a brief (U-046). */
const QUOTES = {
  name: "Quotes",
  goal: "A page that shows a random quote",
  brief: "A page that shows a random quote.",
  intake: true,
};

/** A project card's status sentence (`ProjectCard.statusLine`). */
interface StatusLine {
  kind: string;
  text: string;
  action: { kind: string; label: string; to: string | null } | null;
}

/** The plan from the brief, as `GET /projects/:id/intake` answers it. */
interface IntakeView {
  state: string;
  error: string | null;
  wait?: { reason: string; text: string; short: string } | null;
}

function world(
  clock: SimulatedClock,
  opts: { limitMs?: number; replies?: ScriptReply[]; sdkQuery?: QueryLike } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "fr-cred-limits-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const vault = new MemoryVault();
  const model = new AcceptingCriticProvider(
    new ScriptedProvider(opts.replies ?? [{ text: "Wrote the note. Lesson: none." }], clock),
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
      ...(opts.sdkQuery ? { sdkQuery: opts.sdkQuery } : {}),
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

    // Quit and start again on the same home and vault (the mark is persisted state): the card,
    // the rows and Settings still say so, the scheduler's ticks start nothing on the refused
    // key, and nothing calls the API.
    await rt.close();
    const later = await w.start();
    await later.rt.scheduler.tick();
    expect(messages()).toBe(1);
    const kept = await json<InboxView>(later.req("/inbox"));
    expect(kept.requests.filter((r) => r.status === "open").map((r) => r.title)).toEqual([
      "Anthropic refused your API key",
    ]);
    const keptRows = await json<TaskView[]>(later.req(`/projects/${project.id}/tasks`));
    expect(keptRows.map((t) => [t.status, t.display?.label])).toEqual([
      ["ready", "Waits for a new API key"],
      ["ready", "Waits for a new API key"],
    ]);
    const keptOrder = await json<BillingOrderView>(later.req("/settings/billing-order"));
    expect(keptOrder.sources.map((s) => [s.kind, s.blocked])).toEqual([["api_key", "refused"]]);
    // Home and the project header say what the project waits for, with where to fix it
    // (before: "0 of 2 done [Open Tasks]").
    const card0 = await json<{ statusLine: StatusLine }>(later.req(`/projects/${project.id}`));
    expect(card0.statusLine).toEqual({
      kind: "waiting",
      text: "Waiting for a new API key: 2 tasks",
      action: { kind: "link", label: "Save a new key", to: "/setup" },
    });

    // The person pastes a new key in the setup assistant after the restart: the mark and the
    // card go, and the waiting work starts by itself and finishes.
    const saved = await json<{ ok: boolean }>(later.req("/setup/anthropic", { value: GOOD }));
    expect(saved.ok).toBe(true);
    const after = await json<BillingOrderView>(later.req("/settings/billing-order"));
    expect(after.sources[0]?.blocked).toBeNull();
    const closed = await json<InboxView>(later.req("/inbox"));
    expect(closed.requests.filter((r) => r.status === "open")).toHaveLength(0);
    expect(closed.requests.find((r) => r.title === "Anthropic refused your API key")?.outcome).toBe(
      "A new one is saved; the work that waited for it goes on.",
    );
    await until("the waiting tasks to finish after the new key", async () => {
      const now = await Promise.all([a, b].map((t) => later.rt.store.task.mustGet(t.id)));
      return now.every((t) => t.status === "done") ? null : now.map((t) => t.status).join(", ");
    });
    const audit = await later.rt.store.auditLog.list({ tool: "billing.refused" } as never, {
      limit: 10,
    });
    expect(audit).toHaveLength(1);
  }, 120_000);
});

describe("planning that meets a refused API key (U-078)", () => {
  it("waits for a new key instead of failing, says so with where to save one, and drafts the plan by itself once it is saved, after a restart too", async () => {
    const clock = new SimulatedClock("2026-11-03T14:00:00Z");
    const w = world(clock, { replies: [{ text: SMALL_PLAN }] });
    await w.vault.set(SECRET_NAMES.anthropic, REFUSED);
    const first = await w.start();

    // New project with a brief: the plan is drafted in the background and meets the refusal.
    const created = await json<{ id: string }>(first.req("/projects", QUOTES));
    await first.rt.intake.inFlight(created.id)?.catch(() => undefined);
    expect(first.messages()).toBe(1);

    // The project page: the plan waits for a new key, it did not fail, and Try again (which
    // cannot work while the key is refused) is not offered.
    const status = await json<IntakeView>(first.req(`/projects/${created.id}/intake`));
    expect(status.state).toBe("waiting");
    expect(status.wait).toMatchObject({
      reason: "refused",
      text: "Planning waits for a new API key: save one in Settings.",
      short: "Planning waits for a new API key",
    });
    const card = await json<{ statusLine: StatusLine }>(first.req(`/projects/${created.id}`));
    expect(card.statusLine).toEqual({
      kind: "waiting",
      text: "Planning waits for a new API key",
      action: { kind: "link", label: "Save a new key", to: "/setup" },
    });
    // One card names the key; its promise ("starts by itself then") covers the planning too.
    const inbox = await json<InboxView>(first.req("/inbox"));
    expect(inbox.requests.filter((r) => r.status === "open").map((r) => r.title)).toEqual([
      "Anthropic refused your API key",
    ]);

    // Quit and start again: the plan still waits, and nothing calls the refused key.
    await first.rt.close();
    const second = await w.start();
    await second.rt.scheduler.tick();
    expect(second.messages()).toBe(1);
    const kept = await json<IntakeView>(second.req(`/projects/${created.id}/intake`));
    expect(kept.state).toBe("waiting");

    // The setup assistant saves a new key (the UI's body): the plan is drafted by itself and
    // waits in the Inbox for approval; the refused card is answered.
    const saved = await json<{ ok: boolean }>(second.req("/setup/anthropic", { value: GOOD }));
    expect(saved.ok).toBe(true);
    await until("the plan to be drafted after the new key", async () => {
      const s = await json<IntakeView>(second.req(`/projects/${created.id}/intake`));
      return s.state === "pending" ? null : `${s.state} ${s.error ?? ""}`;
    });
    const now = await json<{ statusLine: StatusLine }>(second.req(`/projects/${created.id}`));
    expect(now.statusLine.text).toBe("Waiting for you: approve the plan");
    const after = await json<InboxView>(second.req("/inbox"));
    expect(after.requests.filter((r) => r.status === "open").map((r) => r.kind)).toEqual([
      "approval",
    ]);
    expect(after.requests.find((r) => r.title === "Anthropic refused your API key")?.outcome).toBe(
      "A new one is saved; the work that waited for it goes on.",
    );
    expect(second.messages()).toBe(2);
  }, 120_000);

  it("at a usage limit the plan waits until the reset, says until when, and is drafted by itself then", async () => {
    const clock = new SimulatedClock("2026-11-03T14:00:00Z");
    const w = world(clock, { limitMs: 100 * 60_000, replies: [{ text: SMALL_PLAN }] });
    await w.vault.set(SECRET_NAMES.anthropic, LIMITED);
    const { rt, req, messages } = await w.start();

    const created = await json<{ id: string }>(req("/projects", QUOTES));
    await rt.intake.inFlight(created.id)?.catch(() => undefined);
    expect(messages()).toBe(1);
    const status = await json<IntakeView>(req(`/projects/${created.id}/intake`));
    expect(status.state).toBe("waiting");
    // 15:40 UTC is 16:40 in Zurich.
    expect(status.wait).toMatchObject({
      reason: "limit",
      text: "Planning waits until 16:40 (your API key's limit) and starts by itself.",
      short: "Planning waits until 16:40, your API key's limit",
    });
    const card = await json<{ statusLine: StatusLine }>(req(`/projects/${created.id}`));
    expect(card.statusLine).toEqual({
      kind: "planning",
      text: "Planning waits until 16:40, your API key's limit",
      action: null,
    });
    // A limit asks nothing of the person: no card.
    const inbox = await json<InboxView>(req("/inbox"));
    expect(inbox.requests.filter((r) => r.status === "open")).toHaveLength(0);

    // Before the reset a tick drafts nothing; at the reset the plan is drafted by itself.
    await rt.scheduler.tick();
    expect(messages()).toBe(1);
    clock.set(Date.parse("2026-11-03T15:41:00Z"));
    await rt.scheduler.tick();
    await until("the plan to be drafted at the reset", async () => {
      const s = await json<IntakeView>(req(`/projects/${created.id}/intake`));
      return s.state === "pending" ? null : `${s.state} ${s.error ?? ""}`;
    });
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
    // Home and the project header: what the project waits for, and that nothing is to be done.
    const card = await json<{ statusLine: StatusLine }>(first.req(`/projects/${project.id}`));
    expect(card.statusLine).toEqual({
      kind: "paused",
      text: "Waiting until 16:40 (your API key's limit): 2 tasks",
      action: null,
    });
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

/**
 * The leftovers of wave 7 ('leftovers7-web'): what a credential wait does when another credential
 * could serve, when its start fails, and while a planning call runs; and what the Start dialog
 * says meanwhile.
 */
describe("credential waits: the Start check, another credential, a failed start, a planning call (leftovers7-web)", () => {
  it("R-startcred, R-refusedstays: with the only key refused Start says so; saving a subscription ends the wait and starts the work by itself", async () => {
    const clock = new SimulatedClock("2026-11-08T14:00:00Z");
    let sdkCalls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Claude Code on the subscription: it starts the task's run and holds it until released.
    const sdkQuery: QueryLike = () => {
      sdkCalls++;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "cc", tools: [] };
        await held;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Wrote it. Lesson: none.",
          total_cost_usd: 0,
        };
      })();
    };
    const w = world(clock, { sdkQuery });
    await w.vault.set(SECRET_NAMES.anthropic, REFUSED);
    const { rt, req } = await w.start();
    try {
      const { project } = await twoTasks(rt);
      await run(rt, project.id);
      const labels = async () =>
        (await json<TaskView[]>(req(`/projects/${project.id}/tasks`))).map((t) => t.display?.label);
      expect(await labels()).toEqual(["Waits for a new API key", "Waits for a new API key"]);
      // R-startcred: the Start dialog says what Start would meet (before: "This session runs
      // "Write note A" (about CHF ...)" and Start ended at once with the wait).
      const check = await json<StartCheckView>(req(`/projects/${project.id}/start-check`));
      expect(check.blocked).toEqual({
        kind: "nothing_runnable",
        sentence: "Nothing can run yet. Waits for a new API key: save one in Settings.",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });
      // R-refusedstays: the person adds a Claude subscription instead of a new key. With no
      // order chosen, task runs use the subscription first: the work starts by itself on it.
      const saved = await json<{ ok: boolean }>(req("/setup/anthropic", { value: OAUTH }));
      expect(saved.ok).toBe(true);
      await until("the waiting work to start on the subscription", async () => {
        const sessions = await rt.store.session.list({ project_id: project.id } as never);
        const woke = sessions.some((s) => s.trigger === "budget_reset");
        return woke && sdkCalls > 0 ? null : `sessions ${sessions.length}, sdk calls ${sdkCalls}`;
      });
      // Before: both rows still read "Waits for a new API key" and nothing started.
      expect(await labels()).not.toContain("Waits for a new API key");
      expect(
        (await json<StartCheckView>(req(`/projects/${project.id}/start-check`))).blocked
          ?.sentence ?? "",
      ).not.toContain("Waits for a new API key");
    } finally {
      release();
      await rt.kill.stop("all", "test over", { by: "you", freeze: false });
    }
  }, 120_000);

  it("R-wakeorder: a start that fails keeps the wait on the source, and after a restart the work starts by itself", async () => {
    const clock = new SimulatedClock("2026-11-08T14:00:00Z");
    const w = world(clock, { limitMs: 30 * 60_000 });
    await w.vault.set(SECRET_NAMES.anthropic, LIMITED);
    const { rt } = await w.start();
    const { project, a, b } = await twoTasks(rt);
    await run(rt, project.id);
    const waiting = async (r: RuntimeApp) =>
      (await r.store.billingSource.list({} as never, { limit: 10 }))
        .flatMap((s) => waitingOf(s.limits))
        .map((x) => x.projectId);
    expect(await waiting(rt)).toEqual([project.id]);
    // Another session holds the agent (one the scheduler does not know of): the runner refuses
    // the start the wake asks for, after the reset.
    const blocking = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: null,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 1,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
      reason: "test: holds the agent",
    });
    const running = await rt.store.session.start(blocking.id, blocking.version);
    await clock.advance(31 * 60_000);
    await rt.billing.waits.wake();
    // Before: the wait was taken off the source before the start, which then failed; nothing
    // kept it, so after a restart nothing started the work.
    await until("the failed start to give the wait back", async () => {
      const now = await waiting(rt);
      return now.includes(project.id) ? null : JSON.stringify(now);
    });
    await rt.store.session.setStatus(running.id, running.version, "completed", {});
    await rt.close();
    const later = await w.start();
    await later.rt.scheduler.tick();
    await until("the waiting tasks to finish after the restart", async () => {
      const now = await Promise.all([a, b].map((t) => later.rt.store.task.mustGet(t.id)));
      return now.every((t) => t.status === "done") ? null : now.map((t) => t.status).join(", ");
    });
  }, 120_000);

  it("R-planningstart: a session start asked for while a planning call runs waits for it and then runs", async () => {
    const clock = new SimulatedClock("2026-11-08T14:00:00Z");
    // The planning call answers only once the clock moves a minute.
    const w = world(clock, {
      replies: [{ text: SMALL_PLAN, ttftMs: 60_000 }, { text: "Wrote the note. Lesson: none." }],
    });
    await w.vault.set(SECRET_NAMES.anthropic, GOOD);
    const { rt, req, messages } = await w.start();
    rt.scheduler.start();
    try {
      const { project } = await twoTasks(rt);
      const created = await json<{ id: string }>(req("/projects", QUOTES));
      // The planning call runs on a session row of its own: the agent's one session.
      await until("the planning call to be under way", async () =>
        (await rt.store.session.active(rt.agent.id)).length > 0 ? null : `calls ${messages()}`,
      );
      const started = await req("/sessions", {
        agentId: rt.agent.id,
        projectId: project.id,
        trigger: "manual",
      });
      // Before: 409 "Alice is already working in another session, so this one did not start."
      expect(started.status, await started.clone().text()).toBe(202);
      expect(((await started.json()) as StartSessionView).result).toBe("queued");
      await clock.advance(60_000);
      await until("the queued session to start once planning ended", async () => {
        const sessions = await rt.store.session.list({ project_id: project.id } as never);
        return sessions.length > 0 ? null : "no session of the project yet";
      });
      expect(created.id).toBeTruthy();
    } finally {
      rt.scheduler.stop();
      await rt.kill.stop("all", "test over", { by: "you", freeze: false });
    }
  }, 120_000);
});
