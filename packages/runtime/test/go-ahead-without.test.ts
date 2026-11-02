import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ModelRequest, StreamEvent } from "../src/provider/types.ts";
import {
  ASK_PERSON_TOOL,
  answersBlockFor,
  askPersonTool,
  pendingPersonQuestions,
  WITHOUT_ANSWERS_NOTE,
} from "../src/session/person-questions.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * "Go ahead without" reaches the specialist (live L-3, 2026-11-02). The data analyst of the
 * "Members chart" asked where data/members.csv is (call 106); the person pressed Go ahead
 * without while the session still ran another task; the session took the chart again and its
 * brief (call 114) said nothing of the choice ("## The previous attempt" only): the note the
 * answer queued was not in the queue the running session had read at its start. The specialist
 * asked the same question again (call 116) and the Inbox showed a second card with Go ahead
 * without, which can loop at a run's cost each time. Now the brief carries the choice from the
 * card itself, read when the run starts, and `ask_person` is refused on the task once the person
 * went ahead without: no second card. The live questions are fixtures (`fixtures/asking-live.json`).
 */
const LIVE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "asking-live.json"), "utf8"),
) as Record<
  "members_chart_first_ask" | "members_chart_second_ask",
  { ask_person: { questions: string[]; why: string } }
>;
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

const firstUser = (req: ModelRequest): string => {
  const m = req.messages[0];
  if (!m) return "";
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
};
const isChart = (req: ModelRequest) =>
  (req.tools ?? []).some((t) => t.name === ASK_PERSON_TOOL) &&
  firstUser(req).includes("Members chart: charts/members.svg");
const askedThisRun = (req: ModelRequest) =>
  JSON.stringify(req.messages.slice(1)).includes(`"name":"${ASK_PERSON_TOOL}"`);

/** The stand-in model with a hook that runs before a request is answered. */
class HookedProvider extends FakeProvider {
  hook: ((req: ModelRequest) => Promise<void>) | null = null;
  override async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.hook) await this.hook(req);
    yield* super.stream(req);
  }
}

function provider(clock: SimulatedClock) {
  return new HookedProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      // The chart's first run asks where the file is (live call 106).
      toolReply(ASK_PERSON_TOOL, LIVE.members_chart_first_ask.ask_person, "", {
        when: (req) => isChart(req) && !askedThisRun(req),
        times: 1,
      }),
      // Its next run asks the same again, as the live model did (call 116): told or not.
      toolReply(ASK_PERSON_TOOL, LIVE.members_chart_second_ask.ask_person, "", {
        when: (req) => isChart(req) && !askedThisRun(req),
        times: 1,
      }),
      textReply(
        "No chart: data/members.csv is missing, and the person chose to go ahead without it, so I invented no number.",
        { when: (req) => isChart(req) && askedThisRun(req), times: Number.POSITIVE_INFINITY },
      ),
      textReply("Wrote other.html. Tests pass.", {
        when: (req) =>
          firstUser(req).startsWith("# Task brief") &&
          firstUser(req).includes("Other page in other.html"),
        times: Number.POSITIVE_INFINITY,
      }),
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
    ],
  });
}

async function compose(home: string, clock: SimulatedClock, fake: FakeProvider) {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
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

/** Polls until `probe` gives a value; the message says what it last saw (Windows CI is slow). */
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  seen: () => Promise<unknown> = async () => undefined,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(await seen())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Go ahead without reaches the specialist and is not asked again (live L-3)", () => {
  const clock = new SimulatedClock("2026-11-02T14:17:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-go-ahead-without-"));
  const fake = provider(clock);
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let chart: TaskRow;
  const inbox = async () => (await (await req("/inbox")).json()) as { requests: Json[] };

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      await rt.store.project.insert({
        name: "Club tools",
        goal: "The garden club's page, its members chart and its deploy",
        autonomy_level: 2,
        settings: { members: [rt.agent.id] },
      })
    ).id;
    const add = (fields: Partial<TaskRow>) =>
      rt.store.task.insert({
        project_id: projectId,
        risk_tier: 1,
        status: "ready",
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 100_000,
        reason: "planned",
        author_agent: rt.agent.id,
        ...fields,
      } as never);
    chart = await add({
      title: "Members chart",
      outcome: "charts/members.svg: a bar chart of members per year from data/members.csv",
      acceptance_criteria: [
        "Every bar uses the exact number from data/members.csv",
        "No number is invented",
      ],
      specialist: "data-analyst",
      priority: 9,
    });
    await add({
      title: "Other page in other.html",
      outcome: "other.html exists",
      acceptance_criteria: ["other.html exists"],
      specialist: "coder",
      priority: 5,
    });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("pressed while the session still runs: the next run's brief says so, a second ask is refused, no second card", async () => {
    // The person presses Go ahead without on the chart's card while the session runs the other
    // page, as live: the answer the Inbox sends is the option's words.
    let pressed = false;
    fake.hook = async (r) => {
      if (pressed || !firstUser(r).startsWith("# Task brief")) return;
      if (!firstUser(r).includes("Other page in other.html")) return;
      pressed = true;
      const card = (await inbox()).requests.find(
        (c) => c.taskId === chart.id && c.status === "open",
      );
      if (!card) throw new Error("the chart's questions card is not in the Inbox");
      const labels = ((card.choices as { label: string }[] | undefined) ?? []).map((c) => c.label);
      expect(labels).toEqual(["Go ahead without", "Cancel task"]);
      const answered = await req(`/requests/${card.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ version: card.version, answer: "Go ahead without" }),
      });
      expect(answered.status).toBe(200);
      expect((await rt.store.session.active(rt.agent.id)).length).toBe(1);
    };
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: 3_000_000 }),
    });
    expect(started.status).toBe(202);
    // Wait for the work to settle: the chart ran twice and no session runs.
    const chartRuns = async () =>
      (await rt.store.run.forTask(chart.id)).filter((r) => r.specialist !== "critic");
    await waitFor(
      "the chart's second run to end and no session to run",
      async () => {
        const t = await rt.store.task.mustGet(chart.id);
        const active = await rt.store.session.active(rt.agent.id);
        const settled = !["claimed", "in_progress", "in_review"].includes(t.status);
        return settled && active.length === 0 && (await chartRuns()).length >= 2 ? t : undefined;
      },
      async () => ({
        chart: (await rt.store.task.mustGet(chart.id)).status,
        runs: (await chartRuns()).length,
        active: (await rt.store.session.active(rt.agent.id)).length,
        calls: fake.calls.length,
      }),
    );
    fake.hook = null;
    expect(pressed).toBe(true);

    // The chart's runs: the first asked; the second's brief carries the person's choice.
    const chartCalls = fake.calls.filter((c) => isChart(c.request));
    const runIds = [...new Set(chartCalls.map((c) => c.request.origin?.runId))];
    expect(runIds).toHaveLength(2);
    const callsOf = (run: string | undefined) =>
      chartCalls.filter((c) => c.request.origin?.runId === run);
    const briefs = runIds.map((run) => firstUser(callsOf(run)[0]?.request as ModelRequest));
    expect(briefs[0]).not.toContain(WITHOUT_ANSWERS_NOTE);
    expect(briefs[1]).toContain(WITHOUT_ANSWERS_NOTE);
    expect(briefs[1]).toContain(LIVE.members_chart_first_ask.ask_person.questions[0]);
    // Its ask_person was refused in words, and the run went on to its report.
    const refusal = JSON.stringify(callsOf(runIds[1]).at(-1)?.request.messages ?? []);
    expect(refusal).toContain("chose to go ahead without answering");
    // One card for the chart, the one the person answered: no second card asked the same.
    const cards = (await inbox()).requests.filter((c) => c.taskId === chart.id);
    expect(cards.map((c) => c.status)).toEqual(["answered"]);
    expect(await pendingPersonQuestions(rt.store, chart.id)).toEqual([]);
    expect((await rt.store.task.mustGet(chart.id)).status).toBe("done");
    // The choice reaches the brief once: no queued note says it again.
    expect(briefs[1]?.split(WITHOUT_ANSWERS_NOTE).length).toBe(2);
  }, 120_000);

  it("after a restart the choice still holds: the brief carries it and ask_person is refused", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    const tool = askPersonTool({ store: rt.store });
    const refused = await tool.execute({ questions: ["Where is data/members.csv?"] }, {
      taskId: chart.id,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      sessionId: null,
      runId: "run-after-restart",
    } as never);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.endRun).toBeUndefined();
    expect(refused.content).toContain("chose to go ahead without answering");
    expect(await pendingPersonQuestions(rt.store, chart.id)).toEqual([]);
    // The brief's answers section, read when a run starts, still carries the choice.
    const block = await answersBlockFor(rt.store, chart.id);
    expect(block).toContain(WITHOUT_ANSWERS_NOTE);
    expect(block).toContain(LIVE.members_chart_first_ask.ask_person.questions[0]);
    expect(block).toContain("Do not ask the person again: ask_person is refused for this task.");
  }, 120_000);
});
