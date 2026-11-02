import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
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
      'Cancelled "About page": its run stopped and what it changed is removed; Undo brings it back.',
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
      'You cancelled it while "About page" ran; what it changed is removed (Undo brings it back) and the session goes on.',
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
      'Cancelled \\"Contact page\\": its review stopped and what it changed is removed; Undo brings it back.',
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
