import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Core-experience design §4.10 (crash recovery): a daemon that died while a session ran left
 * the session `running`, its run `running` and its task `in_progress` under a claim nobody
 * renews. Before, every later Start answered "agent Alice already has an active session
 * <uuid>" (409) for good, Stop on the ghost did nothing and a restart did not clear it. Now
 * the next daemon start ends the ghost as interrupted, puts the task back to ready, posts one
 * Update, and the next Start works the first time. Composed twice on one home: the state a dead
 * process left is what the second start reads.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const HOUR = 60 * 60 * 1000;

describe("a session a dead daemon left running is ended at the next start (design §4.10)", () => {
  const opened: RuntimeApp[] = [];
  afterEach(async () => {
    for (const rt of opened.splice(0)) await rt.close().catch(() => undefined);
  });
  const compose = async (home: string, clock: SimulatedClock, recover: boolean) => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      recoverSessions: recover,
    });
    opened.push(rt);
    return rt;
  };

  /** What a daemon that died mid-task leaves: a running session, a running run, a held task. */
  const leaveAGhost = async (rt: RuntimeApp) => {
    const project = await rt.store.project.insert({
      name: "Quote page",
      goal: "A page with a quote",
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
    });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Create the page skeleton",
      outcome: "index.html exists",
      acceptance_criteria: ["index.html exists"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
    });
    const other = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the README",
      outcome: "README.md exists",
      acceptance_criteria: ["README.md exists"],
      risk_tier: 1,
      status: "ready",
      priority: 1,
    });
    let session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: project.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 200,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: rt.agent.id,
    });
    session = await rt.store.session.start(session.id, session.version);
    const claim = await rt.store.task.claim(task.id, rt.agent.id, HOUR);
    if (!claim.ok) throw new Error("claim failed");
    await rt.store.task.transition(task.id, claim.task.version, "in_progress", "started work", {
      agentId: rt.agent.id,
    });
    await rt.store.run.insert({
      task_id: task.id,
      session_id: session.id,
      specialist: "coder",
      model: "fake",
      provider: "fake",
      effort: "low",
      prompt_version: "v1",
      billing_source_id: null,
      outcome: "running",
      author_agent: rt.agent.id,
    });
    return { project, task, other, session };
  };

  it("ends the ghost as interrupted, frees its task, posts one Update; the next Start works", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-recovery-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const first = await compose(home, clock, false);
    const ghost = await leaveAGhost(first);
    // The first process dies here: nothing it held is released (no Quit, no kill).
    opened.splice(0);

    const rt = await compose(home, clock, true);
    const session = await rt.store.session.mustGet(ghost.session.id);
    expect(session.status).toBe("stopped");
    expect(session.summary).toBe(
      'Interrupted: Forerunner closed while this session ran. "Create the page skeleton" is ready again.',
    );
    expect((session.handoff as { stop_reason?: string }).stop_reason).toBe("interrupted");
    const task = await rt.store.task.mustGet(ghost.task.id);
    expect(task.status).toBe("ready");
    expect(task.claimed_by).toBeNull();
    expect(task.reason).toBe("Forerunner closed while it ran");
    const runs = await rt.store.run.forSession(ghost.session.id);
    expect(runs.map((r) => r.outcome)).toEqual(["killed"]);
    // One Update, in the person's words.
    const human = (await rt.store.human.list({}, { limit: 1 }))[0];
    const updates = (await rt.store.message.inbox({ humanId: human?.id ?? "" })).filter((m) =>
      /interrupted/.test(m.body),
    );
    expect(updates.map((m) => m.body)).toEqual([
      'Your last session was interrupted when Forerunner closed. "Create the page skeleton" is ready again.',
    ]);

    // The next Start works the first time: no 409, no "already has an active session".
    const { app, token } = createDaemonApp(rt);
    const res = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: rt.agent.id,
        projectId: ghost.project.id,
        trigger: "manual",
      }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const body = await res.text();
    expect(body).not.toContain("already has an active session");
    expect(res.status).toBe(202);

    // A third start of the daemon finds nothing more to recover and posts nothing more (the
    // daemon lock keeps two daemons off one home, so the second ends before the third starts).
    // The person stops the new session first: left alone it works through its tasks and their
    // retries, which took longer than 5 s on Windows CI. A session that already ended is left
    // as it is.
    const started = JSON.parse(body) as { session?: { id?: string } | null };
    const newSessionId = started.session?.id;
    if (newSessionId) {
      const stop = await app.request(`/sessions/${newSessionId}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(stop.status).toBe(200);
    }
    for (let i = 0; i < 1200 && (await rt.store.session.active(rt.agent.id)).length > 0; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(await rt.store.session.active(rt.agent.id)).toEqual([]);
    const again = await compose(home, clock, true);
    const more = (await again.store.message.inbox({ humanId: human?.id ?? "" })).filter((m) =>
      /interrupted/.test(m.body),
    );
    expect(more).toHaveLength(1);
  }, 120_000);

  it("Stop on a session nothing runs ends it (no live run to stop)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-recovery-stop-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const first = await compose(home, clock, false);
    const ghost = await leaveAGhost(first);
    opened.splice(0);
    // A one-shot or a daemon that did not recover (the switch off) still has the ghost.
    const rt = await compose(home, clock, false);
    expect((await rt.store.session.mustGet(ghost.session.id)).status).toBe("running");
    const { app, token } = createDaemonApp(rt);
    const res = await app.request(`/sessions/${ghost.session.id}/stop`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { status: string; statusText?: string };
    expect(view.status).toBe("stopped");
    expect(view.statusText).toBe("Stopped by you");
    const task = await rt.store.task.mustGet(ghost.task.id);
    expect(task.status).toBe("ready");
    expect(task.reason).toBe("Stopped by you");
    expect(await rt.store.session.active(rt.agent.id)).toEqual([]);
  }, 120_000);

  it("a task the critic was reviewing when Forerunner closed is ready again; one whose card waits stays (phase C review)", async () => {
    // Releasing a claim puts back only a claimed or running task: one whose review was going
    // read "Being reviewed" for good, with no card, while the result said it was ready again,
    // and no session plans a task in review.
    const home = mkdtempSync(join(tmpdir(), "fr-recovery-review-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const first = await compose(home, clock, false);
    const ghost = await leaveAGhost(first);
    const reviewing = await first.store.task.mustGet(ghost.task.id);
    await first.store.task.transition(reviewing.id, reviewing.version, "in_review", "Wrote it.", {
      agentId: first.agent.id,
    });
    // An earlier task of the same session whose review failed waits on its card (U-045).
    const waiting = await first.store.task.insert({
      project_id: ghost.project.id,
      title: "Style the page",
      outcome: "styles.css exists",
      acceptance_criteria: ["styles.css exists"],
      risk_tier: 1,
      status: "in_review",
      priority: 3,
    } as never);
    await first.store.run.insert({
      task_id: waiting.id,
      session_id: ghost.session.id,
      specialist: "coder",
      model: "fake",
      provider: "fake",
      effort: "low",
      prompt_version: "v1",
      billing_source_id: null,
      outcome: "success",
      author_agent: first.agent.id,
    });
    const human = (await first.store.human.list({}, { limit: 1 }))[0];
    await first.store.humanRequest.insert({
      human_id: human?.id ?? "",
      project_id: ghost.project.id,
      task_id: waiting.id,
      session_id: ghost.session.id,
      kind: "approval",
      why: '"Style the page" could not be reviewed.',
      steps: [],
      options: ["Try again", "Mark done anyway", "Cancel task"],
      blocking: true,
      risk: "medium",
      change_card: { key: "critic:review_failed", task_id: waiting.id },
      author_agent: first.agent.id,
    } as never);
    opened.splice(0);

    const rt = await compose(home, clock, true);
    const task = await rt.store.task.mustGet(ghost.task.id);
    expect(task.status).toBe("ready");
    expect(task.reason).toBe("Forerunner closed while it ran");
    expect((await rt.store.session.mustGet(ghost.session.id)).summary).toBe(
      'Interrupted: Forerunner closed while this session ran. "Create the page skeleton" is ready again.',
    );
    expect((await rt.store.task.mustGet(waiting.id)).status).toBe("in_review");
  }, 120_000);

  it("a task being reviewed when the person quit Forerunner is ready again at the next start (L-1)", async () => {
    // Live check of phase C (2026-11-02): Quit during "Being reviewed", then reopen. Quit's
    // stop released every claim (`POST /shutdown` -> the kill switch), and a released task in
    // review keeps its status; the process ended before the runner put the task back. The next
    // start ended the session but freed only the tasks still claimed ('{"tasks":[]}'), so the
    // task read "Being reviewed · The critic is checking the work." for good, Start had nothing
    // to run, and the Update said "Nothing was left half done."
    const home = mkdtempSync(join(tmpdir(), "fr-recovery-quit-review-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const first = await compose(home, clock, false);
    const ghost = await leaveAGhost(first);
    const reviewing = await first.store.task.mustGet(ghost.task.id);
    await first.store.task.transition(reviewing.id, reviewing.version, "in_review", "Wrote it.", {
      agentId: first.agent.id,
    });
    // Quit: what the desktop shell's Quit asks of the daemon (POST /shutdown), then the
    // process ends before the session's own end is written.
    const quit = createDaemonApp(first, { onShutdown: () => undefined });
    const shutdown = await quit.app.request("/shutdown", {
      method: "POST",
      headers: { authorization: `Bearer ${quit.token}` },
    });
    expect(shutdown.status).toBe(202);
    const left = await first.store.task.mustGet(ghost.task.id);
    expect([left.status, left.claimed_by]).toEqual(["in_review", null]);
    opened.splice(0);

    const rt = await compose(home, clock, true);
    const task = await rt.store.task.mustGet(ghost.task.id);
    expect(task.status).toBe("ready");
    expect(task.reason).toBe("Forerunner closed while it ran");
    expect((await rt.store.session.mustGet(ghost.session.id)).summary).toBe(
      'Interrupted: Forerunner closed while this session ran. "Create the page skeleton" is ready again.',
    );
    const human = (await rt.store.human.list({}, { limit: 1 }))[0];
    const updates = (await rt.store.message.inbox({ humanId: human?.id ?? "" })).filter((m) =>
      /interrupted/.test(m.body),
    );
    expect(updates.map((m) => m.body)).toEqual([
      'Your last session was interrupted when Forerunner closed. "Create the page skeleton" is ready again.',
    ]);
    // What the Tasks tab and the Start dialog read: Ready, and Start runs it.
    const { app, token } = createDaemonApp(rt);
    const get = async (path: string) =>
      (await (
        await app.request(path, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as Record<string, unknown>;
    const views = (await get(`/projects/${ghost.project.id}/tasks`)) as unknown as {
      id: string;
      display?: { label: string };
    }[];
    expect(views.find((v) => v.id === ghost.task.id)?.display?.label).toBe("Ready");
    const check = await get(`/projects/${ghost.project.id}/start-check`);
    expect((check.runnable as { taskId: string }[]).map((t) => t.taskId)).toContain(ghost.task.id);
  }, 120_000);

  it("a background job's row (the critic's calibration) is ended without telling the person", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-recovery-critic-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const first = await compose(home, clock, false);
    // What a daemon that died during the monthly calibration leaves: the critic's own row, on
    // no project (ADR 0102 decision 4).
    let calibration = await first.store.session.insert({
      agent_id: first.criticAgent.id,
      project_id: null,
      trigger: "schedule",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 200,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: first.criticAgent.id,
    });
    calibration = await first.store.session.start(calibration.id, calibration.version);
    opened.splice(0);

    const rt = await compose(home, clock, true);
    // Ended, so it holds the critic's one session no longer.
    expect((await rt.store.session.mustGet(calibration.id)).status).toBe("stopped");
    expect(await rt.store.session.active(rt.criticAgent.id)).toEqual([]);
    // Not the person's session: no "Your last session was interrupted" Update for it.
    const human = (await rt.store.human.list({}, { limit: 1 }))[0];
    const updates = (await rt.store.message.inbox({ humanId: human?.id ?? "" })).filter((m) =>
      /interrupted/.test(m.body),
    );
    expect(updates).toEqual([]);
  }, 120_000);
});
