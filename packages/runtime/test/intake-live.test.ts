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
  StopReason,
  StreamEvent,
} from "../src/provider/types.ts";
import { collectStream } from "../src/provider/types.ts";
import { parseIntakeReply, readIntakeReply, shortenDoc } from "../src/session/intake.ts";
import { isShortBrief, shortenProse } from "../src/session/project-plan.ts";

/**
 * The intake on the real model (live check of 2026-11-01, bench live1): six real planning
 * replies, of which five were refused and the person read "Planning failed" (a `plan.reason`
 * over 500 characters; a reply whose docs held code fences, read from a doc's snippet). The
 * replies are fixtures (`fixtures/intake-live1.json`: model output, no secret in it). Every
 * one must become a plan card; a reply that still does not validate is asked for once more,
 * with what is wrong in words, before the person sees "Planning failed"; and the words the
 * person reads name the real cause.
 */

interface LiveReply {
  line: number;
  model: string;
  stop_reason: string;
  usage: Record<string, number>;
  reply_text: string;
  request?: { system: string; messages: { role: string; content: string }[] };
}
const LIVE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "intake-live1.json"), "utf8"),
) as LiveReply[];
const live = (line: number): LiveReply => {
  const r = LIVE.find((x) => x.line === line);
  if (!r) throw new Error(`no fixture for line ${line}`);
  return r;
};

/** One planned reply of the stand-in provider: text, a stop reason, or an error code. */
interface Planned {
  text?: string;
  stopReason?: StopReason;
  error?: string;
}

/** A provider that answers from a FIFO queue and records every request, in order. */
class QueueProvider implements ModelProvider {
  readonly name = "fake";
  readonly calls: ModelRequest[] = [];
  readonly queue: Planned[] = [];
  constructor(private readonly clock: Clock) {}
  async listModels(): Promise<ModelRef[]> {
    return [{ provider: "fake", id: "fake-haiku", tier: "haiku" }];
  }
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...req, messages: structuredClone(req.messages) });
    const r = this.queue.shift() ?? { error: "no_reply_queued" };
    yield { type: "message_start", model: req.model };
    if (r.error) {
      yield { type: "error", code: r.error, message: r.error, retryable: false };
      return;
    }
    for (const chunk of (r.text ?? "").match(/[\s\S]{1,4000}/g) ?? [])
      yield { type: "text_delta", text: chunk };
    yield {
      type: "message_end",
      stop_reason: r.stopReason ?? "end_turn",
      usage: {
        input_tokens: 1000,
        output_tokens: Math.ceil((r.text ?? "").length / 4),
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

/** A small valid proposal in the asked shape. */
function proposal(over: { plan?: unknown; docs?: unknown; firstSession?: unknown } = {}) {
  const base = {
    plan: {
      reason: "A small static page.",
      milestones: [
        {
          name: "Working page",
          successCriteria: ["Opening index.html shows a quote"],
          targetDate: null,
          tasks: [
            {
              key: "build",
              title: "Build the quote page",
              outcome: "index.html shows a random quote",
              acceptanceCriteria: ["index.html exists"],
              priority: "high",
              dependsOn: [],
              specialist: "coder",
            },
          ],
        },
      ],
      tasks: [],
    },
    docs: {
      "README.md": "# Quotes\n\nOpen index.html.\n",
      "docs/decisions/0001-static-page.md":
        "# 0001: Static page\n\nDecision: plain HTML, CSS and JavaScript, no build step.\n",
    },
    firstSession: { summary: "Build it.", items: [{ key: "build", estimateUsdMicro: 300_000 }] },
  };
  return { ...base, ...over } as typeof base;
}

describe("the intake reads the real model's replies (live check of 2026-11-01)", () => {
  it("every live reply parses: a long reason is shortened at a sentence, a reply with fenced docs is read whole", () => {
    expect(LIVE.map((r) => r.line)).toEqual([1, 3, 22, 23, 24, 25]);
    for (const r of LIVE) {
      const { proposal: p, shortened } = readIntakeReply(r.reply_text);
      const raw = JSON.parse(r.reply_text) as { plan: { reason: string } };
      expect(p.plan.reason.length, `line ${r.line}`).toBeLessThanOrEqual(500);
      if (raw.plan.reason.length > 500) {
        // Whole sentences, then " …": never cut mid-word, never refused.
        expect(p.plan.reason, `line ${r.line}`).toMatch(/[.!?] …$/);
        expect(raw.plan.reason.startsWith(p.plan.reason.slice(0, -2))).toBe(true);
        expect(
          shortened.some((s) => s.startsWith("plan.reason")),
          `line ${r.line}`,
        ).toBe(true);
      } else {
        expect(p.plan.reason).toBe(raw.plan.reason);
      }
      // The docs are taken whole, code fences and all.
      expect(Object.keys(p.docs).length, `line ${r.line}`).toBeGreaterThan(5);
    }
    // Lines 23 and 25 hold code fences inside their docs: the old reader took the first fence
    // anywhere and refused them as "not JSON".
    for (const line of [23, 25]) {
      expect(live(line).reply_text).toContain("```");
      const p = parseIntakeReply(live(line).reply_text);
      const docs = Object.values(p.docs).join("\n");
      expect(docs).toContain("```");
      expect(p.plan.milestones.length).toBe(3);
    }
  });

  it("a fenced reply with a prose line around it, and a reply in braces after a prose line, are read", () => {
    const text = live(23).reply_text;
    expect(
      parseIntakeReply(`Here is the plan:\n\`\`\`json\n${text}\n\`\`\`\nTell me what to change.`)
        .plan.milestones,
    ).toHaveLength(3);
    expect(
      parseIntakeReply(`Here is the plan.\n${text}\nThat is all.`).plan.milestones,
    ).toHaveLength(3);
    // A reply of only a doc's snippet is still not a plan.
    expect(() => parseIntakeReply('```json\n[{ "text": "a quote" }]\n```')).toThrow(
      /not a JSON object/,
    );
  });

  it("prose is shortened at a sentence or a word with an ellipsis; identifiers and counts are still refused", () => {
    const sentences = "One sentence here. Another one follows. ".repeat(20);
    const s = shortenProse(sentences, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s).toMatch(/follows\. …$|here\. …$/);
    const words = `${"word ".repeat(60)}end`;
    const w = shortenProse(words, 50);
    expect(w.length).toBeLessThanOrEqual(50);
    expect(w).toMatch(/word…$/);
    expect(shortenProse("short", 50)).toBe("short");
    // A title over 200 characters is shortened, a milestone name too.
    const long = proposal();
    const task = (long.plan.milestones[0] as { tasks: { title: string }[] }).tasks[0] as {
      title: string;
    };
    task.title = `Build the page ${"and make it nicer ".repeat(20)}`;
    (long.plan.milestones[0] as { name: string }).name = "M ".repeat(150);
    const p = parseIntakeReply(JSON.stringify(long));
    expect(p.plan.milestones[0]?.tasks[0]?.title.length).toBeLessThanOrEqual(200);
    expect(p.plan.milestones[0]?.tasks[0]?.title).toMatch(/…$/);
    expect(p.plan.milestones[0]?.name.length).toBeLessThanOrEqual(200);
    // A key is an identifier other tasks name: shortening it could join two tasks. Refused.
    const badKey = proposal();
    const t0 = (badKey.plan.milestones[0] as { tasks: { key: string }[] }).tasks[0] as {
      key: string;
    };
    t0.key = "k".repeat(81);
    (badKey.firstSession as { items: { key: string }[] }).items[0] = {
      key: "k".repeat(81),
      estimateUsdMicro: 1,
    } as never;
    expect(() => parseIntakeReply(JSON.stringify(badKey))).toThrow(/key/);
    // A doc over 40,000 characters is cut at a paragraph, a code fence it cut inside closed.
    const doc = `# Long\n\n${"A paragraph of text.\n\n".repeat(1500)}\`\`\`bash\n${"echo hi\n".repeat(3000)}\`\`\`\n`;
    const d = shortenDoc(doc);
    expect(d.length).toBeLessThanOrEqual(40_000);
    expect(d).toContain("_(Shortened to fit; the rest was left out.)_");
    expect((d.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it("a short brief asks for a small plan; a long brief or a list does not", () => {
    expect(isShortBrief("A page that shows a random quote")).toBe(true);
    expect(
      isShortBrief(
        "A one-page website that shows a random quote each time it is opened; plain HTML, CSS and JavaScript; no build step",
      ),
    ).toBe(true);
    expect(isShortBrief("")).toBe(false);
    expect(isShortBrief(undefined)).toBe(false);
    expect(isShortBrief("A shop.\n- cart\n- checkout")).toBe(false);
    expect(isShortBrief("x".repeat(200))).toBe(false);
  });
});

describe("the intake through the daemon: live replies become plan cards, a bad reply is asked for once more", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-11-01T22:30:00Z");
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
  let n = 0;
  const createProject = async (brief: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: `Quote page ${n}`, goal: "A random quote", brief, ...extra }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as {
      id: string;
      smallProjectMode?: boolean;
      defaultRiskTier?: number;
    };
  };
  /** The plan card of a project as the Inbox shows it (`GET /inbox`, what the UI reads). */
  const planCard = async (projectId: string) => {
    const inbox = (await json(await req("/inbox"))) as {
      requests: { projectId: string | null; status: string; title?: string | null }[];
    };
    const open = inbox.requests.filter((r) => r.projectId === projectId && r.status === "open");
    expect(open, "one plan card in the Inbox").toHaveLength(1);
    return open[0] as { title?: string | null };
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-intake-live-"));
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
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /**
   * The live replies were asked for with "Small-project mode: off": a brief with a list asks
   * for a plan of what the brief needs, as that request did, so each reply is read as it was
   * sent. (A short brief's request asks for a small plan, and a bigger reply is asked for once
   * more: below.)
   */
  const LIST_BRIEF = [
    "A one-page website that shows a random quote each time it is opened:",
    "- plain HTML, CSS and JavaScript",
    "- no build step",
  ].join("\n");

  for (const line of [1, 22, 24, 25]) {
    it(`live reply ${line} (refused live) becomes a plan card on the first call`, async () => {
      const project = await createProject(LIST_BRIEF);
      provider.queue.push({ text: live(line).reply_text });
      const before = provider.calls.length;
      const res = await req(`/projects/${project.id}/intake`, { method: "POST", body: "{}" });
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(202);
      expect(provider.calls.length - before).toBe(1);
      const card = await planCard(project.id);
      expect(card.title).toMatch(/^Plan for "Quote page \d+": \d+ tasks$/);
      expect(await json(await req(`/projects/${project.id}/intake`))).toMatchObject({
        state: "pending",
      });
    });
  }

  it("an approved live plan whose reason was too long writes its tasks with the shortened reason", async () => {
    const project = await createProject(LIST_BRIEF);
    provider.queue.push({ text: live(22).reply_text });
    const res = await req(`/projects/${project.id}/intake`, { method: "POST", body: "{}" });
    expect(res.status).toBe(202);
    const [row] = await rt.store.humanRequest.open({
      humanId: rt.human.id,
      projectId: project.id,
    });
    if (!row) throw new Error("no plan card");
    expect((row.change_card as JsonObject).shortened).toEqual([
      expect.stringMatching(/^plan\.reason \(754 -> \d{3}\)$/),
    ]);
    const answered = await req(`/requests/${row.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: row.version, answer: "Approve and start" }),
    });
    expect(answered.status).toBe(200);
    const tasks = await rt.store.task.list({ project_id: project.id } as never);
    expect(tasks.length).toBe(5);
    // The person task's reason becomes its Inbox card's once filed; every other keeps the plan's.
    for (const t of tasks.filter((x) => x.specialist !== "person")) {
      expect(t.reason.length).toBeLessThanOrEqual(500);
      expect(t.reason).toMatch(/^The brief is one line: a page that shows a random quote\./);
      expect(t.reason).toMatch(/ …$/);
    }
  });

  it("a reply that does not validate is asked for once more, with the problems in words, and its plan lands as the card", async () => {
    const project = await createProject("A page that shows a random quote");
    // The first reply has no tasks; the second is a plan.
    provider.queue.push(
      { text: JSON.stringify(proposal({ plan: { reason: "r", milestones: [], tasks: [] } })) },
      { text: JSON.stringify(proposal()) },
    );
    const before = provider.calls.length;
    const res = await req(`/projects/${project.id}/intake`, { method: "POST", body: "{}" });
    expect(res.status).toBe(202);
    expect(provider.calls.length - before).toBe(2);
    const retry = provider.calls.at(-1) as ModelRequest;
    // The same conversation: the brief, the model's own reply, then what is wrong with it.
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1]?.role).toBe("assistant");
    const told = String(retry.messages[2]?.content);
    expect(told).toContain("Forerunner could not use your reply:");
    expect(told).toContain("- plan: the plan names no milestone and no task");
    expect(told).toContain("Reply again with the whole JSON object");
    // The person sees one plan card; both calls are paid and each has its Run row.
    const card = await planCard(project.id);
    expect(card.title).toMatch(/: 1 task$/);
    const change = (
      await rt.store.humanRequest.open({ humanId: rt.human.id, projectId: project.id })
    )[0]?.change_card as JsonObject;
    expect(change.model_calls).toBe(2);
    const sessionId = String(change.session_id);
    const runs = await rt.store.run.list({ session_id: sessionId } as never);
    expect(runs.map((r) => r.id).sort()).toEqual([`intake_${sessionId}`, `intake_${sessionId}_2`]);
    expect(change.cost_usd_micro).toBe(runs.reduce((s, r) => s + r.cost_usd_micro, 0));
    expect(Number(change.cost_usd_micro)).toBeGreaterThan(0);
    expect((await rt.store.session.mustGet(sessionId)).status).toBe("completed");
  });

  it("a dependency cycle is a reply problem too: asked for once more", async () => {
    const project = await createProject("A page that shows a random quote");
    const cyclic = proposal();
    const tasks = (cyclic.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks;
    tasks.push({
      key: "test",
      title: "Test the page",
      outcome: "a check passes",
      dependsOn: ["build"],
      specialist: "tester",
    });
    (tasks[0] as { dependsOn: string[] }).dependsOn = ["test"];
    provider.queue.push({ text: JSON.stringify(cyclic) }, { text: JSON.stringify(proposal()) });
    const res = await req(`/projects/${project.id}/intake`, { method: "POST", body: "{}" });
    expect(res.status).toBe(202);
    expect(String((provider.calls.at(-1) as ModelRequest).messages[2]?.content)).toMatch(
      /- plan: plan dependencies form a cycle: .*build.*test.*build/,
    );
  });

  /** A failed background intake as the project page reads it (`GET /projects/:id/intake`). */
  const failedWith = async (replies: Planned[]) => {
    const project = await createProject("A page that shows a random quote", { intake: true });
    provider.queue.push(...replies);
    await rt.intake.inFlight(project.id)?.catch(() => undefined);
    const status = await json(await req(`/projects/${project.id}/intake`));
    expect(status.state).toBe("failed");
    return String(status.error);
  };

  it("the person reads the real cause after the second try: not readable, missing its tasks, cut off", async () => {
    const before = provider.calls.length;
    expect(
      await failedWith([
        { text: "Sure! First the page, then a test." },
        { text: "Still no JSON." },
      ]),
    ).toBe("Claude's plan could not be read. Forerunner asked Claude twice.");
    expect(provider.calls.length - before).toBe(2);
    const empty = JSON.stringify(proposal({ plan: { reason: "r", milestones: [], tasks: [] } }));
    expect(await failedWith([{ text: empty }, { text: empty }])).toBe(
      "Claude's plan was missing its tasks. Forerunner asked Claude twice.",
    );
    const half = JSON.stringify(proposal()).slice(0, 200);
    expect(
      await failedWith([
        { text: half, stopReason: "max_tokens" },
        { text: half, stopReason: "max_tokens" },
      ]),
    ).toBe("Claude's plan was cut off before it ended. Forerunner asked Claude twice.");
    // The retry after a cut-off reply asks for shorter docs.
    expect(String((provider.calls.at(-1) as ModelRequest).messages[2]?.content)).toContain(
      "cut off at the output limit",
    );
    // Never "missing parts" for a reply that had them all.
    const missing = proposal();
    (missing.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks[0] = {
      key: "build",
      title: "Build the quote page",
      priority: "high",
    };
    expect(
      await failedWith([{ text: JSON.stringify(missing) }, { text: JSON.stringify(missing) }]),
    ).toBe("Claude's plan was missing a task's outcome. Forerunner asked Claude twice.");
    // Plain words (design §5.6): no JSON key names, no plan-internal words, and a number is
    // never "too short".
    const twice = async (bad: unknown) =>
      failedWith([{ text: JSON.stringify(bad) }, { text: JSON.stringify(bad) }]);
    expect(await twice({ ...proposal(), notes: "extra" })).toBe(
      "Claude's plan had parts Forerunner does not know. Forerunner asked Claude twice.",
    );
    const dup = proposal();
    const dupTasks = (dup.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks;
    dupTasks.push({ ...dupTasks[0], title: "Build it again" });
    expect(await twice(dup)).toBe(
      "Claude's plan listed the same task twice. Forerunner asked Claude twice.",
    );
    const tier = proposal();
    (tier.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks[0] = {
      ...(tier.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks[0],
      riskTier: -1,
    };
    expect(await twice(tier)).toBe(
      "Claude's plan had a task's review level out of range. Forerunner asked Claude twice.",
    );
    const emptyCheck = proposal();
    (emptyCheck.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks[0] = {
      ...(emptyCheck.plan.milestones[0] as { tasks: Record<string, unknown>[] }).tasks[0],
      acceptanceCriteria: [""],
    };
    expect(await twice(emptyCheck)).toBe(
      "Claude's plan left one of a task's checks empty. Forerunner asked Claude twice.",
    );
  });

  it("a call that did not answer is not repeated and says so; the usage limit says to wait for the reset", async () => {
    let before = provider.calls.length;
    expect(await failedWith([{ error: "overloaded_error" }])).toBe(
      "Claude did not answer (model call failed).",
    );
    expect(provider.calls.length - before).toBe(1);
    before = provider.calls.length;
    expect(await failedWith([{ error: "provider_usage_limit" }])).toBe(
      "Your Claude usage limit is reached. Try again once it resets.",
    );
    expect(provider.calls.length - before).toBe(1);
  });

  it("a one-line brief asks for a small plan and keeps the critic: not small-project mode, the approved build task is written at tier 1; a long brief asks for what it needs", async () => {
    const short = await createProject("A page that shows a random quote");
    // The owner's decision of 2026-11-01: the critic always reviews code tasks. Small-project
    // mode gives a task that names no tier tier 0 (checks only, no critic), so a short brief
    // asks the planner for a small plan without turning the mode on (ADR 0103).
    expect(short.smallProjectMode).toBe(false);
    expect(short.defaultRiskTier).toBe(1);
    provider.queue.push({ text: JSON.stringify(proposal()) });
    expect((await req(`/projects/${short.id}/intake`, { method: "POST", body: "{}" })).status).toBe(
      202,
    );
    const sent = provider.calls.at(-1) as ModelRequest;
    const user = String(sent.messages[0]?.content);
    expect(user).toContain("Plan size: small (a short brief: see Size in your instructions)");
    expect(user).not.toContain("Small-project mode");
    expect(user).toContain("<<<BRIEF\nA page that shows a random quote");
    // The instructions say what a small plan is, and every limit the reader enforces.
    const system = sent.system ?? "";
    expect(system).toContain('Size. With "Plan size: small"');
    expect(system).toContain("one milestone with one to three tasks");
    expect(system).toContain("No reviewer, deploy (ops-deploy), marketing (writer-marketing)");
    expect(system).toContain(
      "Leave riskTier out: Forerunner's critic reviews every task that builds or changes files.",
    );
    expect(system).toContain("docs: only README.md and the decision record");
    expect(system).toContain("plan.reason: at most 500 characters");
    expect(system).toContain("A task title: at most 200 characters");
    expect(system).toContain("key: at most 80 characters");
    expect(system).toContain("At most 20 milestones and 200 tasks");
    expect(system).toContain(
      'A question for the person: one sentence ending with "?", at most 500 characters; at most 10 per task.',
    );
    expect(system).toContain(
      "firstSession.summary: at most 1000 characters; an item's rationale: at most 500.",
    );
    expect(system).toContain("A doc: at most 40000 characters");
    // The decision line the card shows, and estimates for every task.
    expect(system).toContain('"Decision: " and the choice in one or two sentences');
    expect(system).toContain("firstSession.items lists every task a specialist does");
    // The planner never asks a specialist to commit: Forerunner does (live: the coder could not).
    expect(system).toContain("Forerunner commits each");
    expect(system).toContain("never asks a specialist to commit, push or open a pull request");
    // Live (live2 #14) the plan asked the person where the files live and whether to use git:
    // Forerunner decides both, and the planner is told so.
    expect(system).toContain(
      "Forerunner decides where the files live (the project's folder on this computer, or the\nlinked repository) and keeps their history in git: never ask the person where files go or\nwhether to use version control, and plan no task for it.",
    );
    // Approved, the build task is written at tier 1 (light review): the critic reviews it.
    const [row] = await rt.store.humanRequest.open({ humanId: rt.human.id, projectId: short.id });
    if (!row) throw new Error("no plan card");
    const answered = await req(`/requests/${row.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: row.version, answer: "Approve and start" }),
    });
    expect(answered.status).toBe(200);
    const written = (await (await req(`/projects/${short.id}/tasks`)).json()) as {
      title: string;
      specialist: string | null;
      riskTier: number;
    }[];
    expect(written.map((t) => [t.title, t.specialist, t.riskTier])).toEqual([
      ["Build the quote page", "coder", 1],
    ]);
    // A long brief with a list of features asks for the plan the brief needs.
    const longBrief = [
      "A quotes website for our book club.",
      "- a page that shows a random quote",
      "- a form to add quotes",
      "- a list of all quotes with search",
      "- hosted on our own server",
    ].join("\n");
    const big = await createProject(longBrief);
    expect(big.smallProjectMode).toBe(false);
    provider.queue.push({ text: JSON.stringify(proposal()) });
    expect((await req(`/projects/${big.id}/intake`, { method: "POST", body: "{}" })).status).toBe(
      202,
    );
    expect(String((provider.calls.at(-1) as ModelRequest).messages[0]?.content)).toContain(
      "Plan size: what the brief needs",
    );
  });

  /** The plan card's task count as `GET /inbox` serves its title ("…: 6 tasks"). */
  const cardTasks = async (projectId: string) =>
    Number(/: (\d+) tasks?$/.exec(String((await planCard(projectId)).title))?.[1]);
  const draft = async (projectId: string) => {
    const before = provider.calls.length;
    const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(202);
    return provider.calls.length - before;
  };

  it("a short brief's plan that comes back bigger than a small plan is asked for once more; the second reply stands whatever its size", async () => {
    // Live reply 23: six tasks over three milestones for the brief "A page that shows a random
    // quote" (with "Small-project mode: off" then). Asked for a small plan, the same reply is
    // asked for once more with its size in words; the smaller second plan is the card.
    const p1 = await createProject("A page that shows a random quote");
    provider.queue.push({ text: live(23).reply_text }, { text: JSON.stringify(proposal()) });
    expect(await draft(p1.id)).toBe(2);
    const told = String((provider.calls.at(-1) as ModelRequest).messages[2]?.content);
    expect(told).toContain("Forerunner could not use your reply:");
    expect(told).toContain(
      '- Your plan has 6 tasks in 3 milestones, but "Plan size: small" asks for one milestone with one to three tasks.',
    );
    expect(await cardTasks(p1.id)).toBe(1);
    const change = (await rt.store.humanRequest.open({ humanId: rt.human.id, projectId: p1.id }))[0]
      ?.change_card as JsonObject;
    expect(change.model_calls).toBe(2);
    // Asked once only: a second reply as big is the plan the person reads.
    const p2 = await createProject("A page that shows a random quote");
    provider.queue.push({ text: live(23).reply_text }, { text: live(25).reply_text });
    expect(await draft(p2.id)).toBe(2);
    expect(await cardTasks(p2.id)).toBe(5);
    // Its size never costs the person the plan: a second reply that cannot be read, or a second
    // call that fails, leaves the first plan as the card.
    const p3 = await createProject("A page that shows a random quote");
    provider.queue.push(
      { text: live(23).reply_text },
      { text: "Here is a smaller plan: build it." },
    );
    expect(await draft(p3.id)).toBe(2);
    expect(await cardTasks(p3.id)).toBe(6);
    const p4 = await createProject("A page that shows a random quote");
    provider.queue.push({ text: live(23).reply_text }, { error: "overloaded_error" });
    expect(await draft(p4.id)).toBe(2);
    expect(await cardTasks(p4.id)).toBe(6);
    // A plan within the size, and any plan for a brief with a list, is taken on the first call.
    const p5 = await createProject("A page that shows a random quote");
    provider.queue.push({ text: JSON.stringify(proposal()) });
    expect(await draft(p5.id)).toBe(1);
    const p6 = await createProject(LIST_BRIEF);
    provider.queue.push({ text: live(23).reply_text });
    expect(await draft(p6.id)).toBe(1);
    expect(await cardTasks(p6.id)).toBe(6);
  });

  it("a plan the person asked to change is never cut down for its size: their change may add tasks", async () => {
    const project = await createProject("A page that shows a random quote");
    provider.queue.push({ text: JSON.stringify(proposal()) });
    expect(await draft(project.id)).toBe(1);
    const [row] = await rt.store.humanRequest.open({
      humanId: rt.human.id,
      projectId: project.id,
    });
    if (!row) throw new Error("no plan card");
    const before = provider.calls.length;
    provider.queue.push({ text: live(23).reply_text });
    const answered = await req(`/requests/${row.id}/answer`, {
      method: "POST",
      body: JSON.stringify({
        version: row.version,
        answer: {
          choice: "Change the plan",
          text: "Add a deploy, a review and the quote list as tasks.",
        },
      }),
    });
    expect(answered.status).toBe(200);
    await rt.intake.inFlight(project.id);
    expect(provider.calls.length - before).toBe(1);
    expect(String((provider.calls.at(-1) as ModelRequest).messages[0]?.content)).toContain(
      "Add a deploy, a review and the quote list as tasks.",
    );
    expect(await cardTasks(project.id)).toBe(6);
  });
});
