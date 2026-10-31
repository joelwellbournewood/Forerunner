import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  ASK_PERSON_TOOL,
  DECISION_DOC_DIR,
  DEFAULT_DECISION_DOC,
} from "../src/session/person-questions.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * U-022 on the desktop daemon, as the person meets it. A project's plan holds a task only the
 * person can do: planned for "person" by the intake, or the 1.0.3 plan's "Confirm stack,
 * hosting and repository with the human" given to `ops`. Before, a session gave it to a
 * specialist, the critic graded the empty run "human", the ladder ran it four times and the
 * Inbox showed a sign-off without the questions. Now the Inbox shows the questions at once
 * (no specialist, nothing spent), the answers the Inbox form sends are written to the
 * project's decision doc and the task is done; "Cancel the task" cancels it; the cards survive
 * a restart without a second copy. A specialist that needs answers asks through `ask_person`:
 * its run ends, the task waits, and once answered the next run's brief carries the answers.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

const ANSWER_ME = "Which hosting provider should the site use?";

function provider(clock: SimulatedClock) {
  return new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      // The specialist's first run: it cannot choose the host, so it asks the person.
      toolReply(
        ASK_PERSON_TOOL,
        { questions: [ANSWER_ME], why: "The deploy target is the person's choice." },
        "I need the person's choice of host first.",
        { when: { toolAvailable: ASK_PERSON_TOOL, lastUserIncludes: "Deploy the site" }, times: 1 },
      ),
      // The run after the answer: the brief carries it.
      textReply("Deployed to Cloudflare Pages as you chose. Tests pass.", {
        when: { lastUserIncludes: "Answers from the person" },
        times: Number.POSITIVE_INFINITY,
      }),
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
    ],
  });
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

async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("questions only the person can answer, on the daemon (U-022)", () => {
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-person-questions-"));
  const fake = provider(clock);
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let planned: TaskRow;
  let legacy: TaskRow;

  /** The Inbox as the app reads it, and one request card by task. */
  const inbox = async () => (await (await req("/inbox")).json()) as { requests: Json[] };
  const cardFor = async (taskId: string) =>
    (await inbox()).requests.find((r) => r.taskId === taskId && r.status === "open");

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      await rt.store.project.insert({
        name: "Site",
        goal: "A site for the club",
        autonomy_level: 2,
        settings: { members: [rt.agent.id] },
      })
    ).id;
    const add = (fields: Partial<TaskRow>) =>
      rt.store.task.insert({
        project_id: projectId,
        outcome: "decided",
        risk_tier: 1,
        status: "ready",
        priority: 5,
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 100_000,
        reason: "planned by the intake",
        author_agent: rt.agent.id,
        title: "",
        ...fields,
      } as never);
    planned = await add({
      title: "Choose the domain and the contact address",
      specialist: "person",
      acceptance_criteria: ["Which domain should the site use?", "Which address gets the mail?"],
    });
    legacy = await add({
      title: "Confirm stack, hosting and repository with the human",
      specialist: "ops",
      acceptance_criteria: ["Stack confirmed", "Hosting confirmed", "Repository linked"],
    });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a planned task for the person is an Inbox question at once; no specialist runs, nothing is spent", async () => {
    await rt.syncApprovals();
    const card = await cardFor(planned.id);
    expect(card).toMatchObject({
      kind: "decision",
      blocking: true,
      projectName: "Site",
      options: ["Cancel the task"],
      steps: ["Which domain should the site use?", "Which address gets the mail?"],
    });
    expect(String(card?.why)).toContain(
      '"Choose the domain and the contact address" needs your answers',
    );
    // The 1.0.3 plan's row in the owner's data asks its three questions.
    expect((await cardFor(legacy.id))?.steps).toEqual([
      "Stack: what do you choose?",
      "Hosting: what do you choose?",
      "Repository: what do you choose?",
    ]);
    for (const t of [planned, legacy])
      expect((await rt.store.task.mustGet(t.id)).status).toBe("needs_human");
    expect(await rt.store.run.forTask(planned.id)).toEqual([]);
    expect(await rt.store.run.forTask(legacy.id)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    // Asked once: another sync files nothing more.
    expect((await rt.syncApprovals()).personQuestions.filed).toBe(0);
    expect((await inbox()).requests.filter((r) => r.taskId === planned.id)).toHaveLength(1);
  });

  it("the cards and their tasks survive a restart, with no second copy", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    expect((await rt.syncApprovals()).personQuestions.filed).toBe(0);
    expect((await inbox()).requests.filter((r) => r.taskId === planned.id)).toHaveLength(1);
    expect((await rt.store.task.mustGet(planned.id)).status).toBe("needs_human");
  }, 120_000);

  it("the answers the Inbox form sends go to the decision doc and the task is done", async () => {
    const card = (await cardFor(planned.id)) as Json;
    const answered = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({
        version: card.version,
        answer: {
          answers: [
            { question: "Which domain should the site use?", answer: "club-site.example" },
            { question: "Which address gets the mail?", answer: "board@club-site.example" },
          ],
        },
      }),
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.task.mustGet(planned.id)).status).toBe("done");
    const doc = join(
      rt.intake.workspaceDir(projectId),
      ...DECISION_DOC_DIR.split("/"),
      DEFAULT_DECISION_DOC,
    );
    expect(existsSync(doc)).toBe(true);
    const text = readFileSync(doc, "utf8");
    expect(text).toContain('## Answers for "Choose the domain and the contact address"');
    expect(text).toContain("**Which domain should the site use?**\n\nclub-site.example");
    expect(text).toContain("board@club-site.example");
    expect(await cardFor(planned.id)).toBeUndefined();
    // Applied once: a later sync writes nothing twice.
    await rt.syncApprovals();
    expect(readFileSync(doc, "utf8").match(/## Answers for/g)).toHaveLength(1);
  });

  it('"Cancel the task" cancels it', async () => {
    const card = (await cardFor(legacy.id)) as Json;
    const options = card.options as string[];
    const answered = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: options[0] }),
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.task.mustGet(legacy.id)).status).toBe("cancelled");
  });

  it("a blank answer is refused and the card stays open", async () => {
    const t = await rt.store.task.insert({
      project_id: projectId,
      title: "Ask the owner which logo to use",
      outcome: "chosen",
      status: "ready",
      reason: "planned",
      author_agent: rt.agent.id,
    });
    await rt.syncApprovals();
    const card = (await cardFor(t.id)) as Json;
    const refused = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: { answers: [{ answer: " " }] } }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Json).message).toContain("Cancel the task");
    expect((await cardFor(t.id))?.status).toBe("open");
  });

  it("a specialist that needs the person asks them: the run ends, and the next run gets the answers", async () => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Deploy the site",
      outcome: "the site is live",
      acceptance_criteria: ["The site answers on its domain"],
      risk_tier: 1,
      status: "ready",
      priority: 9,
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 100_000,
      specialist: "coder",
      reason: "planned",
      author_agent: rt.agent.id,
    });
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: 2_000_000 }),
    });
    expect(started.status).toBe(202);
    const card = await waitFor(async () => {
      const c = await cardFor(task.id);
      return c && (await rt.store.task.mustGet(task.id)).status === "needs_human" ? c : undefined;
    });
    expect(card).toMatchObject({
      kind: "decision",
      steps: [ANSWER_ME],
      options: ["Cancel the task"],
    });
    expect(String(card.why)).toContain(
      'The specialist working on "Deploy the site" needs your answers',
    );
    // One run, which asked and ended; the critic never saw it, so no rung of the ladder ran.
    const runs = await rt.store.run.forTask(task.id);
    expect(runs).toHaveLength(1);
    expect(
      fake.calls.filter((c) => (c.request.tools ?? []).some((t) => t.name === "submit_review")),
    ).toHaveLength(0);
    expect((await rt.store.task.mustGet(task.id)).attempt).toBe(0);

    // The person answers in their own words (the free-text answer the phone sends).
    await waitFor(async () =>
      (await rt.store.session.active(rt.agent.id)).length === 0 ? true : undefined,
    );
    const answered = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: "Cloudflare Pages" }),
    });
    expect(answered.status).toBe(200);
    // The answer starts the task's next run, and its brief carries the answer.
    const second = await waitFor(async () =>
      fake.calls.find((c) =>
        JSON.stringify(c.request.messages).includes("Answers from the person"),
      ),
    );
    const sent = JSON.stringify(second.request.messages);
    expect(sent).toContain(ANSWER_ME);
    expect(sent).toContain("Cloudflare Pages");
  }, 60_000);
});
