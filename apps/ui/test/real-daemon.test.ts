// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appDirs, join, SimulatedClock, SystemClock } from "@forerunner/platform";
import { KILL_ACTIVE_START_MESSAGE } from "@forerunner/runtime/daemon/api-types";
import { composeRuntime, type RuntimeApp } from "@forerunner/runtime/daemon/compose";
import { createDaemonApp } from "@forerunner/runtime/daemon/server";
import type { ModelRequest } from "@forerunner/runtime/provider/types";
import { FakeContainerEngine } from "@forerunner/runtime/sandbox/fake-engine";
import { answersBlockFor } from "@forerunner/runtime/session/person-questions";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScriptedProvider } from "../../../packages/runtime/test/helpers.ts";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import {
  type BenchOptions,
  benchOptionsFromEnv,
  createRolePlayer,
} from "../../../testenv/src/bench/role-player.ts";
import { detectRole } from "../../../testenv/src/bench/roles.ts";
import { ApiError, createClient, type DaemonClient, isRouteMissing } from "../src/api/client.ts";
import { followSandboxPull } from "../src/api/sandbox.ts";

/**
 * The UI's own client against the real daemon (U-008 in docs/status/UPDATE-LOG.md). The screen
 * tests run against `fake-daemon.ts`, which answered routes the daemon never had (the
 * next-session queue, the docs, the import) and a session from `POST /sessions` where the daemon
 * answers the scheduler's outcome; the screens passed their tests and failed in the app
 * (U-003 to U-006). Here the whole runtime is composed as `fr daemon` composes it, the client
 * the screens use calls it through `app.request`, and every answer is parsed with the UI's
 * schemas: a route the daemon lacks or an answer of another shape fails this file.
 */

const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));

/**
 * The sandbox every composition here means (U-079): no container engine, whatever the machine
 * has, so a task at tier 0 or 1 runs in the process stand-in and CI's own Docker (no runner
 * image on Linux, Windows containers on Windows) never decides a result.
 */
const NO_ENGINE = {
  engine: "none" as const,
  problem: "not_installed" as const,
  reason: "test: no engine",
  checkedAt: "2026-03-05T08:00:00.000Z",
};

/** What a call came back with, when it is a mismatch between the screens and the daemon. */
function mismatch(error: unknown): string | null {
  if (!(error instanceof ApiError)) return `threw ${String(error)}`;
  if (error.code === "ui.invalid_response") return error.message;
  if (isRouteMissing(error)) return `route missing: ${error.message}`;
  return null;
}

describe("the UI client against the real daemon", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let projectId = "";
  let agentId = "";
  let humanId = "";
  let dataDir = "";

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-"));
    dataDir = join(home, "incoming");
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done for today." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
    });
    const { app, token } = createDaemonApp(rt);
    client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
    const me = await client.me();
    humanId = me.id;
    agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Contract", goal: "Screens match" });
    projectId = project.id;
    // Composing the whole runtime on a cold Windows runner has exceeded the default hook timeout.
  }, 120_000);

  afterAll(async () => {
    await rt?.close();
  });

  it("answers every screen's read call in the shape the screen parses", async () => {
    const reads: Array<[string, () => Promise<unknown>]> = [
      ["health", () => client.health()],
      ["me", () => client.me()],
      ["agents", () => client.agents()],
      ["projects", () => client.projects()],
      ["project", () => client.project(projectId)],
      ["projectSummary", () => client.projectSummary(projectId)],
      ["conversation", () => client.conversation(projectId)],
      ["generalConversation", () => client.conversation(null)],
      ["tasks", () => client.tasks(projectId)],
      ["startCheck", () => client.startCheck(projectId)],
      ["runs", () => client.runs(projectId)],
      ["decisions", () => client.decisions(projectId)],
      ["peers", () => client.peers(projectId)],
      ["sessions", () => client.sessions({ projectId })],
      ["desktopStatus", () => client.desktopStatus()],
      ["inbox", () => client.inbox(humanId)],
      ["costs", () => client.costs({ projectId })],
      ["costEstimates", () => client.costEstimates()],
      ["settings", () => client.settings()],
      ["modelSettings", () => client.modelSettings()],
      ["billingOrder", () => client.billingOrder()],
      ["extensions", () => client.extensions()],
      ["extensionCatalog", () => client.extensionCatalog()],
      ["voiceStatus", () => client.voiceStatus()],
      ["sandboxStatus", () => client.sandboxStatus()],
      ["updates", () => client.updates()],
      ["updatesStatus", () => client.updatesStatus()],
      ["modelWatchReports", () => client.modelWatchReports()],
      ["reviews", () => client.reviews(projectId)],
      ["memoryScopes", () => client.memoryScopes()],
      ["memory", () => client.memory({ scope: "shared" })],
      ["consolidation", () => client.consolidation()],
      ["memoryPromotions", () => client.memoryPromotions()],
      ["memoryOffers", () => client.memoryOffers()],
      ["commandDefs", () => client.commandDefs()],
      ["pendingCommands", () => client.pendingCommands()],
      ["changes", () => client.changes({ projectId })],
      ["emailSettings", () => client.emailSettings(agentId)],
      ["emailSent", () => client.emailSent(agentId)],
      ["emailCommands", () => client.emailCommands(agentId)],
      ["queue", () => client.queue(projectId)],
      ["milestones", () => client.milestones(projectId)],
      ["dataAssets", () => client.dataAssets(projectId)],
      ["docs", () => client.docs(projectId)],
      ["performance", () => client.performance({ projectId })],
      ["sources", () => client.sources()],
      ["devices", () => client.devices()],
      ["setupStatus", () => client.setupStatus()],
      ["desktopAllowlist", () => client.desktopAllowlist(humanId)],
      ["intakeStatus", () => client.intakeStatus(projectId)],
    ];
    const failures: string[] = [];
    for (const [name, call] of reads) {
      try {
        await call();
      } catch (error) {
        const why = mismatch(error);
        if (why) failures.push(`${name}: ${why}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("start session: answers with the session it started, which the dialog opens (U-003)", async () => {
    const started = await client.startSession({ agentId, projectId, trigger: "manual" });
    expect(started.result).toBe("started");
    expect(started.startId).toEqual(expect.any(String));
    const session = started.session;
    expect(session).not.toBeNull();
    expect(session?.agentId).toBe(agentId);
    expect(session?.projectId).toBe(projectId);
    // The dialog navigates to the session page, which reads it by id.
    expect((await client.session(session?.id ?? "")).id).toBe(session?.id);
  });

  it("start session with a note: the session keeps it for every task's brief (design §4.6)", async () => {
    // The session the case before started ends first (one session per agent).
    for (let i = 0; i < 200; i++) {
      const running = (await client.sessions({ projectId })).filter((s) => !s.endedAt);
      if (running.length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = await client.startSession({
      agentId,
      projectId,
      trigger: "manual",
      note: "Keep it in plain HTML.",
    });
    const id = started.session?.id ?? "";
    let handoff: unknown = null;
    for (let i = 0; i < 200; i++) {
      const s = await client.session(id);
      handoff = s.handoff;
      if (s.endedAt) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(handoff).toMatchObject({ note: "Keep it in plain HTML." });
  });

  it("next-session queue: add, list and dismiss (U-004)", async () => {
    const added = await client.enqueue(projectId, {
      kind: "correction",
      text: "Use the staging database",
      priority: 7,
    });
    expect(added).toMatchObject({
      projectId,
      humanId,
      kind: "correction",
      text: "Use the staging database",
      priority: 7,
      status: "queued",
    });
    const queued = await client.queue(projectId, { status: "queued" });
    expect(queued.map((q) => q.id)).toContain(added.id);
    const dismissed = await client.dismissQueueItem(added.id);
    expect(dismissed).toMatchObject({ id: added.id, status: "dismissed" });
    expect((await client.queue(projectId, { status: "queued" })).map((q) => q.id)).not.toContain(
      added.id,
    );
    expect((await client.queue(projectId)).find((q) => q.id === added.id)?.status).toBe(
      "dismissed",
    );
  });

  it("tasks: each task says what stops its runs, its budget or its specialist's limit (U-042)", async () => {
    const budgeted = await client.createTask(projectId, {
      title: "Cap from the budget",
      outcome: "The cap is shown",
      acceptanceCriteria: [],
      priority: 5,
      status: "draft",
      dependsOn: [],
      budgetUsdMicro: 2_000_000,
    });
    expect(budgeted.capSource).toBe("task_budget");
    expect(budgeted.cap.usdMicro).toBe(2_000_000);
    const open = await client.createTask(projectId, {
      title: "Cap from the specialist",
      outcome: "The cap is shown",
      acceptanceCriteria: [],
      priority: 5,
      status: "draft",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    // No budget and no specialist named: the planner's coder, whose registry limit is USD 3.
    expect(open.capSource).toBe("specialist_limit");
    expect(open.cap.usdMicro).toBe(3_000_000);
    const listed = await client.tasks(projectId);
    expect(listed.find((t) => t.id === budgeted.id)?.capSource).toBe("task_budget");
  });

  it("create a repository: the card names the project's repos, and without a GitHub token the command says what to do (U-037)", async () => {
    // The project page shows "Create a repository" for a card whose repos are empty.
    expect((await client.project(projectId)).repos).toEqual([]);
    // This daemon has no GitHub token: the dialog's call is refused with the next step.
    const r = await client.executeCommands({
      commands: [{ name: "repo.create", params: { project: projectId, private: true } }],
      wordsUsed: "Create a repository (project page)",
      source: "ui",
      projectId,
    });
    expect(r.status).toBe("refused");
    expect(r.reason).toContain("add one in the setup assistant (the GitHub step)");
    expect((await client.project(projectId)).repos).toEqual([]);
  });

  it("docs: lists the standard doc set and reads one (U-005)", async () => {
    const docs = await client.docs(projectId);
    const readme = docs.find((d) => d.path === "README.md");
    expect(readme).toMatchObject({ exists: true });
    expect(docs.map((d) => d.path)).toContain("docs/status.md");
    const content = await client.doc(projectId, "README.md");
    expect(content.path).toBe("README.md");
    expect(content.content).toContain("Contract");
  });

  it("rename the agent: Settings' call renames the principal and /me and /agents follow (U-025)", async () => {
    const renamed = await client.renameAgent(agentId, "  Robin  ");
    expect(renamed).toMatchObject({ id: agentId, name: "Robin", ownerHumanId: humanId });
    expect((await client.agents()).find((a) => a.id === agentId)?.name).toBe("Robin");
    expect(rt.agent.name).toBe("Robin");
    // The daemon's refusal reaches the field as an ApiError with its own words.
    const refused = await client.renameAgent(agentId, "critic").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).message).toContain("already have an agent named Critic");
  });

  it("data import: imports a folder through the daemon's import (U-006)", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "notes.csv"), "a,b\n1,2\n");
    const result = await client.importProject(projectId, { source: "folder", locator: dataDir });
    expect(result.projectId).toBe(projectId);
    expect(result.entryCount).toBeGreaterThanOrEqual(1);
  });

  it("stop session: answers with the session, and Stop all set before stays in force (U-032)", async () => {
    const started = await client.startSession({ agentId, projectId, trigger: "manual" });
    const id = started.session?.id ?? (await client.sessions({ projectId }))[0]?.id ?? "";
    expect(id).not.toBe("");
    expect((await client.kill({ scope: "all", reason: "stop all from the UI" })).killActive).toBe(
      true,
    );
    // The live view's Stop button: it reads the answer as the session it shows.
    const stopped = await client.stopSession(id, "stopped from the live view");
    expect(stopped.id).toBe(id);
    // The header still shows the kill and Resume; only Resume lifts it.
    expect((await client.health()).killActive).toBe(true);
    expect((await client.resume()).killActive).toBe(false);
    expect((await client.health()).killActive).toBe(false);
  });

  it("stop on a session nothing runs (a dead daemon's): it ends, its task is ready, the next Start works (design §4.10)", async () => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Half built page",
      outcome: "index.html exists",
      acceptance_criteria: ["index.html exists"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
    });
    // What a crash leaves: a running row nobody runs, its task held under a lapsed-never claim.
    let ghost = await rt.store.session.insert({
      agent_id: agentId,
      project_id: projectId,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1_000_000,
      step_cap: 10,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: agentId,
    });
    ghost = await rt.store.session.start(ghost.id, ghost.version);
    const claim = await rt.store.task.claim(task.id, agentId, 3_600_000);
    expect(claim.ok).toBe(true);
    // The session page's Stop, as the client sends it: the view says who stopped it.
    const stopped = await client.stopSession(ghost.id);
    expect(stopped).toMatchObject({
      id: ghost.id,
      status: "stopped",
      stopReason: "you",
      statusText: "Stopped by you",
      // An ended session has no current task, whatever its log's last start says.
      currentTask: null,
    });
    expect(stopped.summary).toBe('Stopped by you. "Half built page" is ready again.');
    const after = (await client.tasks(projectId)).find((t) => t.id === task.id);
    expect(after?.status).toBe("ready");
    // The agent holds no session any more: a start is not refused as "already active".
    const started = await client.startSession({ agentId, projectId, trigger: "manual" });
    expect(["started", "queued"]).toContain(started.result);
  });

  it("start check: what runs and what follows, why nothing would, the default budget, the month left (design §3.6)", async () => {
    const project = await client.createProject({ name: "Chain", goal: "Steps in order" });
    const first = await client.createTask(project.id, {
      title: "Create index.html",
      outcome: "index.html exists",
      acceptanceCriteria: [],
      riskTier: 0,
      priority: "high",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    await client.createTask(project.id, {
      title: "Add script.js",
      outcome: "script.js exists",
      acceptanceCriteria: [],
      riskTier: 0,
      priority: "medium",
      status: "ready",
      dependsOn: [first.id],
      budgetUsdMicro: 0,
    });
    const check = await client.startCheck(project.id);
    expect(check.runnable.map((t) => t.title)).toEqual(["Create index.html"]);
    expect(check.later.map((t) => t.title)).toEqual(["Add script.js"]);
    expect(check.blocked).toBeNull();
    expect(check.sessionBudget.chfMicro).toBeGreaterThan(0);
    expect(check.monthLeft?.chfMicro).toBeGreaterThan(0);
    // Stop all: refused before Start with the reason and the button.
    await client.kill({ scope: "all", reason: "stop all from the UI" });
    expect((await client.startCheck(project.id)).blocked).toMatchObject({
      kind: "stopped",
      sentence: "Sessions are stopped (Stop all), so nothing can start.",
      action: { kind: "resume", label: "Allow sessions again" },
    });
    await client.resume();
    // A budget above what is left this month is refused in words.
    const tooMuch = (check.monthLeft?.usdMicro ?? 0) + 1_000_000;
    const refused = await client
      .startSession({ agentId, projectId: project.id, trigger: "manual", budgetUsdMicro: tooMuch })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toContain(
      "That is more than what is left of your monthly cap",
    );
    // A project where nothing can run says why.
    const empty = await client.createProject({ name: "Empty", goal: "Nothing yet" });
    expect((await client.startCheck(empty.id)).blocked).toMatchObject({
      kind: "nothing_runnable",
      sentence: "Nothing can run: no task is ready.",
      action: { kind: "link", label: "Open Tasks", to: `/projects/${empty.id}/tasks` },
    });
  });

  it("stop after this task on a session nothing runs: it ends at once, as asked (design §3.7)", async () => {
    let ghost = await rt.store.session.insert({
      agent_id: agentId,
      project_id: projectId,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1_000_000,
      step_cap: 10,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: agentId,
    });
    ghost = await rt.store.session.start(ghost.id, ghost.version);
    const stopped = await client.pauseSession(ghost.id);
    expect(stopped).toMatchObject({
      id: ghost.id,
      status: "stopped",
      stopReason: "stopped_after_task",
      statusText: "Stopped after the task, as asked",
    });
  });

  it("dependencies: refused when unknown, changed by title from the Tasks tab, named by the start check (U-040)", async () => {
    const deps = await client.createProject({ name: "Deps", goal: "Tasks that can run" });
    const newTask = (
      title: string,
      dependsOn: string[] = [],
      status: "draft" | "ready" = "draft",
    ) =>
      client.createTask(deps.id, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: [],
        priority: "medium",
        status,
        dependsOn,
        budgetUsdMicro: 0,
      });
    // The New task dialog's call with a dependency that is no task of the project.
    const refused = await newTask("Ship it", ["tsk_typo"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409 });
    expect((refused as ApiError).message).toContain(
      '"tsk_typo" is not a task of this project. Pick the tasks it waits on',
    );
    const parser = await newTask("Write the parser");
    const tests = await newTask("Write the tests", [parser.id], "ready");
    expect(tests.dependsOn).toEqual([parser.id]);
    // The start check names the ready task and what it waits on.
    const check = await client.startCheck(deps.id, { budgetUsdMicro: 5_000_000 });
    expect(check).toMatchObject({ ready: 1, runnable: [], overBudget: [] });
    expect(check.sessionBudget.usdMicro).toBe(5_000_000);
    expect(check.waiting).toEqual([
      {
        taskId: tests.id,
        title: "Write the tests",
        waitsOn: [{ taskId: parser.id, title: "Write the parser", status: "draft" }],
      },
    ]);
    // The Tasks tab's Depends on… dialog: every dependency it keeps, the version, a reason.
    const freed = await client.setTaskDependencies(tests.id, {
      version: tests.version,
      dependsOn: [],
      reason: "Dependencies changed in the app",
    });
    expect(freed).toMatchObject({
      id: tests.id,
      dependsOn: [],
      reason: "Dependencies changed in the app",
    });
    expect((await client.startCheck(deps.id)).runnable.map((t) => t.title)).toEqual([
      "Write the tests",
    ]);
    // A cycle is refused with the titles; nothing changes.
    await client.setTaskDependencies(tests.id, {
      version: freed.version,
      dependsOn: [parser.id],
      reason: "needs the parser",
    });
    const cycle = await client
      .setTaskDependencies(parser.id, {
        version: parser.version,
        dependsOn: [tests.id],
        reason: "loop",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(cycle).toBeInstanceOf(ApiError);
    expect((cycle as ApiError).message).toContain(
      '"Write the tests" already waits on "Write the parser"',
    );
  });

  it("Tasks tab: rows in run order with their status in words; Waiting for a task and for Docker (design §2, §3.5)", async () => {
    const own = await client.createProject({ name: "Hand tasks", goal: "Tasks made by hand" });
    const add = (title: string, extra: Partial<Parameters<DaemonClient["createTask"]>[1]> = {}) =>
      client.createTask(own.id, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: [],
        ...extra,
      });
    const readme = await add("Write a README for the project");
    // New task answers the change log entry with its Undo, like every change from the tab.
    expect(readme.change?.sentence).toBe('Added "Write a README for the project" to Hand tasks.');
    expect(readme.change?.undoToken).toBe(readme.change?.changeLogId);
    const license = await add("Add a LICENSE file (MIT)", { riskTier: 2 });
    const notes = await add("Create notes/todo.md", { dependsOn: [readme.id], priority: "high" });
    const mine = await add("Confirm the hosting with me", { specialist: "person" });
    expect(mine.specialist).toBe("person");
    const rows = await client.tasks(own.id);
    // Run order: what a task waits for comes before it, then priority, then age.
    expect(rows.map((t) => t.title)).toEqual([
      "Write a README for the project",
      "Create notes/todo.md",
      "Add a LICENSE file (MIT)",
      "Confirm the hosting with me",
    ]);
    expect(rows.map((t) => t.runOrder)).toEqual([0, 1, 2, 3]);
    const label = (id: string) => rows.find((t) => t.id === id)?.display?.label;
    expect(label(readme.id)).toBe("Ready");
    expect(label(notes.id)).toBe('Waiting for "Write a README for the project"');
    // No Docker on this computer: the full-review task waits for it, in words.
    expect(label(license.id)).toBe("Waiting for Docker");
    const docker = rows.find((t) => t.id === license.id)?.display?.detail ?? "";
    expect(docker).toBe(
      "Full review needs Docker, not running on this computer. Set it up, or edit to a light review.",
    );
    expect(docker.length).toBeLessThanOrEqual(100);
    // No raw state, tier or id in anything the row says.
    const said = JSON.stringify(rows.map((t) => t.display));
    expect(said).not.toMatch(/needs_human|in_progress|claimed|tier \d|request 01/);
    // The drawer: what it asks for and what waits on it.
    const detail = await client.task(readme.id);
    expect(detail.task.outcome).toBe("Write a README for the project is done");
    expect(detail.waitedOnBy).toEqual([{ taskId: notes.id, title: "Create notes/todo.md" }]);
    expect(detail.runs).toEqual([]);
    expect((await client.task(notes.id)).waitsOn).toEqual([
      {
        taskId: readme.id,
        title: "Write a README for the project",
        status: "Ready",
        done: false,
      },
    ]);
  });

  it("Tasks tab actions: Pause makes no card and no 'needs you'; Resume; every action has its Undo (design §3.5)", async () => {
    const own = await client.createProject({ name: "Actions", goal: "One undo per action" });
    const task = await client.createTask(own.id, {
      title: "Create notes/todo.md",
      outcome: "notes/todo.md lists the next steps",
    });
    const open = async () =>
      (await client.inbox(humanId)).requests.filter((r) => r.projectId === own.id).length;
    const cardsBefore = await open();
    const paused = await client.taskAction(task.id, { version: task.version, action: "pause" });
    expect(paused.display?.label).toBe("Paused by you");
    expect(paused.change?.sentence).toBe(
      'Paused "Create notes/todo.md": no session runs it until you press Resume.',
    );
    // A pause is the person's own: no Inbox card, and the project does not say "needs you".
    expect(await open()).toBe(cardsBefore);
    expect((await client.project(own.id)).needsYou).toBeNull();
    // Changes says what they pressed in the button's words, never the action's key.
    const logged = (await client.changes({ projectId: own.id })).find(
      (ch) => ch.id === paused.change?.changeLogId,
    );
    expect(logged?.wordsUsed).toBe("Pause");
    // Undo puts it back as it was.
    const undone = await client.undoChange(paused.change?.undoToken ?? "");
    expect(undone.sentence).toBe('Undone: the task "Create notes/todo.md" is ready again.');
    let row = (await client.tasks(own.id)).find((t) => t.id === task.id);
    expect(row?.display?.label).toBe("Ready");
    // Pause again, then Resume with a note: it is ready and the note waits for its brief.
    const again = await client.taskAction(task.id, {
      version: row?.version ?? 0,
      action: "pause",
    });
    const resumed = await client.taskAction(task.id, {
      version: again.version,
      action: "resume",
      note: "Keep it under 20 lines.",
    });
    expect(resumed.display?.label).toBe("Ready");
    expect(resumed.change?.sentence).toBe(
      '"Create notes/todo.md" is ready again. Your note goes into its next brief.',
    );
    const queued = await client.queue(own.id);
    expect(queued.map((q) => q.text)).toContain(
      'About "Create notes/todo.md": Keep it under 20 lines.',
    );
    // Undo takes the note back with the move.
    await client.undoChange(resumed.change?.undoToken ?? "");
    row = (await client.tasks(own.id)).find((t) => t.id === task.id);
    expect(row?.display?.label).toBe("Paused by you");
    expect(
      (await client.queue(own.id)).find((q) => q.text.endsWith("Keep it under 20 lines."))?.status,
    ).toBe("dismissed");
    // A stale row: the 409 says what the task is now, and carries it for the row.
    const stale = await client.taskAction(task.id, { version: task.version, action: "pause" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(ApiError);
    expect((stale as ApiError).message).toBe("This task changed: it is now Paused by you.");
    expect(((stale as ApiError).details?.task as { version?: number })?.version).toBe(row?.version);
    // An action the status does not offer is refused in words.
    const notOffered = await client
      .taskAction(task.id, { version: row?.version ?? 0, action: "redo" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((notOffered as ApiError).message).toBe(
      '"Create notes/todo.md" is Paused by you: Redo is not offered for it.',
    );
  });

  it("Tasks tab: Cancel names what waits on it; Reopen and Redo bring tasks back; Edit lowers the review level (U-080, design §3.5)", async () => {
    const own = await client.createProject({ name: "Reopen", goal: "Nothing is final" });
    const first = await client.createTask(own.id, {
      title: "Write a README",
      outcome: "README.md says what it is",
    });
    const next = await client.createTask(own.id, {
      title: "Create notes/todo.md",
      outcome: "notes/todo.md exists",
      dependsOn: [first.id],
    });
    const cancelled = await client.taskAction(first.id, {
      version: first.version,
      action: "cancel",
    });
    expect(cancelled.display?.label).toBe("Cancelled");
    expect(cancelled.change?.sentence).toBe(
      'Cancelled "Write a README". "Create notes/todo.md" waits on it and is stuck now.',
    );
    expect((await client.tasks(own.id)).find((t) => t.id === next.id)?.display?.label).toBe(
      'Stuck: "Write a README" was cancelled',
    );
    const reopened = await client.taskAction(first.id, {
      version: cancelled.version,
      action: "reopen",
    });
    expect(reopened.display?.label).toBe("Ready");
    expect(reopened.change?.sentence).toBe('Reopened "Write a README": it is ready again.');
    // Redo on a done task, with what to fix: ready again, the note queued for its brief.
    const t = await rt.store.task.mustGet(first.id);
    await rt.store.task.restoreStatus(t.id, t.version, "done", "work done", { agentId });
    const doneRow = (await client.tasks(own.id)).find((x) => x.id === first.id);
    expect(doneRow?.display?.label).toBe("Done");
    const redo = await client.taskAction(first.id, {
      version: doneRow?.version ?? 0,
      action: "redo",
      note: "The README must say how to open index.html.",
    });
    expect(redo.status).toBe("ready");
    expect(redo.change?.sentence).toBe(
      'Reopened "Write a README" to redo it: the next session works on it again. Your note goes into its next brief.',
    );
    expect((await client.queue(own.id)).map((q) => q.text)).toContain(
      'About "Write a README": The README must say how to open index.html.',
    );
    // Undo of the Redo: done again.
    await client.undoChange(redo.change?.undoToken ?? "");
    expect((await client.tasks(own.id)).find((x) => x.id === first.id)?.display?.label).toBe(
      "Done",
    );
    // Edit: a full-review task waiting for Docker goes to a light review and is ready.
    const full = await client.createTask(own.id, {
      title: "Add a LICENSE file (MIT)",
      outcome: "LICENSE holds the MIT text",
      riskTier: 2,
    });
    expect(full.display?.label).toBe("Waiting for Docker");
    const edited = await client.updateTask(full.id, { version: full.version, riskTier: 1 });
    expect(edited.riskTier).toBe(1);
    expect(edited.display?.label).toBe("Ready");
    expect(edited.change?.sentence).toBe(
      'Changed "Add a LICENSE file (MIT)": review level to Light review.',
    );
    await client.undoChange(edited.change?.undoToken ?? "");
    expect((await client.tasks(own.id)).find((x) => x.id === full.id)?.riskTier).toBe(2);
    // What it waits for, through the command: logged with its Undo.
    const deps = await client.setTaskDependencies(next.id, {
      version: (await client.tasks(own.id)).find((x) => x.id === next.id)?.version ?? 0,
      dependsOn: [],
    });
    expect(deps.change?.sentence).toBe('"Create notes/todo.md" waits for no other task now.');
    await client.undoChange(deps.change?.undoToken ?? "");
    expect((await client.tasks(own.id)).find((x) => x.id === next.id)?.dependsOn).toEqual([
      first.id,
    ]);
  });

  it("Tasks tab: Go ahead without on a task waiting for answers withdraws its card with a line (design §3.8)", async () => {
    const own = await client.createProject({ name: "Answers", goal: "Cards follow tasks" });
    const task = await client.createTask(own.id, {
      title: "Decide where the page is published",
      outcome: "The place is chosen",
    });
    const t = await rt.store.task.mustGet(task.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "asks the person", {
      agentId,
    });
    const card = await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: own.id,
      task_id: task.id,
      kind: "decision",
      why: "Where should the page be published?",
      options: ["Cancel the task"],
      blocking: true,
      risk: "low",
    });
    const row = (await client.tasks(own.id)).find((x) => x.id === task.id);
    expect(row?.display).toMatchObject({
      label: "Needs your answer",
      blocker: { kind: "card", requestId: card.id },
    });
    expect((await client.task(task.id)).cards).toEqual([
      { requestId: card.id, question: "Where should the page be published?" },
    ]);
    const went = await client.taskAction(task.id, {
      version: row?.version ?? 0,
      action: "go_ahead",
    });
    expect(went.display?.label).toBe("Ready");
    expect(went.change?.sentence).toBe(
      '"Decide where the page is published" is ready again. Its card in the Inbox was withdrawn.',
    );
    expect((await rt.store.humanRequest.mustGet(card.id)).status).toBe("withdrawn");
    // No longer a card that needs you; the Answered list says it was withdrawn (design §3.8).
    const afterGo = await client.inbox(humanId);
    expect(afterGo.requests.filter((r) => r.status === "open").map((r) => r.id)).not.toContain(
      card.id,
    );
    expect(afterGo.requests.find((r) => r.id === card.id)).toMatchObject({
      status: "withdrawn",
      outcome: "Withdrawn: you moved the task, so this card was closed.",
    });
    // The specialist is told the person went ahead without answering.
    expect((await client.queue(own.id)).map((q) => q.text).join("\n")).toContain(
      "The person chose to go ahead without answering",
    );
    // Undo puts it back as it was: it needs the answer again and its card is back in the
    // Inbox; the note for the brief is taken back.
    const undone = await client.undoChange(went.change?.undoToken ?? "");
    expect(undone.status).toBe("done");
    expect(undone.sentence).toBe(
      'Undone: the task "Decide where the page is published" needs your answer again; its card is back in the Inbox.',
    );
    const back = (await client.tasks(own.id)).find((x) => x.id === task.id);
    expect(back?.display).toMatchObject({
      label: "Needs your answer",
      blocker: { kind: "card", requestId: card.id },
    });
    expect((await rt.store.humanRequest.mustGet(card.id)).status).toBe("open");
    expect(
      (await client.inbox(humanId)).requests.filter((r) => r.status === "open").map((r) => r.id),
    ).toContain(card.id);
    expect(
      (await client.queue(own.id)).filter(
        (q) => q.status === "queued" && q.text.includes("go ahead without answering"),
      ),
    ).toEqual([]);
  });

  it("Tasks tab: Cancel and Try again withdraw a task's card; Undo brings the card back and the task as it was (design §3.5, §3.8)", async () => {
    const own = await client.createProject({ name: "Cards back", goal: "Undo is whole" });
    const card = async (taskId: string, why: string) =>
      rt.store.humanRequest.insert({
        human_id: humanId,
        project_id: own.id,
        task_id: taskId,
        kind: "decision",
        why,
        options: ["Try again", "Cancel"],
        blocking: true,
        risk: "low",
      });
    // The cards that need you: a withdrawn one moves to the Answered list (design §3.8).
    const inboxIds = async () =>
      (await client.inbox(humanId)).requests.filter((r) => r.status === "open").map((r) => r.id);
    const rowOf = async (id: string) => (await client.tasks(own.id)).find((x) => x.id === id);

    // A task that waits for the person's answer, cancelled and then undone.
    const asks = await client.createTask(own.id, {
      title: "Pick the colour scheme",
      outcome: "The colours are chosen",
    });
    let t = await rt.store.task.mustGet(asks.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "asked the person", {
      agentId,
    });
    const question = await card(asks.id, "Which colours should the page use?");
    const cancelled = await client.taskAction(asks.id, {
      version: (await rowOf(asks.id))?.version ?? 0,
      action: "cancel",
    });
    expect(cancelled.change?.sentence).toBe(
      'Cancelled "Pick the colour scheme". Its card in the Inbox was withdrawn.',
    );
    expect(await inboxIds()).not.toContain(question.id);
    const undoCancel = await client.undoChange(cancelled.change?.undoToken ?? "");
    expect(undoCancel.sentence).toBe(
      'Undone: reopened the task "Pick the colour scheme"; it needs your answer again and its card is back in the Inbox.',
    );
    expect((await rowOf(asks.id))?.display?.label).toBe("Needs your answer");
    expect(await inboxIds()).toContain(question.id);
    // The agent's reason is back on the row, not the undo's.
    expect((await rt.store.task.mustGet(asks.id)).reason).toBe("asked the person");

    // A task that failed after its tries, with its card: Try again, then Undo.
    const broken = await client.createTask(own.id, {
      title: "Style the page in styles.css",
      outcome: "styles.css styles the page",
    });
    t = await rt.store.task.mustGet(broken.id);
    t = await rt.store.task.transition(
      t.id,
      t.version,
      "failed",
      "retry ladder exhausted after 4 failed attempt(s) (ceiling opus): could not do it",
      { agentId },
    );
    const attemptBefore = t.attempt;
    const retry = await card(
      broken.id,
      'Retry ladder exhausted for "Style the page in styles.css"',
    );
    expect((await rowOf(broken.id))?.display?.label).toBe("Failed: tried 4 times");
    const again = await client.taskAction(broken.id, {
      version: (await rowOf(broken.id))?.version ?? 0,
      action: "try_again",
    });
    expect(again.display?.label).toBe("Ready");
    expect(await inboxIds()).not.toContain(retry.id);
    const undoAgain = await client.undoChange(again.change?.undoToken ?? "");
    expect(undoAgain.sentence).toBe(
      'Undone: the task "Style the page in styles.css" is marked failed again; its card is back in the Inbox.',
    );
    expect((await rowOf(broken.id))?.display?.label).toBe("Failed: tried 4 times");
    expect(await inboxIds()).toContain(retry.id);
    // The retry count is as it was, so the next Try again is counted once.
    expect((await rt.store.task.mustGet(broken.id)).attempt).toBe(attemptBefore);
    // Edit keeps what the status says: still why it failed, not the edit.
    const edited = await client.updateTask(broken.id, {
      version: (await rowOf(broken.id))?.version ?? 0,
      priority: "high",
    });
    expect(edited.display?.label).toBe("Failed: tried 4 times");
    expect(edited.change?.sentence).toBe(
      'Changed "Style the page in styles.css": priority to High.',
    );
    // An agent's pause without a card stays the agent's ("Paused"), not "Paused by you".
    const parked = await client.createTask(own.id, {
      title: "Check the links",
      outcome: "Every link works",
    });
    t = await rt.store.task.mustGet(parked.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "the run hit its budget", {
      agentId,
    });
    const before = await rowOf(parked.id);
    expect(before?.display?.label).toBe("Paused");
    const parkedEdit = await client.updateTask(parked.id, {
      version: before?.version ?? 0,
      riskTier: 0,
    });
    expect(parkedEdit.display?.label).toBe("Paused");
    expect(parkedEdit.display?.detail).toContain("the run hit its budget");

    // A task only the person can do: nobody goes ahead without its answers.
    const mine = await client.createTask(own.id, {
      title: "Choose the domain name",
      outcome: "The domain is chosen",
      specialist: "person",
    });
    // Its questions are a card at once (design §3.8): it already needs the person's answer.
    expect(mine.display?.label).toBe("Needs your answer");
    const refused = await client
      .taskAction(mine.id, { version: (await rowOf(mine.id))?.version ?? 0, action: "go_ahead" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((refused as ApiError).message).toBe(
      '"Choose the domain name" is a task only you can do: answer its card in the Inbox, or cancel it.',
    );
    expect((await rowOf(mine.id))?.display?.label).toBe("Needs your answer");
  });

  it("priority: New task's level comes back as the word; an old row's number reads as its level, highest first (U-041)", async () => {
    const levels = await client.createProject({ name: "Levels", goal: "High first" });
    // A row from before the change holds a number; the higher ran first.
    await rt.store.task.insert({
      project_id: levels.id,
      title: "Old urgent",
      outcome: "x",
      status: "draft",
      priority: 9,
    });
    await rt.store.task.insert({
      project_id: levels.id,
      title: "Old later",
      outcome: "x",
      status: "draft",
      priority: 2,
    });
    // What the New task dialog sends.
    const created = await client.createTask(levels.id, {
      title: "New normal",
      outcome: "it is done",
      acceptanceCriteria: [],
      priority: "medium",
      status: "draft",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    expect(created.priority).toBe("medium");
    expect((await client.tasks(levels.id)).map((t) => [t.title, t.priority])).toEqual([
      ["Old urgent", "high"],
      ["New normal", "medium"],
      ["Old later", "low"],
    ]);
  });

  it("extensions: Approve or Deny in the panel takes the card out of the Inbox (U-030)", async () => {
    // The cards that need you: an answered one moves to the Answered list (design §3.8).
    const cardsFor = async (extensionId: string) =>
      (await client.inbox(humanId)).requests.filter(
        (r) =>
          r.status === "open" &&
          (r.changeCard as { extensionId?: string } | null)?.extensionId === extensionId,
      );
    const approveMe = await client.addExtension({ catalogId: "browser" });
    expect(approveMe.status).toBe("pending_approval");
    expect((await cardsFor(approveMe.id)).map((r) => r.options)).toEqual([["Approve", "Deny"]]);
    expect((await client.approveExtension(approveMe.id)).status).toBe("enabled");
    expect(await cardsFor(approveMe.id)).toEqual([]);

    const denyMe = await client.addExtension({ catalogId: "cloudflare" });
    expect(await cardsFor(denyMe.id)).toHaveLength(1);
    await client.denyExtension(denyMe.id);
    expect(await cardsFor(denyMe.id)).toEqual([]);
    expect((await client.extensions()).map((e) => e.id)).not.toContain(denyMe.id);
  });

  it("extensions: Add on a built-in entry is confirmed in the panel on this PC's device, with no Inbox card; Cancel adds nothing (U-026)", async () => {
    // The cards that need you: an answered one moves to the Answered list (design §3.8).
    const cardsFor = async (extensionId: string) =>
      (await client.inbox(humanId)).requests.filter(
        (r) =>
          r.status === "open" &&
          (r.changeCard as { extensionId?: string } | null)?.extensionId === extensionId,
      );
    const me = await client.me();
    expect(me.desktopDeviceId).toEqual(expect.any(String));
    // What the panel's Add sends: the entry waits with its change card, nothing in the Inbox.
    const added = await client.addExtension({ catalogId: "desktop-control", confirmIn: "panel" });
    expect(added).toMatchObject({
      status: "pending_approval",
      pendingStage: "grant",
      confirmIn: "panel",
    });
    expect(added.review?.permissions.tools).toContain("desktop_click");
    expect(added.review?.permissions.scopes.length).toBeGreaterThan(0);
    expect(await cardsFor(added.id)).toEqual([]);
    // A plain yes is not the high-risk confirmation: refused, the row still waits.
    const plain = await client.approveExtension(added.id).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(ApiError);
    expect(plain).toMatchObject({ status: 403, code: "approval_required" });
    expect((plain as ApiError).message).toContain("Confirm on this device");
    // A device that is not one of this human's paired devices: refused by the policy.
    const foreign = await client
      .approveExtension(added.id, { answer: "device", deviceId: "device_not_paired" })
      .catch((e: unknown) => e);
    expect(foreign).toMatchObject({ status: 403, code: "approval_required" });
    expect((await client.extension(added.id)).status).toBe("pending_approval");
    // This PC's device, as the dialog's Confirm sends it: granted, and still no card.
    const granted = await client.approveExtension(added.id, {
      answer: "device",
      deviceId: me.desktopDeviceId ?? "",
    });
    expect(granted).toMatchObject({ status: "enabled", confirmIn: null });
    expect(await cardsFor(added.id)).toEqual([]);
    const audit = await rt.store.auditLog.list({ tool: "extensions.confirm_device" });
    expect(audit.map((a) => a.allowed)).toEqual([false, true]);

    // Cancel: the dialog takes the row back; nothing is left and no card was ever filed.
    const cancelled = await client.addExtension({ catalogId: "cloudflare", confirmIn: "panel" });
    expect(cancelled.confirmIn).toBe("panel");
    await client.denyExtension(cancelled.id);
    expect((await client.extensions()).map((e) => e.id)).not.toContain(cancelled.id);
    expect(await cardsFor(cancelled.id)).toEqual([]);
  });

  it("extensions: the agent's email row is read-only and points to the Email page; email is no catalog entry (U-075)", async () => {
    // Opening the Email page creates the agent's settings row, which the panel lists.
    const settings = await client.emailSettings(agentId);
    const row = (await client.extensions()).find((e) => e.name === `email:${agentId}`);
    expect(row).toMatchObject({ kind: "capability", managedIn: "email" });
    // Its switch and Remove are refused with where it is set; nothing changes.
    for (const attempt of [
      () => client.toggleExtension(row?.id ?? "", !row?.enabled),
      () => client.removeExtension(row?.id ?? ""),
    ]) {
      const refused = await attempt().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ApiError);
      expect(refused).toMatchObject({ status: 400 });
      expect((refused as ApiError).message).toContain("set on the Email page");
    }
    expect(await client.emailSettings(agentId)).toEqual(settings);
    expect((await client.extensionCatalog()).entries.map((e) => e.id)).not.toContain("email");
  });

  it("project card: only a card is 'needs you' (a task an agent left without one wants attention); its card makes it blocked and names it; a person's Pause is neither (U-071, design §2, §3.8)", async () => {
    const own = await client.createProject({ name: "Health", goal: "State follows reality" });
    const task = await client.createTask(own.id, {
      title: "Confirm the stack",
      outcome: "The stack is chosen",
      acceptanceCriteria: ["chosen"],
    });
    // The Tasks tab's Pause: the person's own, so nothing waits on them (design §2).
    const paused = await client.taskAction(task.id, { version: task.version, action: "pause" });
    expect(paused.display?.label).toBe("Paused by you");
    expect((await client.project(own.id)).needsYou).toBeNull();
    await client.taskAction(task.id, { version: paused.version, action: "resume" });
    // A session left it needing the person (a budget stop) with no card: the project wants
    // attention, but nothing is "needs you" without a card (design §3.8), so "needs you: X"
    // never stands beside "Waiting on you 0".
    const t = await rt.store.task.mustGet(task.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "budget stop", { agentId });
    const named = await client.project(own.id);
    expect(named.health).toBe("attention");
    expect(named.needsYou).toBeNull();
    expect(named.waitingOnYou).toBe(0);
    await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: own.id,
      task_id: task.id,
      kind: "decision",
      why: "Which stack?",
      steps: [],
      options: ["Node", "Python"],
      blocking: false,
      risk: "low",
      change_card: null,
    });
    // Its card: blocked, and the card names it, as the Inbox counts it.
    const blocked = await client.project(own.id);
    expect(blocked.health).toBe("blocked");
    expect(blocked.needsYou).toEqual({ taskId: task.id, title: "Confirm the stack" });
    expect(blocked.waitingOnYou).toBe(1);
    expect((await client.projects()).find((p) => p.id === own.id)?.needsYou?.title).toBe(
      "Confirm the stack",
    );
  });

  it("an Undo on the Changes page that brings a card back tells the header (inbox.changed), so its count is true at once", async () => {
    const own = await client.createProject({ name: "Undo count", goal: "The badge follows" });
    const task = await client.createTask(own.id, { title: "Pick the colours", outcome: "chosen" });
    const t = await rt.store.task.mustGet(task.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "asked the person", { agentId });
    await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: own.id,
      task_id: task.id,
      kind: "decision",
      why: "Which colours?",
      options: ["Cancel the task"],
      blocking: true,
      risk: "low",
    });
    const row = (await client.tasks(own.id)).find((x) => x.id === task.id);
    const cancelled = await client.taskAction(task.id, {
      version: row?.version ?? 0,
      action: "cancel",
    });
    let told = 0;
    const onInbox = () => {
      told++;
    };
    rt.events.on("inbox", onInbox);
    try {
      await client.undoChange(cancelled.change?.undoToken ?? "");
    } finally {
      rt.events.off("inbox", onInbox);
    }
    expect(told).toBeGreaterThan(0);
  });

  it("answers that came after their task had finished say so and offer Redo with these answers, whose next brief reads them (design §3.8)", async () => {
    const own = await client.createProject({ name: "Late", goal: "Answers in time" });
    const created = await client.createTask(own.id, {
      title: "Pick a quote list",
      outcome: "chosen",
    });
    let t = await rt.store.task.mustGet(created.id);
    t = await rt.store.task.transition(t.id, t.version, "needs_human", "asks", { agentId });
    const filed = await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: own.id,
      task_id: t.id,
      kind: "decision",
      why: '"Pick a quote list" needs your answers.',
      steps: ["Which quotes?"],
      options: ["Cancel the task"],
      blocking: true,
      risk: "low",
      change_card: {
        key: `person_questions:${t.id}`,
        task_id: t.id,
        task_title: t.title,
        questions: ["Which quotes?"],
        source: "specialist",
        on_answer: "ready",
        context: null,
        applied_at: null,
      },
    });
    // The task moved on without the answers (an agent closed it): ready to done.
    for (const to of ["ready", "claimed", "in_progress", "in_review", "done"] as const) {
      t = await rt.store.task.mustGet(t.id);
      t = await rt.store.task.transition(t.id, t.version, to, "moved on", { agentId });
    }
    const late = await client.answerRequest(filed.id, {
      version: filed.version,
      answer: { answers: [{ question: "Which quotes?", answer: "Only Seneca." }] },
    });
    expect(late.outcome).toBe(
      'Your answers came after "Pick a quote list" had finished. They are kept in the decision record.',
    );
    expect(late.followUp).toMatchObject({ label: "Redo with these answers", action: "redo" });
    const row = (await client.tasks(own.id)).find((x) => x.id === t.id);
    const redone = await client.taskAction(t.id, { version: row?.version ?? 0, action: "redo" });
    expect(redone.status).toBe("ready");
    // The next attempt's brief carries the answers.
    expect(await answersBlockFor(rt.store, t.id)).toContain("Only Seneca.");
  });

  it("New task with 'Me: ask me in the Inbox' is a question card at once, and no session runs it (design §3.5, §3.8)", async () => {
    const own = await client.createProject({ name: "Mine", goal: "A task for me" });
    const created = await client.createTask(own.id, {
      title: "Choose the hosting",
      outcome: "The hosting is chosen",
      acceptanceCriteria: ["Where should the site be hosted?"],
      specialist: "person",
    });
    // At once: no poll, no session.
    expect(created.display).toMatchObject({ key: "answer", label: "Needs your answer" });
    const card = (await client.inbox(humanId)).requests.find(
      (r) => r.taskId === created.id && r.status === "open",
    );
    expect(card?.title).toBe('"Choose the hosting" needs your answers');
    expect(card?.reply).toBe("form");
    expect((await client.startCheck(own.id)).runnable).toEqual([]);
    // A first-person title on the Tasks tab is the person's too.
    const said = await client.createTask(own.id, {
      title: "Confirm the domain with me",
      outcome: "The domain is confirmed",
    });
    expect(said.display?.label).toBe("Needs your answer");
  });

  it("the Inbox does not echo the person: Tasks tab moves, chat commands and project switches add no Update (design §3.8, §5.11)", async () => {
    const own = await client.createProject({ name: "Quiet", goal: "No echoes" });
    const updates = async () =>
      (await client.inbox(humanId)).messages.filter(
        (m) => m.projectId === own.id || m.projectId === null,
      ).length;
    const before = await updates();
    const task = await client.createTask(own.id, {
      title: "Write notes.md",
      outcome: "notes.md exists",
    });
    let v = task.version;
    for (const action of ["pause", "resume", "pause", "resume"] as const)
      v = (await client.taskAction(task.id, { version: v, action })).version;
    for (const text of ["add a task: write the README", "add a task: write the FAQ"])
      await client.chat({ humanId, agentId, projectId: own.id, text, source: "text" });
    await client.executeCommands({
      commands: [{ name: "project.switch", params: { project: own.id } }],
      wordsUsed: `Switch project: ${own.name}`,
      source: "ui",
    });
    expect(await updates()).toBe(before);
    // They are in Changes, with their Undo.
    expect((await client.changes({ projectId: own.id })).length).toBeGreaterThanOrEqual(6);
  });

  it("setup: a human the daemon named with its placeholder gets an empty name field, not 'me' (U-077)", async () => {
    const before = await rt.store.human.mustGet(humanId);
    await rt.store.human.patch(humanId, { name: "me" });
    try {
      expect((await client.setupStatus()).name).toBe("");
    } finally {
      await rt.store.human.patch(humanId, { name: before.name });
    }
    expect((await client.setupStatus()).name).toBe(before.name);
  });

  it("start session under Stop all: 409 with what to do, not a server error (U-077)", async () => {
    expect((await client.kill({ scope: "all", reason: "stop all from the UI" })).killActive).toBe(
      true,
    );
    try {
      const refused = await client.startSession({ agentId, projectId, trigger: "manual" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(ApiError);
      expect(refused).toMatchObject({ status: 409, code: "killed" });
      expect((refused as ApiError).message).toBe(KILL_ACTIVE_START_MESSAGE);
    } finally {
      await client.resume();
    }
  });

  it("a task only the person can do: its questions are in the Inbox and the form's answers close it (U-022)", async () => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Confirm stack, hosting and repository with the human",
      outcome: "decided",
      status: "ready",
      specialist: "ops",
      reason: "a 1.0.3 plan",
      author_agent: agentId,
    });
    await rt.syncApprovals();
    const card = (await client.inbox(humanId)).requests.find(
      (r) => r.taskId === task.id && r.status === "open",
    );
    expect(card).toMatchObject({
      kind: "decision",
      options: ["Cancel the task"],
      steps: [
        "Stack: what do you choose?",
        "Hosting: what do you choose?",
        "Repository: what do you choose?",
      ],
    });
    // What the Inbox form sends: one answer per question, the blank ones left out.
    const answered = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: {
        answers: [
          { question: "Stack: what do you choose?", answer: "TypeScript and Hono" },
          { question: "Hosting: what do you choose?", answer: "Cloudflare" },
        ],
      },
    });
    expect(answered.status).toBe("answered");
    expect((await client.tasks(projectId)).find((t) => t.id === task.id)?.status).toBe("done");
    expect(
      (await client.inbox(humanId)).requests.some(
        (r) => r.taskId === task.id && r.status === "open",
      ),
    ).toBe(false);
    // Overview → Decisions (design §3.4, §5 "Decision"): each question with its answer in the
    // person's words and their name; never the card's instructions, JSON or an id.
    const decisions = (await client.decisions(projectId)).filter((d) => d.kind === "answer");
    expect(decisions.map((d) => [d.question, d.chosen, d.decidedByName])).toEqual(
      expect.arrayContaining([
        ["Stack: what do you choose?", "TypeScript and Hono", "J"],
        ["Hosting: what do you choose?", "Cloudflare", "J"],
      ]),
    );
    for (const d of decisions) {
      expect(`${d.question} ${d.chosen}`).not.toMatch(
        /[{}]|needs your answers|answer the questions/,
      );
      expect(d.options).toEqual([]);
    }
  });

  it("a failed plan from the brief: the project page reads why, and Retry drafts it again (U-046)", async () => {
    // The scripted model answers no plan, so the intake a new project asks for fails.
    const project = await client.createProject({
      name: "Briefed",
      goal: "Plan from a brief",
      brief: "A small site for the club.",
      intake: true,
    });
    expect((await client.intakeStatus(project.id)).state).toBe("drafting");
    await rt.intake.inFlight(project.id)?.catch(() => undefined);
    const failed = await client.intakeStatus(project.id);
    expect(failed).toMatchObject({ projectId: project.id, state: "failed", requestId: null });
    expect(failed.error).toEqual(expect.any(String));
    const retried = await client.retryIntake(project.id);
    expect(retried).toMatchObject({ projectId: project.id, state: "drafting", error: null });
    await rt.intake.inFlight(project.id)?.catch(() => undefined);
    expect((await client.intakeStatus(project.id)).state).toBe("failed");
  });

  it("every Inbox card names its task beside its project (U-073)", async () => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Set up the contact form",
      outcome: "mail arrives",
      status: "needs_human",
      reason: "seed",
    });
    const card = await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: projectId,
      task_id: task.id,
      kind: "approval",
      why: "Critic sign-off needed",
      steps: [],
      options: ["accept", "revise", "cancel"],
      blocking: true,
      risk: "medium",
    });
    const shown = (await client.inbox(humanId)).requests.find((r) => r.id === card.id);
    expect(shown).toMatchObject({ projectName: "Contract", taskTitle: "Set up the contact form" });
    await rt.store.humanRequest.withdraw(card.id, card.version);
  });

  it("answering a request: an answer that is none of a card's options is refused with them, the card stays (U-034)", async () => {
    const card = await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: projectId,
      kind: "approval",
      why: "The task cannot close: one critic finding is still open",
      steps: [],
      options: ["rework", "accept", "cancel"],
      blocking: true,
      risk: "medium",
      change_card: { key: "findings:blocked", applied_at: null },
    });
    const refused = await client
      .answerRequest(card.id, { version: card.version, answer: "maybe next week" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 400, code: "validation" });
    expect((refused as ApiError).message).toContain("Choose one of: rework, accept, cancel");
    const inbox = await client.inbox(humanId);
    const still = inbox.requests.find((r) => r.id === card.id);
    expect(still?.status).toBe("open");
    const answered = await client.answerRequest(card.id, {
      version: still?.version ?? card.version,
      answer: "Rework",
    });
    expect(answered.status).toBe("answered");
  });

  it("Settings -> Devices without a state service: what pairing needs, for the plain steps (U-055)", async () => {
    const list = await client.devices();
    expect(list.pairingAvailable).toBe(false);
    expect(list.pairingSetup).toMatchObject({
      serviceUrl: null,
      adminSecretName: "state_api_admin",
      adminSecretStored: false,
    });
    expect(list.pairingSetup?.guideUrl).toContain(
      "docs/setup-guide.md#what-to-set-up-first-the-shared-state-service",
    );
    const refused = await client.startPairing().then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(503);
    expect((refused as ApiError).message).toContain(
      "environment variable FORERUNNER_STATE_API_URL",
    );
  });

  it("secrets typed in the app: a mailbox password and a voice key stored by name, never sent back (U-054)", async () => {
    const password = ["real", "daemon", "pass", "5".repeat(8)].join("-"); // not-a-secret
    const before = await client.storedSecrets("critic_imap_password");
    expect(before.secrets.map((s) => s.name)).toContain("agent_imap_password");
    expect(before.secrets.find((s) => s.name === "critic_imap_password")?.stored).toBe(false);
    const stored = await client.storeSecret("agent_imap_password", password);
    expect(stored).toEqual({
      name: "agent_imap_password",
      stored: true,
      ref: "secret:agent_imap_password",
    });
    expect(await rt.vault.get("agent_imap_password")).toBe(password);
    const after = await client.storedSecrets();
    expect(after.secrets.find((s) => s.name === "agent_imap_password")?.stored).toBe(true);
    expect(JSON.stringify(after)).not.toContain(password);
    const refused = await client.storeSecret("github_token", password).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).message).toContain("is not a secret the app stores");
    expect(await rt.vault.has("github_token")).toBe(false);
  });

  it("Settings' subscription allowance: CHF in, USD stored, read back in CHF (U-052)", async () => {
    const before = await client.planAllowance();
    expect(before).toMatchObject({ usdMonthly: 50, origin: "default", overridden: false });
    expect(before.chfMonthly).toBeCloseTo(50 * before.chfPerUsd, 2);
    const saved = await client.setPlanAllowance(160);
    expect(saved.origin).toBe("config");
    expect(saved.usdMonthly).toBeCloseTo(160 / saved.chfPerUsd, 2);
    expect(saved.chfMonthly).toBeCloseTo(160, 1);
    expect(rt.billing.planAllowance.usdMonthly).toBe(saved.usdMonthly);
    expect((await client.planAllowance()).usdMonthly).toBe(saved.usdMonthly);
    const refused = await client.setPlanAllowance(0).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).message).toContain("positive amount of CHF per month");
  });

  it("Settings' Claude order: the credentials in order, Move up's order stored and in Changes (U-078)", async () => {
    const before = await client.billingOrder();
    expect(before).toMatchObject({
      chosen: false,
      order: ["subscription", "plan_credits", "api_key"],
    });
    // A subscription row and an API key row as a start seeds them (turned off here, so the
    // other cases' sessions keep running on the stand-in provider).
    for (const [kind, ref, priority] of [
      ["subscription", "anthropic_subscription_token", 1],
      ["api_key", "anthropic_api_key", 2],
    ] as const) {
      await rt.store.billingSource.insert({
        human_id: humanId,
        kind,
        label: kind,
        credential_ref: ref,
        limits: {},
        enabled: false,
        priority,
      });
    }
    const listed = await client.billingOrder();
    expect(listed.sources.map((s) => [s.kind, s.name, s.via, s.blocked])).toEqual([
      ["subscription", "Claude subscription", "claude_code", "disabled"],
      ["api_key", "API key", "api", "disabled"],
    ]);
    // What Move up on the API key row posts.
    const saved = await client.setBillingOrder(["api_key", "subscription"]);
    expect(saved).toMatchObject({ chosen: true, order: ["api_key", "subscription"] });
    expect(saved.sources.map((s) => s.kind)).toEqual(["api_key", "subscription"]);
    expect((await client.billingOrder()).order).toEqual(["api_key", "subscription"]);
    const change = (await client.changes({})).find((r) => r.sentence.includes("is used first"));
    expect(change?.sentence).toBe(
      "Set which Claude credential is used first from not chosen (the defaults) to the API key, then the Claude subscription: every model call uses them in this order, and when one cannot be used the next one is. Undo.",
    );
    const refused = await client.setBillingOrder(["api_key", "api_key"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).message).toContain("each once");
  });

  it("setup's GitHub check: the repositories the token reaches, with their access and warnings (U-051)", async () => {
    // GitHub as the daemon's check meets it; the token is a fixture, never a real one.
    const token = ["github_pat_", "realdaemon_", "1".repeat(40)].join(""); // not-a-secret
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body =
        url.pathname === "/user"
          ? { login: "joel" }
          : url.pathname === "/user/repos"
            ? [
                { full_name: "joel/site", permissions: { push: true, pull: true } },
                { full_name: "joel/notes", permissions: { push: false, pull: true } },
              ]
            : null;
      return new Response(JSON.stringify(body), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const checked = await client.setupGitHub({ token });
      expect(checked).toMatchObject({ ok: true, kind: "github", login: "joel" });
      expect(checked.repos).toEqual([
        { fullName: "joel/site", access: "write" },
        { fullName: "joel/notes", access: "read" },
      ]);
      expect(checked.summary).toBe("Token works for joel. It reaches 2 repositories.");
      expect(checked.problems.join("\n")).toContain("joel/notes: read only");
      expect(JSON.stringify(checked)).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it("one active project: the header's switch is /me's, a project's Chat tab wins for its turn (U-056)", async () => {
    const tab = await client.createProject({ name: "Tab project", goal: "Its own chat tab" });
    const switched = await client.executeCommands({
      commands: [{ name: "project.switch", params: { project: projectId } }],
      wordsUsed: "Switch project: Contract",
      source: "ui",
    });
    expect(switched.status).toBe("done");
    expect((await client.me()).activeProjectId).toBe(projectId);
    const reply = await client.chat({
      humanId,
      agentId,
      projectId: tab.id,
      projectTab: true,
      text: "add a task: write the tab README",
      source: "text",
    });
    expect(reply.actions.map((a) => a.kind)).toEqual(["task.create"]);
    expect((await client.tasks(tab.id)).map((t) => t.title)).toContain("write the tab README");
    expect(reply.activeProjectId).toBe(projectId);
    expect((await client.me()).activeProjectId).toBe(projectId);
  });

  it("a project created in the app starts at the default autonomy (U-058)", async () => {
    const set = await client.executeCommands({
      commands: [{ name: "settings.set", params: { key: "default_autonomy", value: 3 } }],
      wordsUsed: "Settings: Default autonomy for new projects to 3",
      source: "ui",
      confirm: "tap",
    });
    expect(set.status).toBe("done");
    // The level by its name (design §2), and the same change again is refused in words, with
    // nothing written to Changes (the walks: "from 3 to 3" was accepted and logged).
    expect(set.sentence).toMatch(/to Trusted \(level 3\)\. Undo\.$/);
    const changesBefore = (await client.changes()).length;
    const again = await client.executeCommands({
      commands: [{ name: "settings.set", params: { key: "default_autonomy", value: 3 } }],
      source: "ui",
      confirm: "tap",
    });
    expect(again).toMatchObject({
      status: "refused",
      code: "validation",
      reason: "The default autonomy for new projects is already Trusted (level 3).",
    });
    expect((await client.changes()).length).toBe(changesBefore);
    const created = await client.createProject({ name: "At three", goal: "Default autonomy" });
    expect(created.autonomyLevel).toBe(3);
  });

  it("undo of a lowered monthly cap waits for this PC; Changes logs it as ui (U-057, U-061)", async () => {
    const lowered = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 90 } }],
      source: "ui",
      confirm: "tap",
    });
    expect(lowered.status).toBe("done");
    const undo = await client.undoChange(lowered.changeLogId ?? "");
    expect(undo).toMatchObject({ status: "pending", decision: "needs_device" });
    const confirmed = await client.confirmCommand(undo.pendingId ?? "", { answer: "device" });
    expect(confirmed.status).toBe("done");
    const rows = await client.changes({});
    expect(rows.find((r) => r.id === confirmed.changeLogId)?.source).toBe("ui");
    expect(rows.find((r) => r.id === lowered.changeLogId)?.undoState).toBe("undone");
  });

  it("a task move is logged with Undo; an undo that cannot work says why (U-061)", async () => {
    const task = await client.createTask(projectId, {
      title: "Move me",
      outcome: "moved",
      acceptanceCriteria: [],
      riskTier: 1,
      status: "ready",
      priority: 1,
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    const moved = await client.transitionTask(task.id, {
      version: task.version,
      to: "cancelled",
      reason: "not needed",
    });
    expect(moved.status).toBe("cancelled");
    expect(moved.change?.undoToken).toBe(moved.change?.changeLogId);
    const undone = await client.undoChange(moved.change?.undoToken ?? "");
    expect(undone.sentence).toBe('Undone: reopened the task "Move me"; it is ready again.');
    const created = await client.chat({
      humanId,
      agentId,
      projectId,
      projectTab: true,
      text: "add a task: finish me",
      source: "text",
    });
    const changeId = created.actions[0]?.id ?? "";
    const made = (await client.tasks(projectId)).find((t) => t.title === "finish me");
    for (const to of ["claimed", "in_progress", "in_review", "done"] as const) {
      const t = await rt.store.task.mustGet(made?.id ?? "");
      await rt.store.task.transition(t.id, t.version, to, "work", { agentId });
    }
    const row = (await client.changes({ projectId })).find((r) => r.id === changeId);
    expect(row).toMatchObject({ undoable: false, undoState: "undoable" });
    expect(row?.undoBlockedReason).toContain("a done task cannot be cancelled");
  });

  it("Settings lists every setting with a label; the model rows say what runs; the allowlist saves (U-059, U-060)", async () => {
    const settings = await client.settings();
    const byKey = new Map(settings.map((s) => [s.key, s]));
    for (const key of [
      "human.quiet_hours",
      "human.notify_channel",
      "human.voice_alerts",
      "human.language",
      "human.model_watch",
      "project.session_cap",
      "project.critic_ceiling",
      "project.small_project_mode",
    ])
      expect(byKey.get(key)?.label, key).toEqual(expect.any(String));
    const quiet = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "22:00", end: "07:00" } },
        },
      ],
      source: "ui",
    });
    expect(quiet.status).toBe("done");
    // Times in words, never JSON (design §5; before: 'unset → {"start":"22:00",…}').
    expect(quiet.sentence).toBe("Set quiet hours from off to 22:00–07:00. Undo.");
    expect((await client.settings()).find((s) => s.key === "human.quiet_hours")?.value).toEqual({
      start: "22:00",
      end: "07:00",
    });
    const models = await client.modelSettings();
    const chat = models.agents[0]?.modes.find((m) => m.mode === "text_chat");
    expect(chat?.speedModeApplies).toBe(false);
    expect(chat?.ceiling?.raisable).toBe(false);
    const saved = await client.setDesktopAllowlist(humanId, ["code", "firefox"]);
    expect(saved.entries).toEqual([{ app: "code" }, { app: "firefox" }]);
    expect((await client.desktopAllowlist(humanId)).entries).toEqual([
      { app: "code" },
      { app: "firefox" },
    ]);
  });
});

/** A model call that waits an hour of simulated time that never passes: a task that runs. */
const WAITING_CALL = { ttftMs: 3_600_000, text: "never sent" };

/**
 * The UI client against a real daemon whose first specialist run waits until it is stopped.
 * By default model calls 1, 3 and 4 wait (each test's running task) and call 2 answers (U-039's
 * next task); `script` replaces that.
 */
async function composeWithWaitingRun(
  script: ConstructorParameters<typeof ScriptedProvider>[0] = [
    WAITING_CALL,
    { text: "Done." },
    WAITING_CALL,
    WAITING_CALL,
  ],
): Promise<{
  rt: RuntimeApp;
  client: DaemonClient;
  provider: ScriptedProvider;
}> {
  const home = mkdtempSync(join(tmpdir(), "fr-ui-real-run-"));
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const provider = new ScriptedProvider(script, clock);
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.0.0-ui-contract",
    // No Docker here, whatever the machine has (U-079): tasks at tier 0 and 1 run in the
    // process stand-in, as they do for a person without Docker.
    sandboxDetection: NO_ENGINE,
  });
  const { app, token } = createDaemonApp(rt);
  const client = createClient(
    {
      baseUrl: "http://daemon.test",
      token,
      source: "env",
      installId: null,
      platform: null,
      shellVersion: null,
    },
    (input, init) => Promise.resolve(app.request(input, init)),
  );
  return { rt, client, provider };
}

/** Real-time poll for what the daemon does at once; `seen` says what it saw last. */
async function eventually(
  cond: () => Promise<boolean>,
  what: string,
  seen: () => Promise<string> = async () => "",
  timeoutMs = 3000,
): Promise<void> {
  for (let i = 0; i < timeoutMs / 5; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what} (${await seen()})`);
}

/**
 * The system clock moved to another day: time passes as in the app (each run and each line of
 * a session's log has its own moment), from `start`.
 */
class ShiftedClock extends SystemClock {
  private readonly offset: number;
  constructor(start: string) {
    super();
    this.offset = new Date(start).getTime() - Date.now();
  }
  override now(): number {
    return Date.now() + this.offset;
  }
  override nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

describe("the UI client against the real daemon: a task a session is running", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    ({ rt, client, provider } = await composeWithWaitingRun());
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("Cancel on the running task: that task's run stops and the session goes on with the next (U-039)", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({
      name: "Running",
      goal: "Keep going",
      autonomyLevel: 2,
    });
    const task = (title: string, priority: "low" | "medium" | "high") =>
      client.createTask(project.id, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: [],
        riskTier: 0,
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
      });
    const first = await task("Long first task", "high");
    const second = await task("Second task", "low");
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    const tasks = () => client.tasks(project.id);
    const statusOf = async (id: string) => (await tasks()).find((t) => t.id === id)?.status;
    const seen = async () =>
      `session ${(await client.session(sessionId)).status}, ${provider.calls.length} model call(s), tasks ${(
        await tasks()
      )
        .map((t) => `${t.title}=${t.status}`)
        .join(", ")}`;
    // The first task's specialist is in its model call.
    await eventually(
      async () => (await statusOf(first.id)) === "in_progress" && provider.calls.length === 1,
      "the first task's run",
      seen,
    );

    // The Tasks tab's Cancel: the version the row shows, the target, the reason.
    const row = (await tasks()).find((t) => t.id === first.id);
    const moved = await client.transitionTask(first.id, {
      version: row?.version ?? 0,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
    expect(moved.status).toBe("cancelled");

    await eventually(
      async () => (await client.session(sessionId)).status === "completed",
      "the session to complete",
      seen,
    );
    expect(await statusOf(first.id)).toBe("cancelled");
    expect(await statusOf(second.id)).toBe("done");
    // The result names the work done; the person's own Cancel is not echoed (design §5.11).
    expect((await client.session(sessionId)).summary).toBe(
      'Did 1 task: "Second task".\nNothing left. CHF 0.00.',
    );
  });

  it("Start while a session runs: each waiting start says how many wait before it; none is replaced (U-043)", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Busy", goal: "One at a time" });
    const task = await client.createTask(project.id, {
      title: "Keeps the agent busy",
      outcome: "it is done",
      acceptanceCriteria: [],
      riskTier: 0,
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    const running = await client.startSession({ agentId, projectId: project.id });
    expect(running.result).toBe("started");
    expect(running.ahead).toBeUndefined();
    await eventually(
      async () => provider.calls.length === 3,
      "the running task's model call",
      async () => `${provider.calls.length} model call(s)`,
    );
    // The Start dialog's call twice while the session runs.
    const first = await client.startSession({ agentId, projectId: project.id });
    const second = await client.startSession({ agentId, projectId: project.id });
    expect(first).toMatchObject({ result: "queued", ahead: 0, session: null });
    expect(second).toMatchObject({ result: "queued", ahead: 1, session: null });
    expect(rt.scheduler.pendingStarts(agentId).map((e) => e.id)).toEqual([
      first.startId,
      second.startId,
    ]);
    // Leave nothing behind for the next test: drop the two waiting starts (they only drain on a
    // scheduler tick, which this simulated clock fires whenever it happens to move), end the
    // running task, and wait until the agent is free.
    rt.scheduler.cancelPending(agentId, "test cleanup", second.startId);
    rt.scheduler.cancelPending(agentId, "test cleanup", first.startId);
    const row = (await client.tasks(project.id)).find((t) => t.id === task.id);
    await client.transitionTask(task.id, {
      version: row?.version ?? 0,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
    await eventually(
      async () =>
        !rt.scheduler.isActive(agentId) && rt.scheduler.pendingStarts(agentId).length === 0,
      "the agent to be free",
      async () =>
        `active ${rt.scheduler.isActive(agentId)}, ${rt.scheduler.pendingStarts(agentId).length} waiting`,
      10_000,
    );
  });

  it("Stop on the running task: the row says Running with the agent's name; Stop ends that run and it is Paused by you (design §3.5)", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Stop it", goal: "Stop one task" });
    const task = await client.createTask(project.id, {
      title: "Long task to stop",
      outcome: "it is done",
      riskTier: 0,
    });
    const started = await client.startSession({ agentId, projectId: project.id });
    // Started at once, not queued behind something an earlier test left.
    expect(started.result).toBe("started");
    const sessionId = started.session?.id ?? "";
    const rowOf = async () => (await client.tasks(project.id)).find((t) => t.id === task.id);
    await eventually(
      async () => (await rowOf())?.display?.key === "running" && provider.calls.length === 4,
      "the task's run",
      async () => `${(await rowOf())?.status}, ${provider.calls.length} model call(s)`,
      10_000,
    );
    const running = await rowOf();
    expect(running?.display).toMatchObject({ label: "Running", agentName: "Alice" });
    expect(running?.display?.since).toEqual(expect.any(String));
    // The drawer lists the run while it goes.
    expect((await client.task(task.id)).runs[0]).toMatchObject({ outcome: "Running" });
    const stopped = await client.taskAction(task.id, {
      version: running?.version ?? 0,
      action: "stop",
    });
    expect(stopped.display?.label).toBe("Paused by you");
    expect(stopped.change?.sentence).toBe(
      'Stopped "Long task to stop": its run ended and it is paused until you press Resume.',
    );
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
    );
    expect((await rowOf())?.display?.label).toBe("Paused by you");
  });
});

describe("the UI client against the real daemon: the Tasks tab's Stop while a session goes on", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    // The first task's run waits until it is stopped; every later call answers.
    ({ rt, client, provider } = await composeWithWaitingRun([WAITING_CALL, { text: "Done." }]));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a task the person stopped is Paused by you, not 'needs your decision': the result and the Inbox do not echo the click (design §2, §5.11)", async () => {
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Stop one", goal: "Two pages" });
    const task = (title: string, priority: "low" | "high") =>
      client.createTask(project.id, { title, outcome: `${title} exists`, riskTier: 0, priority });
    const first = await task("Long first task", "high");
    const second = await task("Second task", "low");
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    const rowOf = async (id: string) => (await client.tasks(project.id)).find((t) => t.id === id);
    await eventually(
      async () =>
        (await rowOf(first.id))?.display?.key === "running" && provider.calls.length === 1,
      "the first task's run",
      async () => `${(await rowOf(first.id))?.status}, ${provider.calls.length} model call(s)`,
    );
    const running = await rowOf(first.id);
    const stopped = await client.taskAction(first.id, {
      version: running?.version ?? 0,
      action: "stop",
    });
    expect(stopped.display?.label).toBe("Paused by you");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
    );
    expect((await rowOf(first.id))?.display?.label).toBe("Paused by you");
    expect((await rowOf(second.id))?.status).toBe("done");
    // The session went on with the second task; the person's own Stop is not news, and the
    // paused task has no card, so nothing says it needs a decision in the Inbox.
    const session = await client.session(sessionId);
    expect(session.summary).toBe('Did 1 task: "Second task".\nCHF 0.00.');
    const inbox = await client.inbox(me.id);
    expect(inbox.requests.filter((r) => r.projectId === project.id)).toEqual([]);
    const lines = inbox.messages.filter((m) => m.projectId === project.id).map((m) => m.body);
    expect(lines).toContain('Stop one: did 1 task: "Second task".');
    expect(lines.filter((l) => /needs your decision/.test(l))).toEqual([]);
    // The Summary tab does not count it as an open question either.
    expect((await client.projectSummary(project.id)).openQuestions).toBe(0);
  });
});

describe("the UI client against the real daemon: the task drawer after a session ran its tasks (design §3.5)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-drawer-"));
    // Time moves as in the app (each run and each line of the log has its own moment), from a
    // day that is not the 1st, when the monthly calibration would hold the agent.
    const clock = new ShiftedClock("2026-03-05T08:00:00Z");
    // The bench's role-playing stand-in: the specialist writes a file through the app's tools
    // and reports, the critic reviews through `submit_review`; "Broken" fails its first run.
    const provider = createRolePlayer(
      benchOptionsFromEnv(
        {
          FORERUNNER_BENCH_DELAY_MS: "0",
          FORERUNNER_BENCH_FAIL: "Broken",
          FORERUNNER_BENCH_FAIL_TIMES: "1",
        },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
    });
    const { app, token } = createDaemonApp(rt);
    client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("each run carries its own report and files; the critic's entry is the review, with none of them", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Drawer", goal: "Runs in their place" });
    const task = await client.createTask(project.id, {
      title: "Add a LICENSE file (MIT)",
      outcome: "LICENSE holds the MIT text",
      riskTier: 1,
    });
    const broken = await client.createTask(project.id, {
      title: "Broken page check",
      outcome: "the check passes",
      riskTier: 1,
    });
    const statuses = async () =>
      (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
    // Sessions until both are done: "Broken" fails its first run and works on the next.
    for (let i = 0; i < 3; i++) {
      const open = (await client.tasks(project.id)).filter((t) => t.status !== "done");
      if (!open.length) break;
      const started = await client.startSession({ agentId, projectId: project.id });
      const sessionId = started.session?.id ?? "";
      expect(sessionId, await statuses()).not.toBe("");
      await eventually(
        async () => (await client.session(sessionId)).status !== "running",
        "the session to end",
        statuses,
        30_000,
      );
    }
    const done = await client.task(task.id);
    expect(done.task.status).toBe("done");
    // The specialist's run holds its report and files; the critic's holds neither.
    expect(done.runs.map((r) => [r.specialist, !!r.report, r.files.length > 0])).toEqual([
      ["critic", false, false],
      ["coder", true, true],
    ]);
    const work = done.runs.filter((r) => r.kind === "work");
    const reviews = done.runs.filter((r) => r.kind === "review");
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ specialist: "coder", outcome: "Finished" });
    expect(work[0]?.report).toContain("LICENSE");
    expect(work[0]?.files.length).toBeGreaterThan(0);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ specialist: "critic", report: null, files: [] });

    // A task whose first run failed and second run worked: each report under its own run,
    // newest first, and no review entry carries a specialist's report.
    const retried = await client.task(broken.id);
    expect(retried.task.status, await statuses()).toBe("done");
    const attempts = retried.runs.filter((r) => r.kind === "work");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.report).toMatch(/could not/i);
    expect(attempts[1]?.files).toEqual([]);
    expect(attempts[0]?.report).not.toMatch(/could not/i);
    expect(attempts[0]?.files.length).toBeGreaterThan(0);
    expect(retried.runs.filter((r) => r.kind === "review").length).toBeGreaterThan(0);
    expect(retried.runs.filter((r) => r.kind === "review" && (r.report || r.files.length))).toEqual(
      [],
    );
  });

  it("Reviews: a done task's findings are no open work, each review names its task's status, the evidence has no run ids or prompt hashes (design §3.5)", async () => {
    const project = (await client.projects()).find((p) => p.name === "Drawer");
    expect(project).toBeDefined();
    const view = await client.reviews(project?.id ?? "", { limit: 200 });
    const tasks = await client.tasks(project?.id ?? "");
    // Both tasks are done (the first case ran them): nothing is open work any more.
    expect(tasks.every((t) => t.status === "done")).toBe(true);
    expect(view.openFindings).toBe(0);
    const taskReviews = view.reviews.filter((r) => r.taskId);
    expect(taskReviews.length).toBeGreaterThan(0);
    for (const r of taskReviews) {
      expect(r.taskStatus).toBe("done");
      expect(r.openFindings).toBe(0);
      for (const e of r.evidence)
        expect(String(e)).not.toMatch(
          /^(prompt:|run:|context:)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        );
    }
    // The trend and the counts are the tasks' reviews; a session check is not among them.
    expect(view.gradeTrend.every((p) => p.taskId !== null)).toBe(true);
  });

  it("Costs: tasks by title, the work by specialist with the runs the critic accepted, and the period (design §5)", async () => {
    const project = (await client.projects()).find((p) => p.name === "Drawer");
    const costs = await client.costs({ projectId: project?.id ?? "" });
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    expect(costs.byTask.map((b) => b.label)).toEqual(
      expect.arrayContaining(["Add a LICENSE file (MIT)", "Broken page check"]),
    );
    for (const b of costs.byTask) expect(b.label).not.toMatch(uuid);
    // Before: one "(none)" row for every specialist, nothing accepted.
    const coder = costs.bySpecialist.find((b) => b.key === "coder");
    expect(coder?.accepted).toBeGreaterThanOrEqual(2);
    expect(costs.bySpecialist.some((b) => b.key === "(none)" && b.runs > 1)).toBe(false);
    const licence = costs.byTask.find((b) => b.label === "Add a LICENSE file (MIT)");
    // Runs are the task's work runs (one), not the ledger's entries per model call.
    expect(licence).toMatchObject({ runs: 1, accepted: 1 });
    const broken = costs.byTask.find((b) => b.label === "Broken page check");
    expect(broken).toMatchObject({ runs: 2, accepted: 1 });
    expect(costs.from).not.toBe("");
    expect(costs.to >= costs.from).toBe(true);
  });

  it("the session log: person lines by default with names and no type names, the internals under Details (design §3.7)", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Log words", goal: "A log to read" });
    await client.createTask(project.id, {
      title: "Write the notes in notes.md",
      outcome: "notes.md holds the notes",
      riskTier: 1,
    });
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(project.id)).map((t) => t.status).join(", "),
      30_000,
    );
    // The notification of the session's end is written after the end; wait for it.
    await eventually(
      async () => (await client.sessionEvents(sessionId)).some((e) => e.type === "notification"),
      "the end's notification line",
      async () => (await client.sessionEvents(sessionId)).map((e) => e.type).join(", "),
      10_000,
    );
    const events = await client.sessionEvents(sessionId);
    expect(events.every((e) => e.audience === "person" || e.audience === "detail")).toBe(true);
    const person = events.filter((e) => e.audience === "person").map((e) => e.text);
    const detail = events.filter((e) => e.audience === "detail");
    // The internals are Details: the brief, memory, each tool step and the notification.
    expect(detail.map((e) => e.type)).toEqual(
      expect.arrayContaining(["session.brief", "memory.loaded", "task.step", "notification"]),
    );
    for (const line of person) {
      expect(line, line).not.toMatch(
        /\b(?:session|task|critic|memory|queue|peers|docs|inbox)\.[a-z_]+/,
      );
      expect(line, line).not.toMatch(/\*\*|\(s\)|\bUSD\b|[{}]/);
      expect(line, line).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
      expect(line, line).not.toMatch(/telegram|skipped \(|email skipped|desktop unavailable/i);
    }
    expect(person.length).toBeLessThanOrEqual(10);
    expect(person).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/started "Write the notes in notes\.md"/),
        expect.stringMatching(/^The critic accepted "Write the notes in notes\.md"\.$/),
      ]),
    );
    expect(person.at(-1)).toMatch(/^Session over: 1 done\. CHF \d+\.\d{2}\.$/);
    // Even under Details, the notification line names no channel that was not set up.
    const note = detail.find((e) => e.type === "notification");
    expect(note?.text).toMatch(/^Notified you: ".+"\.$/);
  });
});

describe("the UI client against the real daemon: Stop all and the chat's stop while a task runs", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    // Every specialist run waits until it is stopped.
    ({ rt, client, provider } = await composeWithWaitingRun([WAITING_CALL, WAITING_CALL]));
  }, 120_000);
  /** A project with two ready tasks and a session whose first task is in its model call. */
  async function runningSession(name: string) {
    const calls = provider.calls.length + 1;
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name, goal: "Two pages", autonomyLevel: 2 });
    const task = (title: string, priority: "low" | "medium" | "high") =>
      client.createTask(project.id, {
        title,
        outcome: `${title} exists`,
        acceptanceCriteria: [],
        riskTier: 0,
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
      });
    const one = await task("Write one.html", "high");
    const two = await task("Write two.html", "low");
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    const taskOf = async (id: string) => (await client.tasks(project.id)).find((t) => t.id === id);
    const seen = async () =>
      `session ${(await client.session(sessionId)).status}, ${provider.calls.length} model call(s)`;
    await eventually(
      async () =>
        (await taskOf(one.id))?.status === "in_progress" && provider.calls.length === calls,
      "the first task's run",
      seen,
    );
    const ended = () =>
      eventually(
        async () => !["running", "paused"].includes((await client.session(sessionId)).status),
        "the session to end",
        seen,
      );
    return { agentId, project, one, two, sessionId, taskOf, ended };
  }
  afterAll(async () => {
    await rt?.close();
  });

  it("the header's Stop all is the person's Stop all, not an error: the session, its task, its log and its result say so (design §4.9)", async () => {
    const { one, two, sessionId, taskOf, ended } = await runningSession("Stop all page");

    // The header's Stop all, with the body Shell.tsx sends (its own words, not the daemon's).
    const killed = await client.kill({ scope: "all", reason: "stop all from the UI" });
    expect(killed.killActive).toBe(true);
    await ended();
    const view = await client.session(sessionId);
    expect(view).toMatchObject({
      stopReason: "stop_all",
      statusText: "Stopped: Stop all",
      currentTask: null,
    });
    expect(view.summary.split("\n").at(-1)).toBe(
      'Stopped: Stop all. "Write one.html" and "Write two.html" are ready to continue. CHF 0.00.',
    );
    // Ready again, with whose stop it was; the next Start can take it.
    expect(await taskOf(one.id)).toMatchObject({ status: "ready", reason: "Stopped: Stop all" });
    expect((await taskOf(two.id))?.status).toBe("ready");
    // The log says who stopped it, in the person's words; no red error line.
    const events = await client.sessionEvents(sessionId);
    expect(events.map((e) => e.type)).not.toContain("session.error");
    expect(events.filter((e) => e.level === "error")).toEqual([]);
    const stopped = events.find((e) => e.type === "session.stopped");
    expect(stopped?.payload).toMatchObject({
      by: "stop_all",
      text: 'Stopped: Stop all during "Write one.html". It is ready again.',
    });
    // Stop all stays in force until Allow sessions again.
    expect((await client.health()).killActive).toBe(true);
    expect((await client.resume()).killActive).toBe(false);
  });

  it("'stop' in the chat is Stop now of the running session: 'Stopped by you', nothing frozen (design §3.9, §4.9)", async () => {
    const me = await client.me();
    const { agentId, project, one, sessionId, taskOf, ended } =
      await runningSession("Chat stop page");
    // The chat's line, as the Chat screen sends it.
    const reply = await client.chat({
      humanId: me.id,
      agentId,
      projectId: project.id,
      text: "stop",
      source: "text",
    });
    expect(reply.actions.map((a) => a.kind)).toEqual(["session.stop"]);
    expect(reply.reply).toBe(
      "Stopped the session on Chat stop page. What it wrote stays; the task it was on is ready again.",
    );
    await ended();
    const view = await client.session(sessionId);
    expect(view).toMatchObject({ stopReason: "you", statusText: "Stopped by you" });
    expect(await taskOf(one.id)).toMatchObject({ status: "ready", reason: "Stopped by you" });
    const events = await client.sessionEvents(sessionId);
    expect(events.map((e) => e.type)).not.toContain("session.error");
    expect(events.find((e) => e.type === "session.stopped")?.payload).toMatchObject({
      by: "you",
    });
    // Stop now, not Stop all: nothing is frozen, so the next start works (before, the chat's
    // stop froze the agent until Allow sessions again). "stop everything" is Stop all, and
    // "resume" lifts it, by chat as by the header.
    expect((await client.health()).killActive).toBe(false);
    const line = (text: string) =>
      client.chat({ humanId: me.id, agentId, projectId: project.id, text, source: "text" });
    await line("stop everything");
    expect((await client.health()).killActive).toBe(true);
    const resumed = await line("resume");
    expect(resumed.actions.map((a) => a.kind)).toEqual(["session.resume"]);
    expect((await client.health()).killActive).toBe(false);
  });
});

describe("the UI client against the real daemon: Settings → Sandbox (Docker) (U-079)", () => {
  const IMAGE = "registry.example/forerunner-runner:ui-contract";
  const engine = new FakeContainerEngine({
    registry: { [IMAGE]: { layers: 2, bytes: 500_000_000 } },
  });
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-sandbox-"));
    // Docker answers, the image is not here yet: the engine is a stand-in, never CI's Docker.
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, FORERUNNER_RUNNER_IMAGE: IMAGE },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock: new SimulatedClock("2026-10-31T08:00:00Z"),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxRun: engine.run,
      sandboxWhich: engine.which,
    });
    const { app, token } = createDaemonApp(rt);
    client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the card's status, the Start dialog's waiting task, Download with its progress, Check again", async () => {
    const before = await client.sandboxStatus();
    expect(before).toMatchObject({
      state: "image_missing",
      ready: false,
      image: IMAGE,
      pullable: true,
      downloadBytes: 500_000_000,
      waiting: 0,
    });
    expect(before.steps[0]).toContain("Download the sandbox");

    // A full-review task waits; the Start dialog says so with the step.
    const project = await client.createProject({ name: "Docker", goal: "Reviewed" });
    await client.createTask(project.id, {
      title: "Rework the payment flow",
      outcome: "it is reworked",
      acceptanceCriteria: [],
      riskTier: 2,
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    const check = await client.startCheck(project.id);
    expect(check.runnable).toEqual([]);
    expect(check.waitingForSandbox).toMatchObject({
      state: "image_missing",
      tasks: [{ title: "Rework the payment flow" }],
    });
    expect((await client.sandboxStatus()).waiting).toBe(1);

    // Download the sandbox: 202 with the download, its events to the end, then ready.
    const started = await client.pullSandbox();
    expect(started.pull?.image).toBe(IMAGE);
    const events: string[] = [];
    await followSandboxPull(client, 0, (e) => events.push(e.event.type));
    await rt.sandbox.readiness.settled;
    expect(events).toContain("layers");
    expect(events.at(-1)).toBe("result");
    const after = await client.sandboxStatus();
    expect(after).toMatchObject({ state: "ready", ready: true, waiting: 0 });
    expect(after.pull).toMatchObject({ state: "done", layersDone: 2, layersTotal: 2 });
    expect(engine.callsOf("pull")).toEqual([["docker", "pull", IMAGE]]);
    expect((await client.startCheck(project.id)).waitingForSandbox).toBeNull();

    // Docker quits: Check again says so, with the step; a Download is refused with it.
    engine.set({ running: false });
    const stopped = await client.checkSandbox();
    expect(stopped.state).toBe("not_running");
    expect(stopped.headline).toBe("Docker is installed but not running.");
    const refused = await client.pullSandbox().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).message).toContain("Docker is installed but not running.");
    engine.set({ running: true });
  });
});

/**
 * The UI client against a real daemon whose model is the bench's role-playing stand-in, with
 * its failure injection (`FORERUNNER_BENCH_*`), on a clock that moves as in the app.
 */
async function composeWithRolePlayer(env: Record<string, string>): Promise<{
  rt: RuntimeApp;
  client: DaemonClient;
  /** The stand-in's knobs, read at each call: a case can plant a failure for one step. */
  bench: BenchOptions;
  /** The intake calls the stand-in received, in order (what the planner was told). */
  intakeCalls: ModelRequest[];
}> {
  const home = mkdtempSync(join(tmpdir(), "fr-ui-real-needs-me-"));
  const bench = benchOptionsFromEnv(
    { FORERUNNER_BENCH_DELAY_MS: "0", ...env },
    new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
  );
  const provider = createRolePlayer(bench);
  const intakeCalls: ModelRequest[] = [];
  const stream = provider.stream.bind(provider);
  provider.stream = (req) => {
    if (detectRole(req).role === "intake") intakeCalls.push(req);
    return stream(req);
  };
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock: new ShiftedClock("2026-03-05T08:00:00Z"),
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.0.0-ui-contract",
    sandboxDetection: NO_ENGINE,
  });
  const { app, token } = createDaemonApp(rt);
  const client = createClient(
    {
      baseUrl: "http://daemon.test",
      token,
      source: "env",
      installId: null,
      platform: null,
      shellVersion: null,
    },
    (input, init) => Promise.resolve(app.request(input, init)),
  );
  return { rt, client, bench, intakeCalls };
}

describe("the UI client against the real daemon: a task that fails gets one card, and answering it resumes work (design §3.8)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    // "Write the scope" never works: the specialist reports it could not do the work.
    ({ rt, client } = await composeWithRolePlayer({ FORERUNNER_BENCH_FAIL: "Write the scope" }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("after its retries: one card naming the task, the specialist's words and what waits; Try again starts a session; Mark done anyway is accepted without review", async () => {
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Packing list", goal: "A small CLI" });
    const scope = await client.createTask(project.id, {
      title: "Write the scope in docs/scope.md",
      outcome: "docs/scope.md says what is in scope",
      riskTier: 1,
    });
    const readme = await client.createTask(project.id, {
      title: "Write the README",
      outcome: "README.md says how to run it",
      riskTier: 1,
      dependsOn: [scope.id],
    });
    const sessionsOf = async () => client.sessions({ projectId: project.id });
    const ended = async () =>
      (await sessionsOf()).every((s) => !["running", "paused"].includes(s.status));
    const first = await client.startSession({ agentId, projectId: project.id });
    expect(first.session?.id).toBeTruthy();
    await eventually(ended, "the session to end", async () => "", 60_000);

    // The session page's log (design §3.7, §5 "Log line"): at most about eight lines for the
    // task over all its attempts; each attempt is one line with the specialist's words and
    // what comes next, and no critic line says again that it could not (the walk read 12).
    const log = (await client.sessionEvents(first.session?.id ?? "")).filter(
      (e) => e.audience === "person",
    );
    const ofScope = log
      .filter((e) => (e.payload as { taskId?: string } | null)?.taskId === scope.id)
      .map((e) => e.text);
    expect(ofScope.length, ofScope.join("\n")).toBeLessThanOrEqual(8);
    const attempts = ofScope.filter((l) =>
      /could not do "Write the scope in docs\/scope\.md": "[^"]+"\. (Trying again|It needs your decision \(Inbox\))\.$/.test(
        l,
      ),
    );
    expect(attempts.length, ofScope.join("\n")).toBe(
      (await client.task(scope.id)).runs.filter((r) => r.kind === "work").length,
    );
    expect(ofScope.at(-1), ofScope.join("\n")).toMatch(/It needs your decision \(Inbox\)\.$/);
    expect(ofScope.some((l) => /^The critic sent/.test(l))).toBe(false);
    expect(ofScope.filter((l) => / started "Write the scope/.test(l))).toHaveLength(1);

    // Exactly one card, after the retries inside the session (design §4.3).
    const cardsOf = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    const cards = await cardsOf();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.title).toMatch(/^"Write the scope in docs\/scope\.md" failed (twice|\d+ times)$/);
    // "Failed N times" is true now: N is the specialist's runs of the task the Tasks tab lists.
    const failedTimes = async () => {
      const n = (await client.task(scope.id)).runs.filter((r) => r.kind === "work").length;
      return `"Write the scope in docs/scope.md" failed ${n === 2 ? "twice" : `${n} times`}`;
    };
    expect(card?.title).toBe(await failedTimes());
    // The specialist's own words, and what waits on the task (true now).
    expect(card?.body).toContain('said: "I could not complete this task.');
    expect(card?.body).toContain('"Write the README" waits on it.');
    expect(card?.body).not.toMatch(/ladder|ceiling|attempt\(s\)|\[stand-in model\]/i);
    expect(card?.choices?.map((c) => c.label)).toEqual([
      "Try again",
      "Mark done anyway",
      "Cancel task",
    ]);
    const choice = (label: string) => card?.choices?.find((c) => c.label === label);
    expect(choice("Try again")).toMatchObject({ tone: "primary", confirm: null, input: "note" });
    expect(choice("Try again")?.explain).toMatch(/Starts a session that tries again/);
    expect(choice("Mark done anyway")?.explain).toBe(
      'Closes it although nothing passed review. "Write the README" after it will run.',
    );
    expect(choice("Mark done anyway")?.confirm).toMatch(/done although nothing passed review\?/);
    expect(choice("Cancel task")?.explain).toBe(
      'Drops it; "Write the README" after it will be stuck.',
    );
    expect(choice("Cancel task")?.tone).toBe("danger");
    expect(card?.reply).toBe("none");

    // Try again, with a note: a session starts by itself, and the note reaches the next brief.
    const sessionsBefore = (await sessionsOf()).length;
    const tried = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: { choice: "Try again", note: "Keep it to five lines." },
    });
    expect(tried.status).toBe("answered");
    expect(tried.outcome).toMatch(
      /^Trying "Write the scope in docs\/scope\.md" again: (a session started|it runs after the current session)\.$/,
    );
    await eventually(
      async () => (await sessionsOf()).length > sessionsBefore && (await ended()),
      "the session the answer started",
      async () => `${(await sessionsOf()).length} sessions`,
      60_000,
    );
    // It failed again: one card again, never one per attempt.
    const again = await cardsOf();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(card?.id);
    // The count goes on from the runs, not from the task's retry counter (which Try again's
    // way back to ready also moved), and the Tasks tab says the same number.
    expect(again[0]?.title).toBe(await failedTimes());
    const runs = (await client.task(scope.id)).runs.filter((r) => r.kind === "work").length;
    expect((await client.tasks(project.id)).find((t) => t.id === scope.id)?.display?.label).toBe(
      `Needs your decision: tried ${runs} times`,
    );

    // Mark done anyway: closed although nothing passed review, and the README runs.
    const marked = await client.answerRequest(again[0]?.id ?? "", {
      version: again[0]?.version ?? 0,
      answer: "Mark done anyway",
    });
    expect(marked.outcome).toMatch(
      /^"Write the scope in docs\/scope\.md" is done: accepted without review\./,
    );
    const scopeNow = (await client.tasks(project.id)).find((t) => t.id === scope.id);
    expect(scopeNow?.display?.label).toBe("Done: accepted without review");
    await eventually(
      async () =>
        (await client.tasks(project.id)).find((t) => t.id === readme.id)?.status === "done",
      "the README to be done by the session the answer started",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      60_000,
    );
    // The Answered list keeps both answers with what came of them.
    const answered = (await client.inbox(me.id)).requests.filter(
      (r) => r.projectId === project.id && r.status === "answered",
    );
    expect(answered.map((r) => r.outcome)).toEqual(
      expect.arrayContaining([marked.outcome, tried.outcome]),
    );
  }, 120_000);

  it("a task only the person can do: Send answers closes it, and the task waiting on it starts in a session at once", async () => {
    const me = await client.me();
    const project = await client.createProject({ name: "Hosting", goal: "A quote page" });
    // New task, Who does it: "Me: ask me in the Inbox". The README waits on it.
    const decide = await client.createTask(project.id, {
      title: "Decide where the page is published",
      outcome: "The hosting is chosen",
      acceptanceCriteria: ["Where should the page be published?"],
      specialist: "person",
    });
    const readme = await client.createTask(project.id, {
      title: "Write the README",
      outcome: "README.md says how to run it",
      riskTier: 1,
      dependsOn: [decide.id],
    });
    const sessionsOf = async () => client.sessions({ projectId: project.id });
    expect(await sessionsOf()).toEqual([]);
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.taskId === decide.id && r.status === "open",
    );
    expect(card?.reply).toBe("form");
    // What the Inbox form sends: one answer per question.
    const answered = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: {
        answers: [{ question: card?.steps[0] ?? null, answer: "GitHub Pages" }],
      },
    });
    expect(answered.status).toBe("answered");
    // The Done line says what came of the answer: the task is done and work goes on.
    expect(answered.outcome).toMatch(
      /^Answers saved in the decision record; "Decide where the page is published" is done; (a session started|it runs after the current session)\.$/,
    );
    // No Start click: the session the answer started (or queued behind the session that was
    // still ending, which the scheduler starts on its next tick) runs the README.
    await eventually(
      async () => (await sessionsOf()).length > 0,
      "the session the answer started",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      60_000,
    );
    await eventually(
      async () =>
        (await client.tasks(project.id)).find((t) => t.id === readme.id)?.status === "done",
      "the README to be done by the session the answer started",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      60_000,
    );
  }, 120_000);

  it("a task waiting for Docker that the person pauses reads Paused by you and can be resumed: its Docker card asks nothing of the task", async () => {
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Docker wait", goal: "A quote page" });
    await client.createTask(project.id, {
      title: "Write the notes",
      outcome: "notes.md lists what the page is for",
      riskTier: 1,
    });
    const check = await client.createTask(project.id, {
      title: "Check the page in a browser",
      outcome: "The page opens without errors",
      riskTier: 2,
    });
    expect(check.display?.label).toBe("Waiting for Docker");
    // The start may wait behind a session an earlier case left ending (the next tick runs it).
    await client.startSession({ agentId, projectId: project.id });
    const dockerCard = async () =>
      (await client.inbox(me.id)).requests.find(
        (r) => r.projectId === project.id && r.status === "open",
      );
    await eventually(
      async () => {
        const ss = await client.sessions({ projectId: project.id });
        return (
          ss.length > 0 &&
          ss.every((s) => !["running", "paused"].includes(s.status)) &&
          (await dockerCard()) !== undefined
        );
      },
      "the session to end with the project's Docker card",
      async () => JSON.stringify((await client.sessions({ projectId: project.id })).length),
      90_000,
    );
    // The project's Docker card names the task (Set up Docker, Cancel task).
    expect((await dockerCard())?.title).toBe('"Check the page in a browser" waits for Docker');
    const row = (await client.tasks(project.id)).find((t) => t.id === check.id);
    expect(row?.display?.label).toBe("Waiting for Docker");
    // Pause on the Tasks tab: the row says so and offers Resume, not "Needs your answer".
    const paused = await client.taskAction(check.id, {
      version: row?.version ?? 0,
      action: "pause",
    });
    expect(paused.display).toMatchObject({ key: "paused", label: "Paused by you" });
    const resumed = await client.taskAction(check.id, {
      version: paused.version,
      action: "resume",
    });
    expect(resumed.display?.label).toBe("Waiting for Docker");
  }, 120_000);

  it("a person's task with nothing waiting on it: the answers close it and no empty session starts", async () => {
    const me = await client.me();
    const project = await client.createProject({ name: "Alone", goal: "A quote page" });
    const decide = await client.createTask(project.id, {
      title: "Choose the colours",
      outcome: "The colours are chosen",
      acceptanceCriteria: ["Which colours?"],
      specialist: "person",
    });
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.taskId === decide.id && r.status === "open",
    );
    const answered = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: { answers: [{ question: card?.steps[0] ?? null, answer: "Blue and white" }] },
    });
    expect(answered.outcome).toBe(
      'Answers saved in the decision record; "Choose the colours" is done.',
    );
    expect(await client.sessions({ projectId: project.id })).toEqual([]);
  }, 60_000);
});

describe("the UI client against the real daemon: the plan card (design §3.3)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let bench: BenchOptions;
  let intakeCalls: ModelRequest[];

  beforeAll(async () => {
    ({ rt, client, bench, intakeCalls } = await composeWithRolePlayer({}));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const BRIEF = "A one-page website that shows a random quote. Plain HTML, CSS and JavaScript.";
  const planned = async (name: string) => {
    const project = await client.createProject({
      name,
      goal: "A quote page",
      brief: BRIEF,
      intake: true,
    });
    await rt.intake.inFlight(project.id);
    const me = await client.me();
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.projectId === project.id && r.status === "open",
    );
    if (!card) throw new Error("no plan card");
    return { project, card, me };
  };

  it("before the approval, 'start a session' in the project's Chat says what the Start dialog says, with no Yes/No card", async () => {
    // First in this block: no session of the agent runs yet (a running one makes a start wait
    // for it rather than refuse, in the dialog and the chat alike).
    const { project, me } = await planned("Quote chat");
    const before = (await client.sessions({ projectId: project.id })).length; // the planning call
    // The chat's start refuses with the Start dialog's sentence (design §3.6, §3.9); the Start
    // dialog names the plan card here (§3.3), so the chat does too, not "no task is ready".
    const reply = await client.chat({
      humanId: me.id,
      agentId: rt.agent.id,
      projectId: project.id,
      projectTab: true,
      text: "start a session",
      source: "text",
    });
    expect(reply.reply).toBe(
      "Nothing can run yet: the plan from your brief waits for your approval. Review it in the Inbox.",
    );
    expect((await client.startCheck(project.id)).blocked?.sentence).toBe(
      "Nothing can run yet: the plan from your brief waits for your approval.",
    );
    expect(reply.pendingConfirmation).toBeNull();
    expect(reply.actions).toEqual([]);
    expect(await client.sessions({ projectId: project.id })).toHaveLength(before);
  }, 60_000);

  it("Approve and start writes the plan and starts working on it; the card says so", async () => {
    const { project, card } = await planned("Quote page");
    // Before the approval the Start dialog's button is the plan card, not the Tasks tab.
    expect((await client.startCheck(project.id)).blocked).toEqual({
      kind: "nothing_runnable",
      sentence: "Nothing can run yet: the plan from your brief waits for your approval.",
      action: { kind: "link", label: "Review the plan", to: "/inbox" },
    });
    expect(card.title).toMatch(/^Plan for "Quote page": \d+ tasks$/);
    expect(card.choices?.map((c) => c.label)).toEqual([
      "Approve and start",
      "Change the plan",
      "Reject",
    ]);
    expect(card.choices?.[0]?.explain).toMatch(
      /^Writes these \d+ tasks and starts working on them now\.$/,
    );
    expect(card.choices?.find((c) => c.label === "Change the plan")?.input).toBe("text");
    const approved = await client.answerRequest(card.id, {
      version: card.version,
      answer: "Approve and start",
    });
    const written = (await client.tasks(project.id)).length;
    expect(written).toBeGreaterThan(0);
    expect(approved.outcome).toBe(`Plan approved: ${written} tasks written; working on them.`);
    // A session of the project started without a Start click.
    await eventually(
      async () => (await client.sessions({ projectId: project.id })).length > 0,
      "the session the approval started",
      async () => "",
      10_000,
    );
  }, 60_000);

  it("Change the plan drafts a new plan with the person's words, which lands as a new card", async () => {
    const { project, card, me } = await planned("Quote two");
    const changed = await client.answerRequest(card.id, {
      version: card.version,
      answer: { choice: "Change the plan", text: "A single index.html only." },
    });
    expect(changed.outcome).toBe(
      'You asked for changes ("A single index.html only."): a new plan is drafted and comes as its own card.',
    );
    expect((await client.intakeStatus(project.id)).state).toBe("drafting");
    await rt.intake.inFlight(project.id);
    const status = await client.intakeStatus(project.id);
    expect(status.state).toBe("pending");
    expect(status.requestId).not.toBe(card.id);
    const next = (await client.inbox(me.id)).requests.find((r) => r.id === status.requestId);
    expect(next?.title).toMatch(/^Plan for "Quote two"/);
    // Nothing of the first plan was written.
    expect(await client.tasks(project.id)).toEqual([]);
    // The words without "Change the plan" are not an answer the card can act on.
    await expect(
      client.answerRequest(next?.id ?? "", {
        version: next?.version ?? 0,
        answer: "Change the plan",
      }),
    ).rejects.toThrow(/Choose one of/);
  }, 60_000);

  it("Reject writes nothing; the project page offers Draft a new plan, which drafts one again", async () => {
    const { project, card } = await planned("Quote three");
    const rejected = await client.answerRequest(card.id, {
      version: card.version,
      answer: "Reject",
    });
    expect(rejected.outcome).toBe(
      "You rejected the plan. Nothing was written; you can draft a new plan from the project page.",
    );
    expect(await client.tasks(project.id)).toEqual([]);
    expect((await client.intakeStatus(project.id)).state).toBe("rejected");
    // The note left for the next session is in words: no request id, no time stamp.
    const notes = (await client.queue(project.id)).map((q) => q.text).join("\n");
    expect(notes).toContain("The person rejected the plan");
    expect(notes).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|T\d\d:\d\d:\d\d/);
    const again = await client.retryIntake(project.id);
    expect(again.state).toBe("drafting");
    await rt.intake.inFlight(project.id);
    expect((await client.intakeStatus(project.id)).state).toBe("pending");
  }, 60_000);

  /** What the planner was told: its user message, which carries the brief and the changes. */
  const told = (req: ModelRequest | undefined) =>
    JSON.stringify(req?.messages.find((m) => m.role === "user")?.content ?? "");

  it("Change the plan whose new draft fails: the project page says so, and Try again drafts it with the person's words", async () => {
    const { project, card } = await planned("Quote four");
    const asked = "Only a single index.html, no build step.";
    // The planning call fails once, for the draft the change asked for.
    bench.intake = "error";
    try {
      const changed = await client.answerRequest(card.id, {
        version: card.version,
        answer: { choice: "Change the plan", text: asked },
      });
      expect(changed.status).toBe("answered");
      await rt.intake.inFlight(project.id)?.catch(() => undefined);
    } finally {
      bench.intake = "ok";
    }
    expect(told(intakeCalls.at(-1))).toContain(asked);
    const failed = await client.intakeStatus(project.id);
    expect(failed.state).toBe("failed");
    // The banner's reason is in words (design §3.3), not the planning call's error text.
    expect(failed.error).toBe("Claude did not answer (model call failed).");
    // Try again (the banner's button): one draft, and it carries the person's words.
    const before = intakeCalls.length;
    const retried = await client.retryIntake(project.id);
    expect(retried.state).toBe("drafting");
    await rt.intake.inFlight(project.id);
    expect(intakeCalls).toHaveLength(before + 1);
    expect(told(intakeCalls.at(-1))).toContain(asked);
    const status = await client.intakeStatus(project.id);
    expect(status.state).toBe("pending");
    expect(status.requestId).not.toBe(card.id);
    expect(await client.tasks(project.id)).toEqual([]);
  }, 60_000);

  it("a second Change the plan keeps the first: the new draft is asked with both changes, in order", async () => {
    const { project, card, me } = await planned("Quote five");
    await client.answerRequest(card.id, {
      version: card.version,
      answer: { choice: "Change the plan", text: "No build step." },
    });
    await rt.intake.inFlight(project.id);
    const second = (await client.inbox(me.id)).requests.find(
      (r) => r.projectId === project.id && r.status === "open",
    );
    expect(second?.id).not.toBe(card.id);
    await client.answerRequest(second?.id ?? "", {
      version: second?.version ?? 0,
      answer: { choice: "Change the plan", text: "Add a dark mode." },
    });
    await rt.intake.inFlight(project.id);
    const last = told(intakeCalls.at(-1));
    expect(last).toContain("No build step.");
    expect(last).toContain("Add a dark mode.");
    expect(last.indexOf("No build step.")).toBeLessThan(last.indexOf("Add a dark mode."));
    expect((await client.intakeStatus(project.id)).state).toBe("pending");
  }, 60_000);
});

describe("the UI client against the real daemon: a run that errors fails its task, which gets a card (design §3.8, §4.4)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    ({ rt, client } = await composeWithRolePlayer({
      FORERUNNER_BENCH_FAIL: "Write the scope",
      FORERUNNER_BENCH_FAIL_MODE: "error",
    }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the failed task is a card, not 'Nothing waits on you'; Cancel task names what will be stuck", async () => {
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Error test", goal: "A small CLI" });
    const scope = await client.createTask(project.id, {
      title: "Write the scope in docs/scope.md",
      outcome: "docs/scope.md says what is in scope",
      riskTier: 1,
    });
    const after = await client.createTask(project.id, {
      title: "Build the first version",
      outcome: "src/main.js runs",
      riskTier: 1,
      dependsOn: [scope.id],
    });
    await client.startSession({ agentId, projectId: project.id });
    await eventually(
      async () =>
        (await client.sessions({ projectId: project.id })).every(
          (s) => !["running", "paused"].includes(s.status),
        ),
      "the session to end",
      async () => "",
      60_000,
    );
    expect((await client.tasks(project.id)).find((t) => t.id === scope.id)?.status).toBe("failed");
    const inbox = await client.inbox(me.id);
    const cards = inbox.requests.filter((r) => r.projectId === project.id && r.status === "open");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.title).toBe('"Write the scope in docs/scope.md" failed');
    expect(card?.body).toMatch(/^What failed: Claude did not answer/);
    expect(card?.body).toContain('"Build the first version" waits on it.');
    expect(card?.choices?.map((c) => c.label)).toEqual([
      "Try again",
      "Mark done anyway",
      "Cancel task",
    ]);
    // The counts agree: the card counts as needing you.
    expect(inbox.needsYouCount).toBe(inbox.requests.filter((r) => r.status === "open").length);
    expect((await client.project(project.id)).waitingOnYou).toBe(1);
    // The task row offers the card.
    const row = (await client.tasks(project.id)).find((t) => t.id === scope.id);
    expect(row?.display?.blocker).toMatchObject({ kind: "card", requestId: card?.id });

    const cancelled = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: "Cancel task",
    });
    expect(cancelled.outcome).toBe('"Write the scope in docs/scope.md" was cancelled.');
    const waiting = (await client.tasks(project.id)).find((t) => t.id === after.id);
    expect(waiting?.display?.label).toBe('Stuck: "Write the scope in docs/scope.md" was cancelled');
  }, 120_000);
});

describe("the UI client against the real daemon without a Claude key (U-047)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-nokey-"));
    // No provider and an empty vault: the install before the setup assistant ran.
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock: new SimulatedClock("2026-03-05T08:00:00Z"),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
    });
    const { app, token } = createDaemonApp(rt);
    client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
  }, 120_000);

  afterAll(async () => {
    await rt?.close();
  });

  it("Chat runs a command that needs no model, and names the setup assistant for any other line", async () => {
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "No key yet", goal: "Chat works" });
    const line = (text: string) =>
      client.chat({ humanId: me.id, agentId, projectId: project.id, text, source: "text" });
    const added = await line("add a task: write the README");
    expect(added.reply).not.toMatch(/fr setup/);
    expect((await client.tasks(project.id)).map((t) => [t.title, t.status])).toContainEqual([
      "write the README",
      "ready",
    ]);
    const told = await line("What should we do first?");
    expect(told.reply).toContain("Settings → Accounts and keys → Open the setup assistant");
    expect(told.reply).not.toMatch(/fr setup/);
    // It does not promise a session start (review of fix/chat: it listed "start a session",
    // which refuses without Claude); that one says why at once, with no Yes/No card.
    expect(told.reply).not.toContain("start a session");
    const start = await line("start a session");
    expect(start.pendingConfirmation).toBeNull();
    expect(start.reply).toBe(
      "Claude is not connected: planning and tasks need it. Connect Claude in Settings.",
    );
  });

  it("the Start dialog's check says Claude is not connected, with the button that fixes it (design §3.6)", async () => {
    const project = await client.createProject({ name: "No key start", goal: "One page" });
    await client.createTask(project.id, {
      title: "Write index.html",
      outcome: "index.html exists",
      acceptanceCriteria: [],
      riskTier: 0,
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    const check = await client.startCheck(project.id);
    // A ready task, and still nothing can start: the reason and the button, not a failed run.
    expect(check.ready).toBe(1);
    expect(check.blocked).toEqual({
      kind: "no_model",
      sentence: "Claude is not connected: planning and tasks need it.",
      action: { kind: "link", label: "Connect Claude", to: "/settings" },
    });
  });
});

describe("one conversation per project, stored by the daemon (design §3.9)", () => {
  it("the Chat tab and Talk read the same turns; a waiting card stays after another line; the turns and the card survive a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-conversation-"));
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const compose = (replies: { text: string }[]) =>
      composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault: new MemoryVault(),
        provider: new ScriptedProvider(replies, clock),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "0.0.0-ui-contract",
        sandboxDetection: NO_ENGINE,
      });
    const clientOf = (rt: RuntimeApp) => {
      const { app, token } = createDaemonApp(rt);
      return createClient(
        {
          baseUrl: "http://daemon.test",
          token,
          source: "env",
          installId: null,
          platform: null,
          shellVersion: null,
        },
        (input, init) => Promise.resolve(app.request(input, init)),
      );
    };
    let rt = await compose([
      { text: "Nothing has run yet: two tasks are ready." },
      { text: "About CHF 30 at most." },
    ]);
    let client = clientOf(rt);
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const quote = await client.createProject({ name: "Quote page", goal: "A quote a day" });
    const notes = await client.createProject({ name: "Notes", goal: "A notes tool" });
    const say = (projectId: string, text: string) =>
      client.chat({ humanId: me.id, agentId, projectId, projectTab: true, text, source: "text" });
    const task = (title: string) =>
      client.createTask(quote.id, {
        title,
        outcome: `${title}.`,
        acceptanceCriteria: [],
        riskTier: 1,
        priority: "medium",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
      });
    const readme = await task("Write the README");
    const faq = await task("Write the FAQ");
    await say(quote.id, "what is going on?");
    await say(notes.id, "add a task: write the changelog");
    const card = await say(quote.id, "make the FAQ task depend on the README task");
    expect(card.pendingConfirmation?.readback).toBe(
      'Make "Write the FAQ" wait for "Write the README"?',
    );
    await say(quote.id, "how much will it cost?");

    const seen = await client.conversation(quote.id);
    expect(seen.projectId).toBe(quote.id);
    expect(seen.turns.map((t) => t.said)).toEqual([
      "what is going on?",
      "make the FAQ task depend on the README task",
      "how much will it cost?",
    ]);
    expect(seen.turns[0]?.reply?.text).toBe("Nothing has run yet: two tasks are ready.");
    // The read-back is shown once, on the card: the turn's text does not repeat it.
    const asked = seen.turns[1]?.reply;
    expect(asked?.readback).toBe(card.pendingConfirmation?.readback);
    expect(asked?.text).toBe("");
    // The question typed after it did not drop the card: it still waits for the yes.
    expect(asked?.waiting).toBe(true);
    expect(seen.waiting?.id).toBe(card.pendingConfirmation?.id);
    // Notes has its own conversation; the one outside any project is empty.
    const other = await client.conversation(notes.id);
    expect(other.turns.map((t) => t.said)).toEqual(["add a task: write the changelog"]);
    expect(other.turns[0]?.reply?.actions).toEqual([
      expect.objectContaining({ kind: "task.create", canUndo: true }),
    ]);
    expect((await client.conversation(null)).turns).toEqual([]);

    // A restart: the daemon comes back on the same home and shows the same conversation.
    await rt.close();
    rt = await compose([]);
    client = clientOf(rt);
    const again = await client.conversation(quote.id);
    expect(again.turns.map((t) => [t.said, t.reply?.text])).toEqual(
      seen.turns.map((t) => [t.said, t.reply?.text]),
    );
    // The Yes/No card survived the restart (design §3.9): it still waits, and "yes" runs it.
    expect(again.waiting?.id).toBe(card.pendingConfirmation?.id);
    const yes = await say(quote.id, "yes");
    expect(yes.reply).toBe('"Write the FAQ" now waits for "Write the README".');
    expect((await client.tasks(quote.id)).find((t) => t.id === faq.id)?.dependsOn).toEqual([
      readme.id,
    ]);
    const after = await client.conversation(quote.id);
    expect(after.waiting).toBeNull();
    // The read-back says what became of it.
    expect(after.turns[1]?.reply?.card).toBe("yes");
    await rt.close();
  }, 120_000);

  // Review of fix/chat (2026-11-01): a "yes" after a card answered in this same chat said "it
  // expired or was answered in the Inbox"; and a card answered "no" in the Inbox was shown in
  // the conversation as "(you said yes)" (the Inbox's answer carries no verdict).
  it("'yes' with nothing waiting says what is true: 'Yes to what?' after a Yes or a No here, what you said after an answer in the Inbox", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-yes-to-what-"));
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider: new ScriptedProvider([], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
    });
    const { app, token } = createDaemonApp(rt);
    const client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const quote = await client.createProject({ name: "Quote page", goal: "A quote a day" });
    const say = (text: string) =>
      client.chat({
        humanId: me.id,
        agentId,
        projectId: quote.id,
        projectTab: true,
        text,
        source: "text",
      });
    const faq = await client.createTask(quote.id, {
      title: "Write the FAQ",
      outcome: "A FAQ.",
      acceptanceCriteria: [],
      riskTier: 1,
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
    });
    // What the Tasks tab shows for the FAQ.
    const status = async () =>
      (await client.tasks(quote.id)).find((t) => t.id === faq.id)?.display?.label;

    // No: the card's No, then "yes".
    const first = await say("skip the FAQ task");
    expect(first.pendingConfirmation?.readback).toMatch(/^Pause "Write the FAQ"\?/);
    expect((await say("no")).reply).toBe("Cancelled; nothing was changed.");
    expect((await say("yes")).reply).toBe("Yes to what? Nothing is waiting for your yes.");
    expect(await status()).toBe("Ready");

    // Yes: the card's Yes, then "yes".
    await say("skip the FAQ task");
    expect((await say("yes")).actions.map((a) => a.kind)).toEqual(["task.pause"]);
    expect(await status()).toBe("Paused by you");
    expect((await say("yes")).reply).toBe("Yes to what? Nothing is waiting for your yes.");

    // The Inbox: the card answered there with the option the Inbox shows for "no".
    const asked = await say("resume the FAQ task");
    const id = asked.pendingConfirmation?.id ?? "";
    const card = (await client.inbox(me.id)).requests.find((r) => r.id === id);
    expect(card?.options).toEqual(["yes", "no"]);
    // The Inbox shows the chat's card as the same one-line question the chat read back (design
    // §3.8, §3.9), not the change card's object ('the task "Write the FAQ"').
    expect(card?.title).toBe('Resume "Write the FAQ"?');
    expect(card?.body).toBe("It is ready again; the next session can run it.");
    // Its buttons say Yes and No with what each does (wave 2: "yes"/"no" with no line).
    expect(card?.choices?.map((c) => [c.label, c.explain])).toEqual([
      ["Yes", "It is ready again; the next session can run it."],
      ["No", "Nothing changes."],
    ]);
    // The answer is what the No button sends.
    await client.answerRequest(id, {
      version: card?.version ?? 0,
      answer: card?.choices?.[1]?.label ?? "",
    });
    expect(await status()).toBe("Paused by you");
    expect((await say("yes")).reply).toBe(
      "You already answered the change I asked about in the Inbox: you said no. Nothing else is waiting for your yes.",
    );
    expect(await status()).toBe("Paused by you");

    // What the conversation shows under each read-back.
    const seen = await client.conversation(quote.id);
    const cards = seen.turns.filter((t) => t.reply?.readback).map((t) => t.reply?.card);
    expect(cards).toEqual(["no", "yes", "no"]);
    expect(seen.waiting).toBeNull();
    await rt.close();
  }, 120_000);
});

describe("a project name another project has (wave 1 handoff)", () => {
  it("POST /projects answers a sentence with a stable code, not a 500, and writes nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-dup-"));
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
    });
    const { app, token } = createDaemonApp(rt);
    const client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
    await client.createProject({ name: "Quote page", goal: "A quote a day" });
    const error = await client.createProject({ name: "Quote page", goal: "Again" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe(
      'There is already a project called "Quote page". Pick another name.',
    );
    expect((await client.projects()).map((p) => p.name)).toEqual(["Quote page"]);
    await rt.close();
  }, 120_000);
});
