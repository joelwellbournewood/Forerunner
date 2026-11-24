import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ModelProvider } from "../src/provider/types.ts";
import {
  ASK_PERSON_TOOL,
  DECISION_DOC_DIR,
  DECISION_RECORD_MARK,
  DEFAULT_DECISION_DOC,
} from "../src/session/person-questions.ts";
import { removeHomes, ScriptedProvider, type ScriptReply, settleSessions } from "./helpers.ts";
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

async function compose(
  home: string,
  clock: SimulatedClock,
  fake: ModelProvider,
  extra: { startServices?: boolean } = {},
) {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const rt = await composeRuntime({
    ...extra,
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
    // W8-guide-3 (D-W8-9): the card names the file its answers go to, by the day's name (the
    // project has no decision record yet).
    expect(String(card?.why)).toContain(
      "Your answers are written to the project's decision record (docs/decisions/2026-10-31-project-decisions.md).",
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
    // W8-guide-3: the file the card named (a new record, named by the day).
    const doc = join(
      rt.intake.workspaceDir(projectId),
      ...DECISION_DOC_DIR.split("/"),
      `2026-10-31-${DEFAULT_DECISION_DOC}`,
    );
    expect(existsSync(doc)).toBe(true);
    expect(readFileSync(doc, "utf8")).toContain("<!-- forerunner:decision-record -->");
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

  it('a typed "go ahead" on the person\'s own card is refused in words, from the Inbox route and from chat; the task waits (phase E)', async () => {
    // Before, every questions card read "go ahead" as Go ahead without, so a typed answer from
    // the phone, the web approvals or the chat's request_answer closed a planned person task
    // with no answers although its card offers only the form and Cancel task, and what waited
    // on it started on nothing (live walk 2 #3 by another road).
    const t = await rt.store.task.insert({
      project_id: projectId,
      title: "Owner supplies the bakery's opening hours",
      outcome: "The hours are known.",
      acceptance_criteria: ["What are the opening hours?"],
      specialist: "person",
      status: "ready",
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    const next = await rt.store.task.insert({
      project_id: projectId,
      title: "Put the hours on the page",
      outcome: "index.html shows the hours",
      specialist: "coder",
      status: "ready",
      depends_on: [t.id],
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    await rt.syncApprovals();
    const card = (await cardFor(t.id)) as Json;
    // What the Inbox offers on it: the form and Cancel task, no Go ahead without.
    expect((card.choices as { label: string }[]).map((c) => c.label)).toEqual(["Cancel task"]);
    expect(card.reply).toBe("form");
    for (const word of ["go ahead", "Go ahead without", { choice: "Go ahead without" }]) {
      const refused = await req(`/requests/${card.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ version: card.version, answer: word }),
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as Json).message).toBe(
        "This card needs your answers: type them, or Cancel task.",
      );
    }
    if (!rt.conversation) throw new Error("no conversation agent");
    const said = await rt.commands.execute(
      { name: "request.answer", params: { request: String(card.id), answer: "go ahead" } },
      {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        activeProjectId: projectId,
        sessionId: await rt.conversation.conversationSessionId(rt.agent.id, null),
        source: "text",
        wordsUsed: "go ahead on the hours card",
      },
    );
    expect(said).toMatchObject({ status: "refused", code: "validation" });
    expect(said.reason).toContain("This card needs your answers: type them, or Cancel task.");
    await rt.syncApprovals();
    expect((await cardFor(t.id))?.status).toBe("open");
    expect((await rt.store.task.mustGet(t.id)).status).toBe("needs_human");
    expect((await rt.store.task.mustGet(next.id)).status).toBe("ready");
    expect(await rt.store.run.forTask(next.id)).toEqual([]);
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
    // d1109-starts-engine (S-2, ADR 0118): the answer prepares the task; the person's Start runs
    // its next run, and its brief carries the answer.
    expect(await rt.store.session.active(rt.agent.id)).toEqual([]);
    const res = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(res.status).toBe(202);

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

describe("w8-repo-guide, wave 8: the Inbox answers go to the file the card names (W8-guide-3)", () => {
  // fixup-w8-repo-guide (review of W8-guide-3): the card named the record by the day it was
  // filed, and the answers were written to a file named by the day they were answered, so the
  // card's sentence was untrue whenever the person answered on another day (the review's probe:
  // filed 2026-10-31, answered 2026-11-01, the card named 2026-10-31-project-decisions.md and
  // only 2026-11-01-project-decisions.md was written).
  type Req = Awaited<ReturnType<typeof compose>>["req"];
  const inboxOf = async (req: Req) => (await (await req("/inbox")).json()) as { requests: Json[] };
  const openCard = async (req: Req, taskId: string) =>
    (await inboxOf(req)).requests.find((r) => r.taskId === taskId && r.status === "open");
  const recordLine = (file: string) =>
    `Your answers are written to the project's decision record (${file}).`;
  const plannedWhy = (title: string, file: string) =>
    `"${title}" needs your answers. No specialist works on it: answer the questions below. ${recordLine(file)} The task is then done.`;
  const decisionsIn = (rt: RuntimeApp, projectId: string) =>
    readdirSync(join(rt.intake.workspaceDir(projectId), ...DECISION_DOC_DIR.split("/"))).sort();
  const answerCard = async (req: Req, card: Json, pairs: [string, string][]) => {
    const res = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({
        version: card.version,
        answer: { answers: pairs.map(([question, answer]) => ({ question, answer })) },
      }),
    });
    expect(res.status).toBe(200);
  };
  const personTask = (rt: RuntimeApp, projectId: string, title: string, questions: string[]) =>
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
      title,
      specialist: "person",
      acceptance_criteria: questions,
    } as never);

  it("a card filed one evening and answered the next morning: the answers go to the file the card named, also after the daemon starts again; no file named by the answer's day and no 0001 file", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-person-record-"));
    const evening = new SimulatedClock("2026-10-31T20:00:00Z");
    let { rt, req } = await compose(home, evening, provider(evening));
    try {
      const projectId = (
        await rt.store.project.insert({
          name: "Site",
          goal: "A site for the club",
          autonomy_level: 2,
          settings: { members: [rt.agent.id] },
        })
      ).id;
      const task = await personTask(rt, projectId, "Choose the domain", [
        "Which domain should the site use?",
      ]);
      await rt.syncApprovals();
      const named = "docs/decisions/2026-10-31-project-decisions.md";
      expect((await openCard(req, task.id))?.why).toBe(plannedWhy("Choose the domain", named));
      // The daemon starts again the next morning: the card still names the same file.
      await settleSessions(rt);
      await rt.close();
      const morning = new SimulatedClock("2026-11-01T08:00:00Z");
      ({ rt, req } = await compose(home, morning, provider(morning)));
      const card = (await openCard(req, task.id)) as Json;
      expect(card.why).toBe(plannedWhy("Choose the domain", named));
      await answerCard(req, card, [["Which domain should the site use?", "club-site.example"]]);
      expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
      // Written to the file the card named, and to no other.
      expect(decisionsIn(rt, projectId)).toEqual(["2026-10-31-project-decisions.md"]);
      const text = readFileSync(
        join(rt.intake.workspaceDir(projectId), ...named.split("/")),
        "utf8",
      );
      expect(text).toContain(DECISION_RECORD_MARK);
      expect(text).toContain('## Answers for "Choose the domain" (2026-11-01)');
      expect(text).toContain("**Which domain should the site use?**\n\nclub-site.example");
    } finally {
      await settleSessions(rt);
      await rt.close();
      removeHomes([home]);
    }
  }, 120_000);

  it("two person tasks whose cards are filed on two days before either is answered name the same record, and both answers land in it", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-person-record-"));
    const day1 = new SimulatedClock("2026-10-31T09:00:00Z");
    let { rt, req } = await compose(home, day1, provider(day1));
    try {
      const projectId = (
        await rt.store.project.insert({
          name: "Site",
          goal: "A site for the club",
          autonomy_level: 2,
          settings: { members: [rt.agent.id] },
        })
      ).id;
      const first = await personTask(rt, projectId, "Choose the domain", [
        "Which domain should the site use?",
      ]);
      await rt.syncApprovals();
      const named = "docs/decisions/2026-10-31-project-decisions.md";
      expect((await openCard(req, first.id))?.why).toBe(plannedWhy("Choose the domain", named));
      await settleSessions(rt);
      await rt.close();
      // The next day a second question task becomes ready; the first card is still open, so no
      // record exists yet: the second card names the record the first one named.
      const day2 = new SimulatedClock("2026-11-01T09:00:00Z");
      ({ rt, req } = await compose(home, day2, provider(day2)));
      const second = await personTask(rt, projectId, "Choose the mail address", [
        "Which address gets the mail?",
      ]);
      await rt.syncApprovals();
      expect((await openCard(req, second.id))?.why).toBe(
        plannedWhy("Choose the mail address", named),
      );
      await answerCard(req, (await openCard(req, second.id)) as Json, [
        ["Which address gets the mail?", "board@club-site.example"],
      ]);
      await answerCard(req, (await openCard(req, first.id)) as Json, [
        ["Which domain should the site use?", "club-site.example"],
      ]);
      expect(decisionsIn(rt, projectId)).toEqual(["2026-10-31-project-decisions.md"]);
      const text = readFileSync(
        join(rt.intake.workspaceDir(projectId), ...named.split("/")),
        "utf8",
      );
      expect(text.match(/## Answers for/g)).toHaveLength(2);
      expect(text.split(DECISION_RECORD_MARK)).toHaveLength(2);
    } finally {
      await settleSessions(rt);
      await rt.close();
      removeHomes([home]);
    }
  }, 120_000);

  it("after the plan from the brief wrote its date-named decision record, the person's answers land in that record, also after a restart and on a later day; the card names that file and no 0001 file is made", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-person-record-"));
    const day1 = new SimulatedClock("2026-10-31T09:00:00Z");
    const replies: ScriptReply[] = [];
    const planner = new ScriptedProvider(replies, day1);
    let { rt, req } = await compose(home, day1, planner, { startServices: false });
    try {
      const created = await req("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Club page",
          goal: "A page for the club",
          brief: [
            "A one-page site for the club: plain HTML and CSS.",
            "- A list of the next meetings.",
            "- A contact address.",
          ].join("\n"),
        }),
      });
      expect(created.status).toBe(201);
      const projectId = String(((await created.json()) as Json).id);
      // The model names the first decision by number, as a reply may: the intake renames it
      // to the day's name and marks it as the project's decision record.
      replies.push({
        text: `\`\`\`json\n${JSON.stringify({
          plan: {
            reason: "planned from the brief",
            milestones: [
              {
                name: "The page",
                successCriteria: ["The page is online"],
                targetDate: null,
                tasks: [
                  {
                    key: "domain",
                    title: "Choose the domain",
                    outcome: "The domain is chosen",
                    acceptanceCriteria: ["Which domain should the site use?"],
                    priority: 8,
                    specialist: "person",
                  },
                ],
              },
            ],
            tasks: [],
          },
          docs: {
            "README.md": "# Club page\n\nA page for the club.\n",
            "docs/decisions/0001-plain-static-page.md":
              "# A plain static page\n\nStatus: accepted\n\nPlain HTML and CSS, no build step.\n",
          },
          firstSession: {
            summary: "The domain first.",
            items: [{ key: "domain", estimateUsdMicro: 10_000 }],
          },
        })}\n\`\`\``,
      });
      const proposed = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
      expect(proposed.status, await proposed.clone().text()).toBe(202);
      // fixup-w8-repo-guide (review of W8-guide-3): the first plan's decision lines, changed by
      // the area, as the exact text the planning model receives (model-facing text is code),
      // and the Today date it names the record by.
      expect(planner.calls).toHaveLength(1);
      const asked = planner.calls[0];
      expect(asked?.system).toContain(
        [
          "and docs/decisions/YYYY-MM-DD-<slug>.md for the first decision, named by the Today date;",
          "each a markdown file with a title",
          "line, concrete to this project. A standard doc you leave out is written from Forerunner's",
        ].join("\n"),
      );
      expect(asked?.system).toContain(
        [
          "Choose what the brief points to (the stack, the hosting, the repository) and write each",
          "choice and why in that decision record. Its first line under the title is",
          '"Decision: " and the choice in one or two sentences: the person reads that line on the plan',
        ].join("\n"),
      );
      expect(asked?.system).not.toContain("0001");
      expect(JSON.stringify(asked?.messages)).toContain("Today: 2026-10-31 (UTC)");
      const intakeRequest = String(((await proposed.json()) as Json).requestId);
      const plan = await rt.store.humanRequest.mustGet(intakeRequest);
      const approved = await req(`/requests/${intakeRequest}/answer`, {
        method: "POST",
        body: JSON.stringify({ version: plan.version, answer: "Approve and start" }),
      });
      expect(approved.status).toBe(200);
      const record = "docs/decisions/2026-10-31-plain-static-page.md";
      expect(decisionsIn(rt, projectId)).toEqual(["2026-10-31-plain-static-page.md", "README.md"]);
      const task = (await rt.store.task.list({ project_id: projectId } as never)).find(
        (t) => t.title === "Choose the domain",
      );
      if (!task) throw new Error("no person task in the plan");
      await rt.syncApprovals();
      expect((await openCard(req, task.id))?.why).toBe(plannedWhy("Choose the domain", record));
      // The daemon starts again the next day; the answer goes to the plan's record.
      await settleSessions(rt);
      await rt.close();
      const day2 = new SimulatedClock("2026-11-01T09:00:00Z");
      ({ rt, req } = await compose(home, day2, new ScriptedProvider([], day2), {
        startServices: false,
      }));
      const card = (await openCard(req, task.id)) as Json;
      expect(card.why).toBe(plannedWhy("Choose the domain", record));
      await answerCard(req, card, [["Which domain should the site use?", "club.example"]]);
      expect(decisionsIn(rt, projectId)).toEqual(["2026-10-31-plain-static-page.md", "README.md"]);
      const text = readFileSync(
        join(rt.intake.workspaceDir(projectId), ...record.split("/")),
        "utf8",
      );
      expect(text).toContain("Plain HTML and CSS, no build step.");
      expect(text).toContain('## Answers for "Choose the domain" (2026-11-01)');
      expect(text).toContain("**Which domain should the site use?**\n\nclub.example");
    } finally {
      await settleSessions(rt);
      await rt.close();
      removeHomes([home]);
    }
  }, 120_000);

  it("a first plan's reply naming a doc outside the set is asked again with the exact problem line the model receives, naming the decision record's form by the Today date", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-person-record-"));
    const day1 = new SimulatedClock("2026-10-31T09:00:00Z");
    const replies: ScriptReply[] = [];
    const planner = new ScriptedProvider(replies, day1);
    const { rt, req } = await compose(home, day1, planner, { startServices: false });
    try {
      const created = await req("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: "Club page",
          goal: "A page for the club",
          brief: "A one-page site for the club.\n- The next meetings.\n- A contact address.",
        }),
      });
      const projectId = String(((await created.json()) as Json).id);
      const plan = (docs: Record<string, string>) => ({
        text: JSON.stringify({
          plan: {
            reason: "planned from the brief",
            milestones: [
              {
                name: "The page",
                successCriteria: ["The page is online"],
                targetDate: null,
                tasks: [
                  {
                    key: "page",
                    title: "Write the page",
                    outcome: "index.html lists the meetings",
                    acceptanceCriteria: ["index.html lists the meetings"],
                    priority: "high",
                  },
                ],
              },
            ],
            tasks: [],
          },
          docs,
          firstSession: {
            summary: "The page.",
            items: [{ key: "page", estimateUsdMicro: 50_000 }],
          },
        }),
      });
      const record = {
        "docs/decisions/2026-10-31-plain-page.md": "# A plain page\n\nDecision: plain HTML.\n",
      };
      replies.push(plan({ ...record, "docs/notes.md": "# Notes\n" }), plan(record));
      const proposed = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
      expect(proposed.status, await proposed.clone().text()).toBe(202);
      expect(planner.calls).toHaveLength(2);
      expect(String(planner.calls[1]?.messages.at(-1)?.content)).toBe(
        [
          "Forerunner could not use your reply:",
          "- docs.docs/notes.md: docs may only name the standard doc set (README.md, docs/overview.md, docs/architecture.md, docs/decisions/README.md, docs/runbook.md, docs/data.md, docs/testing.md) or docs/decisions/YYYY-MM-DD-<slug>.md, named by the Today date",
          "",
          "Reply again with the whole JSON object in the shape the instructions give, with these problems fixed and nothing else changed: no text and no code fence around it.",
        ].join("\n"),
      );
    } finally {
      await rt.close();
      removeHomes([home]);
    }
  }, 120_000);
});
