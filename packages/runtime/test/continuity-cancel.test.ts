import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
import { fileReviewFailedRequest } from "../src/session/findings.ts";
import { ScriptedProvider, type ScriptReply } from "./helpers.ts";

/**
 * Live walk 2 part 3 (C1, real model, 2026-11-01): "Skip the About page task" in chat, Yes,
 * while "About page" ran: its files stayed (about.html; index.html got a link to it), the critic
 * reviewed and "accepted" the cancelled task ("About page · Cancelled · accepted"), and the
 * next task's README described the cancelled page.
 *
 * Now cancelling a task that runs stops its run at once, takes what it changed out of the
 * project's folder before the next task starts (kept for Undo), and never lets the critic
 * review it, also when the cancel comes while the critic is reviewing; Undo of the cancel puts
 * the files back, also after a restart. The cancel's sentence says so.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const HOUR = 3_600_000;

async function compose(home: string, clock: SimulatedClock, provider: ScriptedProvider) {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault(),
    provider,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: {
      engine: "none",
      problem: "not_installed",
      reason: "test: no engine",
      checkedAt: clock.nowIso(),
    },
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

const write = (path: string, content: string): ScriptReply => ({
  tools: [{ name: "write_file", input: { path, content } }],
});

/** The text of every message of a model call, for what a run was shown. */
const shown = (call: { messages: unknown }) => JSON.stringify(call.messages);

describe("cancelling a task while it runs (live walk 2, C1)", () => {
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-cancel-"));
  // "About page" writes about.html and links it from index.html, then waits (an hour of
  // simulated time that never passes) until something stops it. "Write the README" lists the
  // folder, then reports.
  const provider = new ScriptedProvider(
    [
      write("about.html", "<h1>About the club</h1>\n"),
      write("index.html", '<h1>Garden club</h1>\n<a href="about.html">About</a>\n'),
      { ttftMs: HOUR, text: "never sent" },
      { tools: [{ name: "list_dir", input: { path: "." } }] },
      write("README.md", "# Garden club\n"),
      { text: "Wrote README.md." },
    ],
    clock,
  );
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let aboutId = "";
  let workspace = "";
  let cancelChangeId = "";

  const taskRow = (id: string) => rt.store.task.mustGet(id);

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
    const project = await rt.store.project.insert({
      name: "Garden club",
      goal: "A small site for the club",
      autonomy_level: 2,
    });
    projectId = project.id;
    workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), projectId);
    // What was there before the session: the home page.
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "index.html"), "<h1>Garden club</h1>\n", "utf8");
    const add = (title: string, priority: number) =>
      rt.store.task.insert({
        project_id: projectId,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["the file exists"],
        risk_tier: 1,
        status: "ready",
        priority,
        specialist: "coder",
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    aboutId = (await add("About page", 9)).id;
    await add("Write the README", 1);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("Cancel on the Tasks tab stops the run, takes its files out before the next task, and the critic never sees it", async () => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    // The run wrote about.html and the link, and still runs.
    await waitFor(
      async () =>
        provider.calls.length === 3 && existsSync(join(workspace, "about.html")) ? true : undefined,
      async () => `the About page to be written (${provider.calls.length} model calls)`,
    );
    expect((await taskRow(aboutId)).status).toBe("in_progress");
    // What the Tasks tab's Cancel sends.
    const loaded = await taskRow(aboutId);
    const res = await req(`/tasks/${aboutId}/action`, {
      method: "POST",
      body: JSON.stringify({ version: loaded.version, action: "cancel" }),
    });
    expect(res.status).toBe(200);
    const change = ((await res.json()) as { change: Json }).change;
    // The line after the action says what happens to the work.
    expect(change.sentence).toBe(
      'Cancelled "About page": its run stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.',
    );
    cancelChangeId = String(change.changeLogId);
    const ended = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
          ? s
          : undefined;
      },
      async () => `the session to end (${provider.calls.length} model calls)`,
    );
    expect(ended.status).toBe("completed");
    // Its files are out of the folder; the home page is as it was.
    expect(existsSync(join(workspace, "about.html"))).toBe(false);
    expect(readFileSync(join(workspace, "index.html"), "utf8")).toBe("<h1>Garden club</h1>\n");
    expect((await taskRow(aboutId)).status).toBe("cancelled");
    // The next task never saw them: its listing of the folder has no about.html.
    const readme = provider.calls.slice(3);
    expect(readme.length).toBeGreaterThanOrEqual(2);
    expect(
      readme.some((c) => shown(c).includes("README.md") || shown(c).includes("index.html")),
    ).toBe(true);
    for (const c of readme) expect(shown(c)).not.toContain("about.html");
    // The critic never reviewed the cancelled task.
    expect(await rt.store.review.forTask(aboutId)).toEqual([]);
    // The session log says it in one line.
    const lines = ((await (await req(`/sessions/${sessionId}/events`)).json()) as Json[])
      .filter((e) => e.audience === "person")
      .map((e) => String(e.text));
    expect(lines).toContain(
      'You cancelled it while "About page" ran; what it changed is removed and the session goes on.',
    );
  }, 60_000);

  it("Undo of the cancel, after a restart, puts the files back and the task is ready again", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, provider));
    const undone = await req(`/changes/${cancelChangeId}/undo`, { method: "POST", body: "{}" });
    expect(undone.status).toBe(200);
    const body = (await undone.json()) as Json;
    expect(JSON.stringify(body)).toContain("What it changed is back in the folder.");
    expect(readFileSync(join(workspace, "about.html"), "utf8")).toBe("<h1>About the club</h1>\n");
    expect(readFileSync(join(workspace, "index.html"), "utf8")).toContain('href="about.html"');
    expect((await taskRow(aboutId)).status).toBe("ready");
  }, 120_000);
});

describe("cancelling a task while the critic reviews it (live walk 2, C1)", () => {
  const clock = new SimulatedClock("2026-11-02T10:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-cancel-review-"));
  // "Contact page" writes contact.html and reports; the critic's call then waits until
  // something stops it.
  const provider = new ScriptedProvider(
    [
      write("contact.html", "<p>Write to the club.</p>\n"),
      { text: "Wrote contact.html." },
      { ttftMs: HOUR, text: "never sent" },
    ],
    clock,
  );
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the review stops, the task stays cancelled with no review, and its files are out of the folder", async () => {
    const project = await rt.store.project.insert({
      name: "Contact club",
      goal: "A contact page",
      autonomy_level: 2,
    });
    const workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), project.id);
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Contact page",
      outcome: "contact.html says how to reach the club",
      acceptance_criteria: ["contact.html exists"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      specialist: "coder",
      est_cost_usd_micro: 100_000,
      reason: "seed",
    });
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id, trigger: "manual" }),
    });
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    await waitFor(
      async () =>
        provider.calls.length === 3 && (await rt.store.task.mustGet(task.id)).status === "in_review"
          ? true
          : undefined,
      async () =>
        `the critic to review (${provider.calls.length} calls, task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    expect(existsSync(join(workspace, "contact.html"))).toBe(true);
    // What chat's "Skip the Contact page task" runs once the person says Yes.
    const res = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            name: "task.transition",
            params: { task: task.id, to: "cancelled", project: project.id },
          },
        ],
        source: "ui",
        confirm: "tap",
      }),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain(
      'Cancelled \\"Contact page\\": its review stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.',
    );
    const ended = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
          ? s
          : undefined;
      },
      async () => `the session to end (task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    expect(ended.status).toBe("completed");
    const after = await rt.store.task.mustGet(task.id);
    expect(after.status).toBe("cancelled");
    // No review was recorded, so the Tasks tab shows no critic's call for it.
    expect(await rt.store.review.forTask(task.id)).toEqual([]);
    const view = ((await (await req(`/projects/${project.id}/tasks`)).json()) as Json[]).find(
      (t) => t.id === task.id,
    );
    expect(view?.verdict ?? null).toBeNull();
    expect(existsSync(join(workspace, "contact.html"))).toBe(false);
  }, 60_000);
});

/** The critic's verdict as the model sends it: an unremarkable accept. */
const accept: ScriptReply = {
  tools: [
    {
      name: "submit_review",
      input: {
        grade: 92,
        confidence: "high",
        verdict: "accept",
        summary: "contact.html says how to reach the club.",
        findings: [],
        criteria: [],
        checks_run: [],
      },
    },
  ],
};

const isEnded = (s: Json) =>
  ["completed", "stopped", "failed", "killed"].includes(String(s.status));

describe("Stop now while the critic reviews a task (design §4.9, phase C review)", () => {
  // Before: the critic's stopped review threw "killed" and the task stayed "Being reviewed"
  // for good, with no review and no card; nothing could start it again. Stop now puts it back
  // to Ready, as it does for a running task, and keeps its files (ADR 0102).
  const clock = new SimulatedClock("2026-11-02T11:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-stop-review-"));
  const provider = new ScriptedProvider(
    [
      write("contact.html", "<p>Write to the club.</p>\n"),
      { text: "Wrote contact.html." },
      // The critic's call waits until Stop now stops it.
      { ttftMs: HOUR, text: "never sent" },
      // The next session: the run again, then the critic's verdict.
      write("contact.html", "<p>Write to the club at club@example.org.</p>\n"),
      { text: "Wrote contact.html." },
      accept,
      { text: "Accepted." },
    ],
    clock,
  );
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the task is Ready again with no review, its file stays, and the next session runs and reviews it", async () => {
    const project = await rt.store.project.insert({
      name: "Contact club",
      goal: "A contact page",
      autonomy_level: 2,
    });
    const workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), project.id);
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Contact page",
      outcome: "contact.html says how to reach the club",
      acceptance_criteria: ["contact.html exists"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      specialist: "coder",
      est_cost_usd_micro: 100_000,
      reason: "seed",
    });
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id, trigger: "manual" }),
    });
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    await waitFor(
      async () =>
        provider.calls.length === 3 && (await rt.store.task.mustGet(task.id)).status === "in_review"
          ? true
          : undefined,
      async () =>
        `the critic to review (${provider.calls.length} calls, task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    // The session page's Stop now.
    const stop = await req(`/sessions/${sessionId}/stop`, { method: "POST", body: "{}" });
    expect(stop.status).toBe(200);
    const first = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return isEnded(s) ? s : undefined;
      },
      async () => `the session to end (task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    expect(first.status).toBe("killed");
    const after = await rt.store.task.mustGet(task.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(0);
    // No review and no card: nothing waits on the person for it.
    expect(await rt.store.review.forTask(task.id)).toEqual([]);
    const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 100 });
    expect(open.filter((r) => r.task_id === task.id)).toEqual([]);
    // The Tasks tab and the Start dialog say it can run.
    const view = ((await (await req(`/projects/${project.id}/tasks`)).json()) as Json[]).find(
      (t) => t.id === task.id,
    );
    expect((view?.display as Json | undefined)?.label).toBe("Ready");
    const check = (await (await req(`/projects/${project.id}/start-check`)).json()) as Json;
    expect((check.runnable as Json[]).map((t) => t.taskId)).toContain(task.id);
    // The session's result and log say so; Stop now keeps what it wrote (ADR 0102).
    expect(String(first.summary)).toContain('"Contact page" is ready to continue.');
    const lines = ((await (await req(`/sessions/${sessionId}/events`)).json()) as Json[])
      .filter((e) => e.audience === "person")
      .map((e) => String(e.text));
    expect(lines.join("\n")).toContain('during "Contact page". It is ready again.');
    expect(readFileSync(join(workspace, "contact.html"), "utf8")).toBe(
      "<p>Write to the club.</p>\n",
    );

    // The next Start runs it again, and the critic reviews it this time.
    const again = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id, trigger: "manual" }),
    });
    expect(again.status).toBe(202);
    const secondId = (((await again.json()) as Json).session as Json).id as string;
    const second = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${secondId}`)).json()) as Json;
        return isEnded(s) ? s : undefined;
      },
      async () =>
        `the second session to end (${provider.calls.length} calls, task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    expect(second.status).toBe("completed");
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
    expect(await rt.store.review.forTask(task.id)).toHaveLength(1);
  }, 60_000);
});

describe("Cancel on a task in review that no session reviews (phase C review)", () => {
  // Before: the line promised "what it changed is removed; Undo brings it back" for any task
  // in review, but only a live run or review is ever set aside: nothing left the folder. Now
  // the line says that only when a live run or review was stopped, and a task in review that
  // waits on its card reads "Needs your decision", not "Being reviewed".
  const clock = new SimulatedClock("2026-11-02T12:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-cancel-idle-review-"));
  const provider = new ScriptedProvider([{ text: "unused" }], clock);
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let workspace = "";

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
    projectId = (
      await rt.store.project.insert({ name: "Contact club", goal: "Pages", autonomy_level: 2 })
    ).id;
    workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "contact.html"), "<p>Write to the club.</p>\n", "utf8");
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const inReview = (title: string) =>
    rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} is done`,
      acceptance_criteria: ["contact.html exists"],
      risk_tier: 1,
      status: "in_review",
      priority: 5,
      specialist: "coder",
      est_cost_usd_micro: 100_000,
      reason: "Wrote contact.html.",
    } as never);

  it("its review failed and its card waits: it reads Needs your decision, and Cancel promises nothing it does not do", async () => {
    const task = await inReview("Contact page");
    await fileReviewFailedRequest({
      store: rt.store,
      task,
      session: null,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runId: null,
      error: "the critic's model did not answer",
    });
    const view = ((await (await req(`/projects/${projectId}/tasks`)).json()) as Json[]).find(
      (t) => t.id === task.id,
    );
    const display = view?.display as Json;
    expect(display.key).toBe("answer");
    expect(display.label).toBe("Needs your decision");
    expect((display.blocker as Json).cardKind).toBe("retry");
    const res = await req(`/tasks/${task.id}/action`, {
      method: "POST",
      body: JSON.stringify({ version: task.version, action: "cancel" }),
    });
    expect(res.status).toBe(200);
    const change = ((await res.json()) as { change: Json }).change;
    expect(change.sentence).toBe('Cancelled "Contact page". Its card in the Inbox was withdrawn.');
    // Nothing was set aside, as the line says.
    expect(existsSync(join(workspace, "contact.html"))).toBe(true);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("cancelled");
  });

  it("left in review by a closed Forerunner, with no card: Cancel says only that it is cancelled", async () => {
    const task = await inReview("About page");
    const res = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            name: "task.transition",
            params: { task: task.id, to: "cancelled", project: projectId },
          },
        ],
        source: "ui",
        confirm: "tap",
      }),
    });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('Cancelled \\"About page\\".');
    expect(body).not.toContain("what it changed is removed");
    expect(existsSync(join(workspace, "contact.html"))).toBe(true);
  });
});

describe("cancelling a run keeps the person's answers in the decision record (phase C review)", () => {
  // Before: the person answered a card while another task ran; the answers were written into
  // the decision record, uncommitted, in the folder the run worked in, and the cancel of that
  // run took them out with the run's own changes. The answers are the app's write, not the
  // run's: they stay; only the run's changes leave the folder, and Undo brings only those back.
  const clock = new SimulatedClock("2026-11-02T13:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-cancel-answers-"));
  const provider = new ScriptedProvider(
    [write("index.html", "<h1>Bakery</h1>\n"), { ttftMs: HOUR, text: "never sent" }],
    clock,
  );
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  const Q = "Where is the page published?";
  const A = "On Cloudflare Pages, at bakery.example.org";

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the answers written while the run went on stay in the decision record; Undo brings back only the run's file", async () => {
    const project = await rt.store.project.insert({
      name: "Bakery",
      goal: "A page for the bakery",
      autonomy_level: 2,
      settings: { members: [rt.agent.id] },
    });
    const workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), project.id);
    const decide = await rt.store.task.insert({
      project_id: project.id,
      title: "Decide where the page is published",
      outcome: "The person's answers are in the decision record.",
      acceptance_criteria: [Q],
      risk_tier: 1,
      status: "ready",
      priority: 9,
      specialist: "person",
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    const build = await rt.store.task.insert({
      project_id: project.id,
      title: "Build the page",
      outcome: "index.html shows the bakery",
      acceptance_criteria: ["index.html exists"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      specialist: "coder",
      est_cost_usd_micro: 100_000,
      reason: "planned by the intake",
      author_agent: rt.agent.id,
    } as never);
    await rt.syncApprovals();
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id, trigger: "manual" }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    await waitFor(
      async () =>
        provider.calls.length === 2 && existsSync(join(workspace, "index.html")) ? true : undefined,
      async () => `the page to be written (${provider.calls.length} model calls)`,
    );
    // While "Build the page" runs, the person answers the card in the Inbox.
    const inbox = (await (await req("/inbox")).json()) as { requests: Json[] };
    const card = inbox.requests.find((r) => r.taskId === decide.id && r.status === "open");
    expect(card, "the person task's card is in the Inbox").toBeDefined();
    const answered = await req(`/requests/${String(card?.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({
        version: card?.version,
        answer: { answers: [{ question: Q, answer: A }] },
      }),
    });
    expect(answered.status).toBe(200);
    const record = () => {
      const dir = join(workspace, "docs", "decisions");
      const name = existsSync(dir)
        ? readdirSync(dir).find((n) => /^0001-.+\.md$/.test(n))
        : undefined;
      return name ? readFileSync(join(dir, name), "utf8") : "";
    };
    expect(record()).toContain(A);
    // Then they cancel the run.
    const loaded = await rt.store.task.mustGet(build.id);
    const res = await req(`/tasks/${build.id}/action`, {
      method: "POST",
      body: JSON.stringify({ version: loaded.version, action: "cancel" }),
    });
    const change = ((await res.json()) as { change: Json }).change;
    expect(change.sentence).toBe(
      'Cancelled "Build the page": its run stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.',
    );
    await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return isEnded(s) ? s : undefined;
      },
      async () => `the session to end (task ${(await rt.store.task.mustGet(build.id)).status})`,
    );
    // The run's file is out of the folder; the person's answers are not.
    expect(existsSync(join(workspace, "index.html"))).toBe(false);
    expect(record()).toContain(A);
    expect((await rt.store.task.mustGet(decide.id)).status).toBe("done");
    // Undo brings back the run's file, and the record holds the answers once.
    const undone = await req(`/changes/${String(change.changeLogId)}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(undone.status).toBe(200);
    expect(JSON.stringify(await undone.json())).toContain("What it changed is back in the folder.");
    expect(readFileSync(join(workspace, "index.html"), "utf8")).toBe("<h1>Bakery</h1>\n");
    expect(record().split(A).length - 1).toBe(1);
  }, 60_000);
});

describe("Undo of a cancel after the session's next task changed the same file (stops, L-6)", () => {
  // Live check of phase C (2026-11-02), Bakery: the print task was cancelled while it ran, the
  // session's next task wrote index.html six seconds later, and Undo said "What it changed
  // could not be put back: the folder changed in the same places since." while the dialog and
  // the line had promised "Undo brings it back". The words now say what Undo does: it reopens
  // the task, and its changes come back unless the same files changed since; when they did,
  // the task's next run does the work again.
  const clock = new SimulatedClock("2026-11-02T14:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-undo-conflict-"));
  // "Print stylesheet" writes print.css and links it from index.html, then waits until it is
  // stopped; "Menu" rewrites index.html; the critic accepts it.
  const provider = new ScriptedProvider(
    [
      write("print.css", "@media print { nav { display: none; } }\n"),
      write(
        "index.html",
        '<link rel="stylesheet" media="print" href="print.css">\n<h1>Bakery</h1>\n',
      ),
      { ttftMs: HOUR, text: "never sent" },
      write("index.html", "<h1>Bakery Bern</h1>\n<p>Menu: Nussgipfel, Zopf.</p>\n"),
      { text: "Wrote the menu into index.html." },
      accept,
      { text: "Accepted." },
    ],
    clock,
  );
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, provider));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the cancel's line promises what Undo does, and Undo says the work could not come back and that the next run redoes it", async () => {
    const project = await rt.store.project.insert({
      name: "Bakery Bern",
      goal: "A page for the bakery",
      autonomy_level: 2,
    });
    const workspace = projectWorkspaceDir(join(rt.dirs.data, "projects"), project.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "index.html"), "<h1>Bakery</h1>\n", "utf8");
    const add = (title: string, priority: number) =>
      rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["index.html exists"],
        risk_tier: 1,
        status: "ready",
        priority,
        specialist: "coder",
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    const print = await add("Print stylesheet", 9);
    const menu = await add("Menu", 1);
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id, trigger: "manual" }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    await waitFor(
      async () =>
        provider.calls.length === 3 && existsSync(join(workspace, "print.css")) ? true : undefined,
      async () => `print.css to be written (${provider.calls.length} model calls)`,
    );
    // The row's Cancel while it runs.
    const loaded = await rt.store.task.mustGet(print.id);
    const res = await req(`/tasks/${print.id}/action`, {
      method: "POST",
      body: JSON.stringify({ version: loaded.version, action: "cancel" }),
    });
    expect(res.status).toBe(200);
    const change = ((await res.json()) as { change: Json }).change;
    expect(change.sentence).toBe(
      'Cancelled "Print stylesheet": its run stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.',
    );
    // The session goes on: the next task rewrites index.html.
    const ended = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return isEnded(s) ? s : undefined;
      },
      async () => `the session to end (task ${(await rt.store.task.mustGet(menu.id)).status})`,
    );
    expect(ended.status).toBe("completed");
    expect(readFileSync(join(workspace, "index.html"), "utf8")).toContain("Nussgipfel");
    expect(existsSync(join(workspace, "print.css"))).toBe(false);
    // The session log does not promise that Undo brings the files back.
    const lines = ((await (await req(`/sessions/${sessionId}/events`)).json()) as Json[])
      .filter((e) => e.audience === "person")
      .map((e) => String(e.text));
    expect(lines).toContain(
      'You cancelled it while "Print stylesheet" ran; what it changed is removed and the session goes on.',
    );
    // Undo in Changes: the task is ready again; its work could not come back, and it says so.
    const undone = await req(`/changes/${String(change.changeLogId)}/undo`, {
      method: "POST",
      body: "{}",
    });
    expect(undone.status).toBe(200);
    expect(JSON.stringify(await undone.json())).toContain(
      "What it changed could not be put back: the same files changed since. Its next run does the work again.",
    );
    expect((await rt.store.task.mustGet(print.id)).status).toBe("ready");
    expect(existsSync(join(workspace, "print.css"))).toBe(false);
    expect(readFileSync(join(workspace, "index.html"), "utf8")).toContain("Nussgipfel");
  }, 60_000);
});
