import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, type Clock, join, SimulatedClock } from "@forerunner/platform";
import type { JsonObject } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "../src/provider/types.ts";
import { collectStream } from "../src/provider/types.ts";
import { readIntakeReply } from "../src/session/intake.ts";
import {
  contentQuestion,
  promisedContent,
  withOwnersContent,
} from "../src/session/intake-content.ts";

/**
 * A brief that promises the person's own content gets a step that asks for it (live L-11,
 * 2026-11-02). "A one-page website for a small bakery in Bern; I will give you the real menu,
 * hours and address" got a plan of a coder ("All shop facts are placeholders") and a tester; the
 * page was accepted full of PLACEHOLDER markers and the person was never asked. The live reply
 * is a fixture (`fixtures/intake-live-bakery.json`: model output, no secret in it).
 */
const BAKERY = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "intake-live-bakery.json"), "utf8"),
) as { goal: string; brief: string; reply_text: string };

const tasksOf = (p: ReturnType<typeof readIntakeReply>["proposal"]) => [
  ...p.plan.milestones.flatMap((m) => m.tasks),
  ...p.plan.tasks,
];

describe("content the brief says the person will give (live L-11)", () => {
  it("is read from the brief: its items, never feedback, an approval or a secret", () => {
    expect(promisedContent(BAKERY.brief)).toEqual({
      phrase: "the real menu, hours and address",
      items: ["menu", "hours", "address"],
    });
    expect(promisedContent("A club site. We'll send you the member list and the photos.")).toEqual({
      phrase: "the member list and the photos",
      items: ["member list", "photos"],
    });
    for (const none of [
      "A page that shows a random quote",
      "I will give you feedback on the design",
      "I'll give you the API key and the password",
      "I will review the plan before it starts",
      // The person chose to start with stand-ins, or to give it later.
      "A bakery page; use placeholders, I will give you the menu",
      "A bakery page; I will give you the menu later",
    ])
      expect(promisedContent(none), none).toBeNull();
  });

  it("asks one question per item, in the person's words", () => {
    expect(["menu", "hours", "address", "photos", "logo"].map(contentQuestion)).toEqual([
      "What is the menu?",
      "What are the hours?",
      "What is the address?",
      "Where are the photos (a path in the project's folder, or a link)?",
      "Where is the logo (a path in the project's folder, or a link)?",
    ]);
  });

  it("the live bakery plan gets a person task for the menu, hours and address, and the build waits on it", () => {
    const live = readIntakeReply(BAKERY.reply_text).proposal;
    // The live plan: a coder and a tester, no step for the person.
    expect(tasksOf(live).map((t) => t.specialist)).toEqual(["coder", "tester"]);
    const fixed = withOwnersContent(live, BAKERY.brief);
    const tasks = tasksOf(fixed);
    expect(tasks.map((t) => t.key)).toEqual(["your-content", "build-site", "check-site"]);
    const asks = tasks[0];
    expect(asks).toMatchObject({
      title: "Give the real menu, hours and address",
      specialist: "person",
      priority: "high",
      dependsOn: [],
      acceptanceCriteria: ["What is the menu?", "What are the hours?", "What is the address?"],
    });
    expect(tasks.find((t) => t.key === "build-site")?.dependsOn).toEqual(["your-content"]);
    expect(tasks.find((t) => t.key === "check-site")?.dependsOn).toEqual(["build-site"]);
    // A person task needs no first-session item; the rest of the proposal is as it was.
    expect(fixed.firstSession).toEqual(live.firstSession);
    expect(fixed.docs).toEqual(live.docs);
    // The live plan itself is not changed.
    expect(tasksOf(live)).toHaveLength(2);
  });

  it("a plan that already asks for the content keeps its task; the build is made to wait on it", () => {
    const live = readIntakeReply(BAKERY.reply_text).proposal;
    const planned = structuredClone(live);
    planned.plan.milestones[0]?.tasks.push({
      key: "menu-facts",
      title: "Give the bakery's real menu, hours and address",
      outcome: "the person's facts",
      acceptanceCriteria: ["What is on the menu?"],
      priority: "high",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "person",
      status: "ready",
    });
    const fixed = withOwnersContent(planned, BAKERY.brief);
    const tasks = tasksOf(fixed);
    expect(tasks.filter((t) => t.specialist === "person").map((t) => t.key)).toEqual([
      "menu-facts",
    ]);
    expect(tasks.find((t) => t.key === "build-site")?.dependsOn).toEqual(["menu-facts"]);
  });

  it("a brief that promises nothing leaves the plan as it is", () => {
    const live = readIntakeReply(BAKERY.reply_text).proposal;
    expect(withOwnersContent(live, "A one-page website for a small bakery in Bern")).toBe(live);
  });
});

/** A provider that answers from a FIFO queue and records every request, in order. */
class QueueProvider implements ModelProvider {
  readonly name = "fake";
  readonly calls: ModelRequest[] = [];
  readonly queue: string[] = [];
  constructor(private readonly clock: Clock) {}
  async listModels(): Promise<ModelRef[]> {
    return [{ provider: "fake", id: "fake-haiku", tier: "haiku" }];
  }
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...req, messages: structuredClone(req.messages) });
    const text = this.queue.shift();
    yield { type: "message_start", model: req.model };
    if (text === undefined) {
      yield { type: "error", code: "no_reply_queued", message: "no reply", retryable: false };
      return;
    }
    for (const chunk of text.match(/[\s\S]{1,4000}/g) ?? [])
      yield { type: "text_delta", text: chunk };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1000,
        output_tokens: Math.ceil(text.length / 4),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.clock.monotonic(),
    );
  }
}

describe("the bakery brief through the daemon: the plan card asks for the content, the build waits (live L-11)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-11-02T14:10:00Z");
  const provider = new QueueProvider(clock);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-intake-content-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "Robin", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      // The scheduler runs, as in the app: Approve and start asks it for a session.
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("Approve and start writes the person task first; its questions are in the Inbox and the build waits on it", async () => {
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Bakery Bern", goal: BAKERY.goal, brief: BAKERY.brief }),
    });
    expect(created.status).toBe(201);
    const project = (await json(created)) as { id: string };
    provider.queue.push(BAKERY.reply_text);
    const drafted = await req(`/projects/${project.id}/intake`, { method: "POST", body: "{}" });
    expect(drafted.status).toBe(202);
    // The model is told the rule; the code holds it when the model does not (the live reply).
    expect(provider.calls[0]?.system).toContain(
      "Content the brief says the human will give (a menu, prices, opening hours, an address,",
    );
    // The plan card as the Inbox reads it: three tasks, the person's first.
    const inbox = (await json(await req("/inbox"))) as { requests: Record<string, unknown>[] };
    const card = inbox.requests.find((r) => r.projectId === project.id && r.status === "open");
    expect(card?.title).toBe('Plan for "Bakery Bern": 3 tasks');
    const proposal = (card?.changeCard as JsonObject | undefined)?.proposal as {
      plan: { milestones: { tasks: { title: string; specialist?: string }[] }[] };
    };
    expect(
      proposal.plan.milestones[0]?.tasks.map((t) => [t.title, t.specialist ?? "coder"]),
    ).toEqual([
      ["Give the real menu, hours and address", "person"],
      ["Build the one-page bakery site", "coder"],
      ["Check the site: validity, responsiveness, placeholders", "tester"],
    ]);
    const answered = await req(`/requests/${card?.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card?.version, answer: "Approve and start" }),
    });
    expect(answered.status).toBe(200);
    const tasks = await rt.store.task.list({ project_id: project.id } as never);
    const asks = tasks.find((t) => t.specialist === "person");
    const build = tasks.find((t) => t.title === "Build the one-page bakery site");
    expect(asks).toBeDefined();
    expect(build?.depends_on).toEqual([asks?.id]);
    // The person's questions are a card in the Inbox; the build waits; nothing ran.
    await rt.syncApprovals();
    const cards = (await json(await req("/inbox"))) as { requests: Record<string, unknown>[] };
    const questions = cards.requests.find((r) => r.taskId === asks?.id && r.status === "open");
    expect(questions?.steps).toEqual([
      "What is the menu?",
      "What are the hours?",
      "What is the address?",
    ]);
    expect((await rt.store.task.mustGet(asks?.id as string)).status).toBe("needs_human");
    expect((await rt.store.task.mustGet(build?.id as string)).status).toBe("ready");
    expect(await rt.store.run.forTask(build?.id as string)).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    // Nothing a session can run: no session was started only to file the person's questions
    // (design §4.8, "nothing runnable means no session").
    const sessions = await rt.store.session.list({ project_id: project.id } as never);
    expect(sessions.filter((s) => !s.summary.startsWith("intake")).map((s) => s.trigger)).toEqual(
      [],
    );
    // The plan card's Done line says what happens next: no Start to press, the answers first.
    const plan = cards.requests.find((r) => r.id === card?.id);
    expect(plan?.outcome).toBe(
      "Plan approved: 3 tasks written; the work starts once you answer its questions in the Inbox.",
    );
  });
});
