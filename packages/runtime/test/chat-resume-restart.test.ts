import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { readKillRequest } from "../src/enforcement/killfile.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Validation rule 4 (a Resume is tested after a restart; phase E leftover #13): "stop
 * everything" said in chat stops and freezes sessions, the freeze holds across a daemon
 * restart, and "resume" said in chat after the restart lets sessions start again, which a
 * further restart keeps. `chat-steering.test.ts` covers the same lines in one process only;
 * `kill-resume-restart.test.ts` covers the header, the phone and Stop all, not the chat.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

/** Polls in real time, at most 10 s (validation: no reliance on how long work takes). */
async function until(probe: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the chat's resume across a daemon restart (validation rule 4)", () => {
  const home = mkdtempSync(join(tmpdir(), "fr-chat-resume-restart-"));
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");
  let rt: RuntimeApp | undefined;

  const compose = async () => {
    const runtime = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      // A model is configured and never called: every line is a command.
      provider: new ScriptedProvider([], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    const { app, token } = createDaemonApp(runtime);
    const say = async (projectId: string, text: string) => {
      const res = await app.request("/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          humanId: runtime.human.id,
          agentId: runtime.agent.id,
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
    return { runtime, say };
  };

  afterAll(async () => {
    await rt?.close();
  });

  it("'stop everything' holds across a restart, and 'resume' said after it lets sessions start, also after the next restart", async () => {
    let c = await compose();
    rt = c.runtime;
    const projectId = (
      await rt.store.project.insert({
        name: "Quote page",
        goal: "A quote a day",
        autonomy_level: 2,
        settings: { members: [rt.agent.id] },
      })
    ).id;
    await rt.store.task.insert({
      project_id: projectId,
      title: "Write index.html",
      outcome: "index.html",
      status: "ready",
      reason: "",
    } as never);
    const stopped = await c.say(projectId, "stop everything");
    expect(stopped.actions.map((a) => a.kind)).toEqual(["session.stop"]);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(true);
    // What the next start reads (U-019): the person's Stop all is in the runtime's kill file.
    expect(readKillRequest(appDirs({ env: { FORERUNNER_HOME: home } }).runtime)).not.toBeNull();

    await rt.close();
    c = await compose();
    rt = c.runtime;
    // The freeze is the person's: it comes back with the daemon (its kill file is read by the
    // watcher the services start, on its first tick, 500 ms in).
    await clock.advance(1_000);
    const restarted = rt;
    await until(
      () => restarted.kill.isFrozen({ agentId: restarted.agent.id }),
      "the restarted daemon to apply the person's Stop all",
    );
    const refused = await c.say(projectId, "start a session");
    expect(refused.reply).toBe(
      'Sessions are stopped (Stop all), so nothing can start. Say "resume" to allow sessions again.',
    );
    const resumed = await c.say(projectId, "resume");
    expect(resumed.actions.map((a) => a.kind)).toEqual(["session.resume"]);
    expect(resumed.reply).toBe(
      'Sessions can start again. Say "start a session" to continue where it stopped.',
    );
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);

    await rt.close();
    c = await compose();
    rt = c.runtime;
    // The resume stands after the next start too (the watcher's first tick finds no kill): a
    // session can start (its read-back is asked).
    await clock.advance(1_000);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    const card = await c.say(projectId, "start a session");
    expect(card.pendingConfirmation?.readback).toMatch(/^Start a session on Quote page/);
  }, 120_000);
});
