import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { plainStopReason } from "../src/session/cannot-run-card.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * Live walk 4 (real model, 2026-11-02): a task the run refused at once (the researcher on an
 * API key: its web tools are not there) became needs_human with no card. The Inbox said
 * "Nothing needs you", Home "Waiting on you 0", the session's result '"X" needs your decision
 * (Inbox).'; the badge read "Paused" with "Press Resume", Resume only started the same refusal,
 * and the reason was cut at 200 characters mid-sentence with tool names in it.
 *
 * Now every task a run leaves waiting has exactly one card: here '"X" could not run' with the
 * reason in whole sentences, Try again and Cancel task; the Tasks tab offers no Resume; the
 * card survives a restart without a second copy; a task that asked the person keeps its one
 * questions card.
 *
 * Since ADR 0107 the researcher reads the web on an API key, so that refusal is gone; the run
 * here is refused for a specialist this install does not have (a plan can name one, and the
 * plan card does not flag it), which is still refused before any call.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
/** The registry's specialists, as the refusal names them. */
const SPECIALISTS =
  "coder, data-analyst, designer, migration-specialist, ops-deploy, researcher, reviewer, science-evaluator, tester, writer-marketing";
type Json = Record<string, unknown>;

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

describe("a task a run leaves waiting without asking gets one card (live walk 4)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-cannot-run-"));
  const fake = new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [submitReply({}, { times: Number.POSITIVE_INFINITY }), closingReply()],
  });
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let taskId = "";

  const inbox = async () => (await (await req("/inbox")).json()) as { requests: Json[] };
  const openCards = async (id = taskId) =>
    (await inbox()).requests.filter((r) => r.taskId === id && r.status === "open");
  const taskView = async (id = taskId) =>
    ((await (await req(`/projects/${projectId}/tasks`)).json()) as Json[]).find(
      (t) => t.id === id,
    ) as Json;
  const runSession = async () => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    return waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
          ? s
          : undefined;
      },
      async () => `the session to end (task ${String((await taskView()).status)})`,
    );
  };

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      (await (
        await req("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Garden club", goal: "Know what other clubs offer" }),
        })
      ).json()) as Json
    ).id as string;
    // A task for a specialist the registry does not have, as a plan can name one.
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Draw the club's logo",
        outcome: "logo.svg shows the club's name over a green leaf.",
        acceptanceCriteria: ["logo.svg names the club"],
        priority: "high",
        status: "ready",
        dependsOn: [],
        specialist: "illustrator",
        riskTier: 1,
      }),
    });
    expect(created.status).toBe(201);
    taskId = ((await created.json()) as Json).id as string;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the refusal files one card; the result, the Tasks tab and the Inbox agree; no tool names", async () => {
    const ended = await runSession();
    const cards = await openCards();
    expect(cards).toHaveLength(1);
    const card = cards[0] as Json;
    expect(card.title).toBe('"Draw the club\'s logo" could not run');
    expect(card.body).toBe(
      `No specialist is named "illustrator", so nothing ran. The specialists are: ${SPECIALISTS}.`,
    );
    expect(card.choices).toEqual([
      expect.objectContaining({
        label: "Try again",
        explain:
          "Starts a session that tries again; first fix what stopped it (Edit changes who does it).",
        tone: "primary",
      }),
      expect.objectContaining({ label: "Cancel task", tone: "danger" }),
    ]);
    // The session's result points at a card that is there.
    expect(String(ended.summary)).toContain('"Draw the club\'s logo" needs your decision (Inbox).');
    // The Tasks tab: one sentence that says so and the card to open; no "Paused", no Resume.
    const view = await taskView();
    expect(view.status).toBe("needs_human");
    expect(view.display).toMatchObject({
      key: "answer",
      label: "Needs your decision: it could not run",
      blocker: { kind: "card", requestId: card.id, cardKind: "cannot_run" },
    });
    // The reason is a whole sentence without tool names (it was cut at 200 characters).
    expect(view.reason).toBe('No specialist is named "illustrator", so nothing ran.');
    for (const text of [card.title, card.body, view.reason, JSON.stringify(view.display)])
      expect(String(text)).not.toMatch(/cc:|Press Resume|Paused/);
    // The Inbox counts it as needing the person.
    expect(
      ((await (await req("/inbox")).json()) as { needsYouCount?: number }).needsYouCount,
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("the card survives a restart with no second copy", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    await rt.syncApprovals();
    expect(await openCards()).toHaveLength(1);
    expect((await rt.store.task.mustGet(taskId)).status).toBe("needs_human");
  }, 120_000);

  it("Try again starts a session; the same refusal files one new card, never two", async () => {
    const card = (await openCards())[0] as Json;
    const sessionsBefore = (await rt.store.session.list({} as never, { limit: 100 })).length;
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: "Try again" }),
    });
    expect(answered.status).toBe(200);
    // A session started by itself and ran into the same refusal.
    await waitFor(
      async () => {
        const all = await rt.store.session.list({} as never, { limit: 100 });
        return all.length > sessionsBefore && all.every((s) => s.status !== "running")
          ? true
          : undefined;
      },
      async () =>
        `a session after Try again (task ${(await rt.store.task.mustGet(taskId)).status})`,
    );
    await waitFor(
      async () => ((await openCards()).length === 1 ? true : undefined),
      async () => `one open card (${(await openCards()).length})`,
    );
    const again = await openCards();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(card.id);
    const old = (await inbox()).requests.find((r) => r.id === card.id);
    expect(String(old?.outcome)).toMatch(
      /^Trying "Draw the club's logo" again: (a session started|it runs after the current session)\.$/,
    );
  }, 60_000);

  it("Cancel task cancels it and closes the card", async () => {
    const card = (await openCards())[0] as Json;
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: "Cancel task" }),
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.task.mustGet(taskId)).status).toBe("cancelled");
    expect(await openCards()).toEqual([]);
  }, 60_000);

  it("a task only the person can do keeps its one questions card, with no could-not-run card", async () => {
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Choose the club's colours",
        outcome: "The colours are chosen.",
        acceptanceCriteria: ["Two colours are named"],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        specialist: "person",
        riskTier: 1,
      }),
    });
    const id = ((await created.json()) as Json).id as string;
    await runSession().catch(() => undefined);
    const cards = await openCards(id);
    expect(cards.map((c) => c.title)).not.toContain('"Choose the club\'s colours" could not run');
    expect(cards).toHaveLength(1);
  }, 60_000);
});

describe("a stop reason as a person reads it", () => {
  it("drops tool lists, keeps whole sentences and cuts a long first sentence at a word", () => {
    expect(
      plainStopReason(
        "The researcher works from the web (cc:WebFetch, cc:WebSearch), so nothing ran. Add a subscription and set the task back to ready, or cancel it. A third sentence.",
      ),
    ).toBe(
      "The researcher works from the web, so nothing ran. Add a subscription and try again, or cancel it.",
    );
    expect(
      plainStopReason("It wrote docs/data.md and stopped at CHF 0.40. Then more.", 200, 1),
    ).toBe("It wrote docs/data.md and stopped at CHF 0.40.");
    const long = `${"word ".repeat(60)}end.`;
    const cut = plainStopReason(long, 100, 1);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("word…")).toBe(true);
  });
});
