import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { taskContextBlock } from "../src/session/task-context.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * Live walk 2 (2026-11-01), phase C "continuity": the owner answered seven questions on the
 * plan's person task "Owner supplies the bakery's real content"; the coder of the task after it
 * asked all the same questions again, because its brief said only what the plan had promised
 * for the person's task ("answers are recorded in docs/data.md", which was not true) under
 * "Done before this task". The answers were on the request and at the end of the decision
 * record, and no brief carried them.
 *
 * Now a task that waited on a task the person answered carries the person's question -> answer
 * pairs in its brief, said to be the person's own answers, with where they are recorded.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

const Q_MENU = "What is on the menu, with prices?";
const Q_HOURS = "What are the opening hours?";

function provider(clock: SimulatedClock) {
  return new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      // The critic's turns first: their messages name the task too.
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      textReply("Filled in the menu and the hours from the person's answers.", {
        when: { lastUserIncludes: "Replace the placeholders" },
        times: Number.POSITIVE_INFINITY,
      }),
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

/** Polls in real time; the error says what was seen last. */
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

describe("the person's answers reach the task that waited on them (phase C, live walk 2 #3)", () => {
  const clock = new SimulatedClock("2026-11-01T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-answers-"));
  const fake = provider(clock);
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let content: TaskRow;
  let fill: TaskRow;

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      await rt.store.project.insert({
        name: "Bakery",
        goal: "A website for the bakery",
        autonomy_level: 2,
        settings: { members: [rt.agent.id] },
      })
    ).id;
    content = await rt.store.task.insert({
      project_id: projectId,
      title: "Owner supplies the bakery's real content",
      // What the plan promised for the person's task: not where the answers end up.
      outcome: "The owner's answers are recorded in docs/data.md.",
      acceptance_criteria: [Q_MENU, Q_HOURS],
      risk_tier: 1,
      status: "ready",
      priority: 9,
      specialist: "person",
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    fill = await rt.store.task.insert({
      project_id: projectId,
      title: "Replace the placeholders with the real content",
      outcome: "index.html shows the real menu and hours.",
      acceptance_criteria: ["No TODO is left in index.html"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      specialist: "coder",
      depends_on: [content.id],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 100_000,
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("answering the person's card in the Inbox starts the next task, and its brief carries the answers", async () => {
    await rt.syncApprovals();
    const inbox = (await (await req("/inbox")).json()) as { requests: Json[] };
    const card = inbox.requests.find((r) => r.taskId === content.id && r.status === "open");
    expect(card, "the person task's card is in the Inbox").toBeDefined();
    // What the Inbox form sends: one answer per question it shows.
    const answered = await req(`/requests/${String(card?.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({
        version: card?.version,
        answer: {
          answers: [
            { question: Q_MENU, answer: "Zopf CHF 6.50, Nusstorte CHF 4.20" },
            { question: Q_HOURS, answer: "Tuesday to Saturday, 7:00 to 18:00" },
          ],
        },
      }),
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.task.mustGet(content.id)).status).toBe("done");
    // Answering resumes work: a session runs the task that waited, and the critic reviews it.
    const call = await waitFor(
      async () =>
        fake.calls.find((c) =>
          JSON.stringify(c.request.messages).includes("Replace the placeholders"),
        ),
      async () =>
        `the coder's run (task ${(await rt.store.task.mustGet(fill.id)).status}, ${fake.calls.length} calls)`,
    );
    const brief = String(
      (call.request.messages[0] as { content: unknown } | undefined)?.content ?? "",
    );
    // The person's answers, question by question, said to be theirs.
    expect(brief).toContain(
      '## Answers from the person to "Owner supplies the bakery\'s real content"',
    );
    expect(brief).toContain(Q_MENU);
    expect(brief).toContain("Zopf CHF 6.50, Nusstorte CHF 4.20");
    expect(brief).toContain(Q_HOURS);
    expect(brief).toContain("Tuesday to Saturday, 7:00 to 18:00");
    expect(brief).toContain("These are the person's own answers");
    expect(brief).toContain("do not ask the person these questions again");
    expect(brief).toContain("docs/decisions/");
    // The plan's promise for the person's task is not told as what was done.
    expect(brief).not.toContain("recorded in docs/data.md");
    await waitFor(
      async () => ((await rt.store.task.mustGet(fill.id)).status === "done" ? true : undefined),
      async () => {
        const t = await rt.store.task.mustGet(fill.id);
        return `the task to be done (${t.status}: ${t.reason})`;
      },
    );
    // Nothing asked again: no new card for the task that waited.
    const after = (await (await req("/inbox")).json()) as { requests: Json[] };
    expect(after.requests.filter((r) => r.taskId === fill.id && r.status === "open")).toEqual([]);
  }, 60_000);

  it("Go ahead without is no answer to the person's own card: refused in words, the task and the one after it wait (phase E)", async () => {
    // Before phase E this closed the person's task with no answers although its card offers
    // only the form and Cancel task (design §3.8: Go ahead without is the specialist's card's,
    // "the specialist decides"); the task after it then started on nothing.
    const asked = await rt.store.task.insert({
      project_id: projectId,
      title: "Owner picks the colours",
      outcome: "The colours are recorded in docs/style.md.",
      acceptance_criteria: ["Which colours should the site use?"],
      risk_tier: 1,
      status: "ready",
      priority: 9,
      specialist: "person",
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    const style = await rt.store.task.insert({
      project_id: projectId,
      title: "Style the site",
      outcome: "styles.css",
      risk_tier: 1,
      status: "draft",
      priority: 5,
      specialist: "designer",
      depends_on: [asked.id],
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    await rt.syncApprovals();
    const inbox = (await (await req("/inbox")).json()) as { requests: Json[] };
    const card = inbox.requests.find((r) => r.taskId === asked.id && r.status === "open");
    // The options the Inbox shows on it: the form and Cancel task.
    expect(((card?.choices ?? []) as { label: string }[]).map((c) => c.label)).toEqual([
      "Cancel task",
    ]);
    const refused = await req(`/requests/${String(card?.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card?.version, answer: "Go ahead without" }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Json).message).toBe(
      "This card needs your answers: type them, or Cancel task.",
    );
    await rt.syncApprovals();
    expect((await rt.store.task.mustGet(asked.id)).status).toBe("needs_human");
    expect((await rt.store.humanRequest.mustGet(String(card?.id))).status).toBe("open");
    expect((await rt.store.task.mustGet(style.id)).status).toBe("draft");
    const brief = await taskContextBlock(rt.store, await rt.store.task.mustGet(style.id));
    expect(brief).not.toContain("go ahead without answering");
  });
});
