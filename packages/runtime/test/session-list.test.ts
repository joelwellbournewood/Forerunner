import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { SessionRow } from "@forerunner/state";
import { errorReply, FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { WRAP_UP_MARK } from "../src/agent/loop.ts";
import type { ProjectSessionsView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  countsWords,
  GIST_MAX,
  planningGist,
  resultTextNow,
  type SessionRecord,
  sessionEndWords,
  sessionGist,
  spentWords,
  startedByWords,
} from "../src/daemon/session-list.ts";
import type { ChatMessage, ModelRequest } from "../src/provider/types.ts";
import { sessionResultLines } from "../src/session/result.ts";
import { planningStatusText, sessionStatusText } from "../src/session/stop-words.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * A project lists its sessions (the owner's decision D2 of 2026-11-09, d1109-sessions, ADR
 * 0116): what each did, spent and how it ended. The words are the daemon's, one sentence each,
 * at most 100 characters, no id, no "intake", no USD (design §5).
 */
const task = (title: string, id = title.toLowerCase().replace(/\W+/g, "-")) => ({ id, title });
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  done: [],
  failed: [],
  paused: [],
  needsYou: [],
  cancelled: [],
  leftForYou: 0,
  ...over,
});
const plain = (s: string) => {
  expect(s.length).toBeLessThanOrEqual(GIST_MAX);
  expect(s).not.toMatch(/intake|USD|\b[0-9a-f]{8}-[0-9a-f]{4}-/i);
  return s;
};

describe("d1109-sessions, run C: the words of the Sessions list (SL-3)", () => {
  it("sessionGist says what a session did in one sentence", () => {
    expect(
      plain(
        sessionGist(
          record({
            done: [task("Create index.html"), task("Style the page"), task("Add the README")],
          }),
        ),
      ),
    ).toBe('Did 3 tasks: "Create index.html", "Style the page" and "Add the README".');
    expect(
      plain(sessionGist(record({ done: ["A", "B", "C", "D", "E"].map((t) => task(t)) }))),
    ).toBe('Did 5 tasks: "A", "B", "C" and 2 more.');
    expect(
      plain(
        sessionGist(
          record({ paused: [{ ...task("Long report"), limit: "its budget of CHF 0.40" }] }),
        ),
      ),
    ).toBe('"Long report" paused at its budget of CHF 0.40.');
    expect(plain(sessionGist(record({ failed: [task("Write the scope")] })))).toBe(
      '"Write the scope" failed.',
    );
    expect(
      plain(sessionGist(record({ needsYou: [task("Decide where the page is published")] }))),
    ).toBe('"Decide where the page is published" needed your answer.');
    expect(plain(sessionGist(record({ cancelled: [task("Draft the FAQ")] })))).toBe(
      'You cancelled "Draft the FAQ"; nothing else ran.',
    );
    expect(plain(sessionGist(record()))).toBe("Nothing finished.");
    expect(plain(sessionGist(record({ leftForYou: 2 })))).toBe("Nothing finished.");
  });

  it("a long title is shortened at a word, never past 100 characters and never mid-word", () => {
    const long = [
      "Build the random quote page in index.html, styles.css and script.js with a fallback",
      "Check that index.html, styles.css and script.js work together in every browser",
      "Write the README with how to open the page and how to change the quotes",
    ];
    const s = plain(sessionGist(record({ done: long.map((t) => task(t)) })));
    expect(s.startsWith("Did 3 tasks: ")).toBe(true);
    expect(s.endsWith(".")).toBe(true);
    expect(s).toMatch(/…"/);
    const one = plain(sessionGist(record({ failed: [task(long[0] as string)] })));
    expect(one).toBe('"Build the random quote page in index.html, styles.css and…" failed.');
  });

  it("countsWords names only the counts that happened", () => {
    expect(
      countsWords({ done: 2, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 }),
    ).toBe("2 done");
    expect(
      countsWords({ done: 1, failed: 1, paused: 1, needsYou: 1, cancelled: 1, leftForYou: 0 }),
    ).toBe("1 done, 1 failed, 1 paused, 1 needed you, 1 cancelled");
    expect(
      countsWords({ done: 1, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 2 }),
    ).toBe("1 done, 2 left for you");
    expect(
      countsWords({ done: 0, failed: 0, paused: 0, needsYou: 0, cancelled: 0, leftForYou: 0 }),
    ).toBe("");
  });

  it("planningGist says what became of a plan, never the row's stored 'intake:' text", () => {
    const drafted = { state: "drafted" as const, tasks: 5 };
    expect(plain(planningGist({ ...drafted, fate: "waits" }))).toBe(
      "Drafted a plan of 5 tasks; it waits for your approval.",
    );
    expect(plain(planningGist({ ...drafted, fate: "approved" }))).toBe(
      "Drafted a plan of 5 tasks; you approved it.",
    );
    expect(plain(planningGist({ ...drafted, fate: "changed" }))).toBe(
      "Drafted a plan of 5 tasks; you asked for changes.",
    );
    expect(plain(planningGist({ ...drafted, fate: "rejected" }))).toBe(
      "Drafted a plan of 5 tasks; you rejected it.",
    );
    expect(plain(planningGist({ state: "drafted", tasks: 1, fate: null }))).toBe(
      "Drafted a plan of 1 task.",
    );
    expect(
      plain(planningGist({ state: "failed", failure: "Claude did not answer (network)." })),
    ).toBe("Planning failed: Claude did not answer (network).");
    expect(plain(planningGist({ state: "failed" }))).toBe("Planning failed.");
    expect(plain(planningGist({ state: "drafting" }))).toBe("Drafting the plan…");
    expect(planningStatusText("running")).toBe("Drafting the plan");
    expect(planningStatusText("completed")).toBe("Plan drafted");
    expect(planningStatusText("failed")).toBe("Planning failed");
  });

  it("spentWords gives the one figure and which credential paid it", () => {
    expect(spentWords({ chfMicro: 800_000, kinds: ["api_key"] })).toBe("CHF 0.80 on your API key");
    expect(spentWords({ chfMicro: 800_000, kinds: ["subscription"] })).toBe(
      "CHF 0.80 of your Claude subscription's allowance",
    );
    expect(spentWords({ chfMicro: 800_000, kinds: ["plan_credits"] })).toBe(
      "CHF 0.80 of your plan credits",
    );
    expect(spentWords({ chfMicro: 800_000, kinds: ["subscription", "api_key"] })).toBe(
      "CHF 0.80 on your API key and your Claude subscription",
    );
    expect(spentWords({ chfMicro: 3_000, kinds: ["api_key"] })).toBe(
      "less than CHF 0.01 on your API key",
    );
    expect(spentWords({ chfMicro: 50_000, kinds: ["fake"] })).toBe("CHF 0.05");
    expect(spentWords({ chfMicro: 50_000 })).toBe("CHF 0.05");
    expect(spentWords({ chfMicro: 400_000, kinds: ["api_key"] }, { working: true })).toBe(
      "CHF 0.40 so far on your API key",
    );
  });

  it("an ended session's status stays true later: past tense for the two waits (one map)", () => {
    expect(sessionStatusText("stopped", "credential_wait")).toBe(
      "Stopped to wait for a Claude credential",
    );
    expect(sessionStatusText("stopped", "plan_awaiting_approval")).toBe(
      "Ended with a plan for you to approve",
    );
    const row = (status: string, stop: string) =>
      ({ status, handoff: { stop_reason: stop }, plan: {} }) as unknown as SessionRow;
    expect(sessionEndWords(row("stopped", "credential_wait"))).toBe(
      "Stopped to wait for a Claude credential",
    );
    expect(sessionEndWords(row("stopped", "plan_awaiting_approval"))).toBe(
      "Ended with a plan for you to approve",
    );
    expect(sessionEndWords(row("stopped", "you"))).toBe("Stopped by you");
    expect(sessionEndWords(row("stopped", "interrupted"))).toBe("Interrupted: Forerunner closed");
    expect(sessionEndWords(row("running", "completed"))).toBeNull();
    // A planning call says how it ended only when it failed.
    const planning = (status: string) =>
      ({ status, handoff: {}, plan: { intake: { x: 1 } } }) as unknown as SessionRow;
    expect(sessionEndWords(planning("completed"))).toBeNull();
    expect(sessionEndWords(planning("failed"))).toBe("Planning failed");
  });

  it("startedByWords reads who asked first, then the trigger; a plain or prepared start says nothing", () => {
    expect(startedByWords({ plan: {}, trigger: "schedule" })).toBe("started on its schedule");
    expect(startedByWords({ plan: {}, trigger: "remote" })).toBe("started from your phone");
    expect(startedByWords({ plan: {}, trigger: "pr_comment" })).toBe(
      "started by a pull request comment",
    );
    expect(startedByWords({ plan: {}, trigger: "ci" })).toBe("started by CI");
    expect(startedByWords({ plan: { startedBy: { by: "schedule" } }, trigger: "manual" })).toBe(
      "started on its schedule",
    );
    expect(startedByWords({ plan: { startedBy: { by: "person" } }, trigger: "remote" })).toBe(
      "started from your phone",
    );
    expect(startedByWords({ plan: { startedBy: { by: "person" } }, trigger: "manual" })).toBeNull();
    for (const trigger of ["manual", "message", "budget_reset"])
      expect(startedByWords({ plan: {}, trigger: trigger as never })).toBeNull();
  });

  it("resultTextNow replaces only the result's own cost sentence; other text is shown as stored", () => {
    const outcome = {
      done: [task("A")],
      failed: [],
      needsYou: [],
      leftOver: [],
      waiting: [],
      waitingForDocker: [],
      stopReason: "completed",
      spentChfMicro: 40_000,
    };
    const text = sessionResultLines({
      outcome,
      inReview: [],
      leftOutForBudget: [],
      sessionCapChfMicro: 4_000_000,
      openTasks: 0,
    }).join("\n");
    expect(text).toBe('Did 1 task: "A".\nNothing left. CHF 0.04.');
    expect(resultTextNow(text, outcome, 50_000)).toBe('Did 1 task: "A".\nNothing left. CHF 0.05.');
    expect(resultTextNow(text, outcome, 3_000)).toBe(
      'Did 1 task: "A".\nNothing left. Less than CHF 0.01.',
    );
    expect(resultTextNow(text, outcome, 40_000)).toBe(text);
    // A row from before run C (no stored outcome) or a text without that sentence: as stored.
    expect(resultTextNow(text, null, 50_000)).toBe(text);
    expect(resultTextNow("Did 1 task. Spent CHF 0.04 in all.", outcome, 50_000)).toBe(
      "Did 1 task. Spent CHF 0.04 in all.",
    );
    // The sentence alone on its line.
    expect(resultTextNow("Stopped by you.\nCHF 0.04.", outcome, 90_000)).toBe(
      "Stopped by you.\nCHF 0.09.",
    );
  });
});

// --- Composed runtime: the record of each session, across a restart (SL-1, SL-6) -------------

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const coderOn = (title: string) => (req: ModelRequest) =>
  (req.origin?.label ?? "").startsWith(`coder on ${title}`);
const textOf = (m: ChatMessage) =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
const heardWrapUp = (req: ModelRequest) =>
  req.messages.some((m) => m.role === "user" && textOf(m).includes(WRAP_UP_MARK));
const LEFT =
  "Summary: wrote the first parts.\n\nWhere I stopped: the first two sections are written.\n\nLeft to do:\n- write the last section\n- check the links";

/** A gate a test opens: a held model call waits on it. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

function provider(clock: SimulatedClock, held: { promise: Promise<void> }) {
  const fake = new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      textReply("Wrote a.html.\n\nLeft to do: nothing", {
        when: coderOn("Write A"),
        times: Number.POSITIVE_INFINITY,
      }),
      errorReply("server_error", "the model call failed", {
        when: coderOn("Write B"),
        times: Number.POSITIVE_INFINITY,
        retryable: false,
      }),
      textReply(LEFT, {
        when: (r: ModelRequest) => coderOn("Long report")(r) && heardWrapUp(r),
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 1_000, output_tokens: 50 },
      }),
      toolReply("list_dir", { path: "." }, "Working on the next part.", {
        when: coderOn("Long report"),
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 30_000, output_tokens: 10 },
      }),
      textReply("Wrote d.html.\n\nLeft to do: nothing", {
        when: coderOn("Write D"),
        times: Number.POSITIVE_INFINITY,
      }),
    ],
  });
  const stream = fake.stream.bind(fake);
  fake.stream = (req) => {
    if (!coderOn("Write D")(req)) return stream(req);
    return (async function* () {
      await held.promise;
      yield* stream(req);
    })();
  };
  return fake;
}

async function compose(
  home: string,
  clock: SimulatedClock,
  fake: FakeProvider,
  opts: { recover?: boolean } = {},
) {
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
    startServices: false,
    ...(opts.recover !== undefined ? { recoverSessions: opts.recover } : {}),
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = async <T = Json>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json()) as T;
    if (res.status >= 400) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  return { rt, req };
}

/** Polls in real time (at least 20 s); the error says what was seen last. */
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

const ENDED = ["completed", "stopped", "failed", "killed"];

describe("d1109-sessions, run C: each session's record survives a restart (SL-1)", () => {
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened.splice(0)) await rt.close().catch(() => undefined);
  });

  it("a done, failed and paused session and one you stopped read the same after the runtime is composed again", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-session-list-"));
    const clock = new SimulatedClock("2026-11-09T09:00:00Z");
    const held = gate();
    const fake = provider(clock, held);
    const first = await compose(home, clock, fake);
    opened.push(first.rt);
    const { rt, req } = first;
    const project = await req<Json>("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Club pages", goal: "Pages for the club" }),
    });
    const projectId = String(project.id);
    const addTask = (title: string, budgetUsdMicro = 0) =>
      req<Json>(`/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title,
          outcome: `${title} is written`,
          acceptanceCriteria: ["the file exists"],
          priority: "medium",
          status: "ready",
          dependsOn: [],
          budgetUsdMicro,
          specialist: "coder",
          riskTier: 1,
        }),
      });
    const a = await addTask("Write A");
    await addTask("Write B");
    // CHF 0.40 at the fake rate of 0.8.
    await addTask("Long report", 500_000);
    const start = async () => {
      const started = await req<Json>("/sessions", {
        method: "POST",
        body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
      });
      return String((started.session as Json).id);
    };
    const ended = (id: string) =>
      waitFor(
        async () => {
          const s = await req<Json>(`/sessions/${id}`);
          return ENDED.includes(String(s.status)) ? s : undefined;
        },
        async () => JSON.stringify(await req<Json>(`/sessions/${id}`)),
      );
    const s1 = await start();
    await ended(s1);
    // S2: a task the person stops before anything finished.
    const d = await addTask("Write D");
    const s2 = await start();
    // Its run has begun (its first model call waits): the person stops it there.
    await waitFor(
      async () => ((await rt.store.run.forSession(s2)).length > 0 ? true : undefined),
      async () => (await rt.store.task.mustGet(String(d.id))).status,
    );
    await req(`/sessions/${s2}/stop`, { method: "POST", body: JSON.stringify({}) });
    held.open();
    await ended(s2);
    // A row written before run C: no outcome, its done and blocked ids only.
    const old = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    await rt.store.run.insert({ session_id: old.id, specialist: "coder", model: "fake" });
    const oldRunning = await rt.store.session.setStatus(old.id, old.version, "running");
    await rt.store.session.setStatus(oldRunning.id, oldRunning.version, "completed", {
      handoff: {
        done: [a.id],
        blocked: ["01a1a212-22e0-7238-a5e3-29879611d909", "01a1a212-22e0-7238-a5e3-29879611d90a"],
        stop_reason: "completed",
      } as never,
    });
    await rt.close();
    opened.length = 0;

    // The same home, composed again: what each row says is what it said.
    const second = await compose(home, clock, fake);
    opened.push(second.rt);
    const list = await second.req<ProjectSessionsView>(`/projects/${projectId}/sessions`);
    expect(list.count).toBe(3);
    expect(list.working).toEqual([]);
    const byId = new Map(list.rows.map((r) => [r.id, r]));
    expect(list.rows.map((r) => r.id)).toEqual([old.id, s2, s1]);
    expect(byId.get(s1)).toMatchObject({
      gist: 'Did 1 task: "Write A".',
      tasks: { done: 1, failed: 1, paused: 1, needsYou: 0, cancelled: 0, leftForYou: 0 },
      countsWords: "1 done, 1 failed, 1 paused",
      endedWords: "Ended: 1 task needs you, 1 paused",
      working: false,
      planning: false,
      startedBy: null,
    });
    expect(byId.get(s2)).toMatchObject({
      gist: "Nothing finished.",
      countsWords: "",
      endedWords: "Stopped by you",
    });
    expect(byId.get(old.id)).toMatchObject({
      gist: 'Did 1 task: "Write A".',
      countsWords: "1 done, 2 left for you",
    });
    // The paused task's own row reads its limit, as its card names it.
    const s1Row = await second.rt.store.session.mustGet(s1);
    const outcome = (s1Row.handoff as { outcome?: { paused?: { limit: string }[] } }).outcome;
    expect(outcome?.paused?.map((p) => p.limit)).toEqual(["its budget of CHF 0.40"]);
    // Never an id, "intake" or USD where a person reads.
    const read = JSON.stringify(
      list.rows.map((r) => [r.gist, r.countsWords, r.endedWords, r.spentWords, r.startedBy]),
    );
    expect(read).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|intake|USD/);
    // One figure per session: the row's and the session page's are the ledger's.
    for (const r of list.rows) {
      const page = await second.req<{ spent: { chfMicro: number } }>(`/sessions/${r.id}`);
      expect(page.spent.chfMicro).toBe(r.spent.chfMicro);
      const booked = await second.rt.store.costLedger.sum({ sessionId: r.id });
      if (booked.entries > 0) expect(r.spent.chfMicro).toBe(booked.chf_micro);
    }
  }, 90_000);
});

describe("d1109-sessions, run C: an interrupted session's length is the time it worked (SL-6)", () => {
  const opened: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of opened.splice(0)) await rt.close().catch(() => undefined);
  });

  it("a session that worked 2 minutes before Forerunner died on Friday reads 2 min after Monday's start", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-session-list-recovery-"));
    const clock = new SimulatedClock("2026-11-06T16:00:00Z");
    const fake = provider(clock, gate());
    const first = await compose(home, clock, fake, { recover: false });
    opened.push(first.rt);
    const { rt } = first;
    const project = await rt.store.project.insert({
      name: "Quote page",
      goal: "A page with a quote",
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
    });
    const done = await rt.store.task.insert({
      project_id: project.id,
      title: "Create the page skeleton",
      outcome: "index.html exists",
      acceptance_criteria: ["index.html exists"],
      risk_tier: 1,
      status: "done",
      priority: 5,
    });
    let session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: project.id,
      trigger: "manual",
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    session = await rt.store.session.start(session.id, session.version);
    await rt.store.event.append(session.id, "session.started", {} as never);
    const run = await rt.store.run.insert({
      task_id: done.id,
      session_id: session.id,
      specialist: "coder",
      model: "fake",
      provider: "fake",
      outcome: "done",
    });
    await rt.store.costLedger.record({
      human_id: rt.human.id,
      agent_id: rt.agent.id,
      project_id: project.id,
      session_id: session.id,
      task_id: done.id,
      run_id: run.id,
      kind: "api",
      usd_micro: 25_000,
      chf_micro: 20_000,
      model: "fake",
    });
    await clock.advance(2 * 60_000);
    await rt.store.event.append(session.id, "task.finished", {
      taskId: done.id,
      title: done.title,
    } as never);
    // The daemon dies here (no end written); three days later it starts again.
    await rt.close();
    opened.length = 0;
    await clock.advance(3 * 24 * 60 * 60_000);
    const second = await compose(home, clock, fake, { recover: true });
    opened.push(second.rt);
    const list = await second.req<ProjectSessionsView>(`/projects/${project.id}/sessions`);
    const row = list.rows.find((r) => r.id === session.id);
    expect(row).toMatchObject({
      durationMs: 2 * 60_000,
      endedWords: "Interrupted: Forerunner closed",
      gist: 'Did 1 task: "Create the page skeleton".',
      countsWords: "1 done",
      spentWords: "CHF 0.02",
    });
    const page = await second.req<{ spent: { chfMicro: number } }>(`/sessions/${session.id}`);
    expect(page.spent.chfMicro).toBe(row?.spent.chfMicro);
    expect(row?.spent.chfMicro).toBe(20_000);
    const summary = await second.req<{ lastSession: { id: string; summary: string } | null }>(
      `/projects/${project.id}/summary`,
    );
    expect(summary.lastSession?.id).toBe(session.id);
    // And after another restart, the same.
    await second.rt.close();
    opened.length = 0;
    const third = await compose(home, clock, fake, { recover: true });
    opened.push(third.rt);
    const again = await third.req<ProjectSessionsView>(`/projects/${project.id}/sessions`);
    expect(again.rows.find((r) => r.id === session.id)).toEqual(row);
  }, 60_000);
});
