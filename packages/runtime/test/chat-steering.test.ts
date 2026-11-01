import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Steering by chat on the composed daemon (design §3.9; the 2026-11-01 walk, acceptance c, d
 * and e of the synthesis area "chat"): "start working now" went to the model, "make the FAQ
 * task depend on the README task" and "skip the LICENSE task" had no command, a chat "stop"
 * froze the agent ("Sessions are stopped") so a later "start a session" answered "Started a
 * session ... Undo." while nothing started, and "resume" had neither a command nor a tool.
 * Every line here goes through `POST /chat` as the Chat tab sends it; no model is called.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("steering by chat (design §3.9)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-11-01T09:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const say = async (text: string) => {
    const res = await req("/chat", {
      method: "POST",
      body: JSON.stringify({
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId,
        projectTab: true,
        text,
        source: "text",
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      reply: string;
      actions: { kind: string }[];
      pendingConfirmation: { readback: string } | null;
    };
  };
  const task = (title: string, over: Record<string, unknown> = {}) =>
    rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title}.`,
      acceptance_criteria: [],
      risk_tier: 0,
      status: "ready",
      priority: 50,
      depends_on: [],
      budget_usd_micro: 0,
      reason: "",
      ...over,
    });
  const titleOf = async (id: string) => (await rt.store.task.mustGet(id)).title;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-chat-steering-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      // A model is configured, and never called: every line below is a command.
      provider: new ScriptedProvider([], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = (await rt.store.project.insert({ name: "Quote page", goal: "A quote a day" })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("'make the FAQ task depend on the README task' is read back in one line; after Yes the FAQ waits for the README", async () => {
    const readme = await task("Write the README");
    const faq = await task("Write the FAQ");
    const asked = await say("make the FAQ task depend on the README task");
    expect(asked.pendingConfirmation?.readback).toBe(
      'Make "Write the FAQ" wait for "Write the README"?',
    );
    // Nothing changed before the yes.
    expect((await rt.store.task.mustGet(faq.id)).depends_on).toEqual([]);
    const yes = await say("yes");
    expect(yes.reply).toBe('"Write the FAQ" now waits for "Write the README".');
    expect((await rt.store.task.mustGet(faq.id)).depends_on).toEqual([readme.id]);
    // "make X wait for Y" adds to what X waits for; it never drops a dependency.
    const style = await task("Style the page");
    const also = await say("make the FAQ wait for the style task");
    expect(also.pendingConfirmation?.readback).toBe(
      'Make "Write the FAQ" also wait for "Style the page"?',
    );
    await say("yes");
    const deps = (await rt.store.task.mustGet(faq.id)).depends_on;
    expect(await Promise.all(deps.map(titleOf))).toEqual(["Write the README", "Style the page"]);
    void style;
  });

  it("'skip the LICENSE task' is read back as a pause; 'resume the LICENSE task' brings it back", async () => {
    const license = await task("Add a LICENSE file");
    const asked = await say("skip the LICENSE task for now");
    expect(asked.pendingConfirmation?.readback).toBe(
      'Pause "Add a LICENSE file"? No session runs it until you press Resume.',
    );
    await say("yes");
    const paused = await rt.store.task.mustGet(license.id);
    expect(paused.status).toBe("needs_human");
    expect(paused.reason).toBe("Paused by you");
    const back = await say("resume the license task");
    expect(back.pendingConfirmation?.readback).toBe(
      'Resume "Add a LICENSE file"? It is ready again; the next session can run it.',
    );
    await say("yes");
    expect((await rt.store.task.mustGet(license.id)).status).toBe("ready");
  });

  it("pausing a RUNNING task by chat stops its run at once (the stopTask port, U-039)", async () => {
    const running = await task("Build the quote list", { status: "in_progress" });
    const controller = new AbortController();
    const unregister = rt.kill.register({
      agentId: rt.agent.id,
      sessionId: "s-run",
      taskId: running.id,
      controller,
      label: "run",
    });
    await say("pause the quote list task");
    await say("yes");
    expect(controller.signal.aborted).toBe(true);
    expect((await rt.store.task.mustGet(running.id)).status).toBe("needs_human");
    unregister();
  });

  it("'stop' stops the running session without freezing; 'start a session' then starts one", async () => {
    const row = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      runner: "pc",
    });
    const live = await rt.store.session.start(row.id, row.version);
    const controller = new AbortController();
    const unregister = rt.kill.register({
      agentId: rt.agent.id,
      sessionId: live.id,
      controller,
      label: "run",
    });
    const stop = await say("stop");
    expect(stop.actions.map((a) => a.kind)).toEqual(["session.stop"]);
    expect(stop.reply).toBe(
      "Stopped the session on Quote page. What it wrote stays; the task it was on is ready again.",
    );
    expect(controller.signal.aborted).toBe(true);
    // Stop now, not Stop all: sessions may start (before, the agent was frozen).
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    unregister();
    const current = await rt.store.session.mustGet(live.id);
    await rt.store.session.setStatus(current.id, current.version, "stopped");
  });

  it("'stop everything' is Stop all; 'start a session' says why nothing starts; 'resume' allows sessions again", async () => {
    await task("Write index.html");
    const all = await say("stop everything");
    expect(all.reply).toBe(
      'Stopped every running session. No session starts until you say "resume" or press Allow sessions again.',
    );
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(true);
    // Before: "Started a session ... Undo." while nothing started. Now the reason, in words.
    const start = await say("start a session with 1 franc");
    expect(start.reply).toBe(
      'Sessions are stopped (Stop all), so nothing can start. Say "resume" to allow sessions again.',
    );
    expect(start.actions).toEqual([]);
    const resume = await say("resume");
    expect(resume.actions.map((a) => a.kind)).toEqual(["session.resume"]);
    expect(resume.reply).toBe(
      'Sessions can start again. Say "start a session" to continue where it stopped.',
    );
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
  });

  it("typed 'summary' and 'summarise the last session' answer in text: no voice error, one spend figure", async () => {
    const p = await rt.store.project.mustGet(projectId);
    await rt.store.project.update(projectId, p.version, {
      summary_cache: {
        last_session: {
          id: "s-last",
          ended_at: "2026-11-01T08:00:00.000Z",
          summary: 'Did 2 tasks: "Write the README" and "Write index.html". CHF 0.06.',
        },
        next_steps: ["Write the FAQ"],
      },
    });
    for (const line of ["summary", "summarise the last session"]) {
      const r = await say(line);
      expect(
        r.actions.map((a) => a.kind),
        line,
      ).toEqual(["summary.speak"]);
      expect(r.reply, line).toMatch(/^Quote page: \d+ of \d+ tasks done\.\n/);
      expect(r.reply, line).toContain(
        'Last session: Did 2 tasks: "Write the README" and "Write index.html". CHF 0.06.',
      );
      expect(r.reply, line).toContain('Next: "Write the FAQ".');
      // Before: a voice-install error with Python module and secret names, and a second total.
      expect(r.reply, line).not.toMatch(/voice|python|secret|provider|francs/i);
      expect(r.reply.match(/CHF/g) ?? [], line).toHaveLength(1);
    }
  });

  it("'start working now' is a start, not a question for the model; it says what it did", async () => {
    const r = await say("start working now");
    // The default session budget is above the costly threshold: read back as one question.
    expect(r.pendingConfirmation?.readback).toMatch(
      /^Start a session on Quote page \(up to CHF [\d.]+\)\?$/,
    );
    const yes = await say("yes");
    expect(yes.reply).toMatch(
      /^(?:Started a session on Quote page|A session on Quote page starts after the one running now) \(up to CHF [\d.]+\)\.$/,
    );
    expect(yes.reply).not.toContain("Undo.");
  });
});
