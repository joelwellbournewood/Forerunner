// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { KILL_ACTIVE_START_MESSAGE } from "@forerunner/runtime/daemon/api-types";
import { composeRuntime, type RuntimeApp } from "@forerunner/runtime/daemon/compose";
import { createDaemonApp } from "@forerunner/runtime/daemon/server";
import { FakeContainerEngine } from "@forerunner/runtime/sandbox/fake-engine";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScriptedProvider } from "../../../packages/runtime/test/helpers.ts";
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
    expect(rows.find((t) => t.id === license.id)?.display?.detail).toContain(
      "Full review runs in Docker, which is not running on this computer",
    );
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
    expect((await client.inbox(humanId)).requests.map((r) => r.id)).not.toContain(card.id);
    // The specialist is told the person went ahead without answering.
    expect((await client.queue(own.id)).map((q) => q.text).join("\n")).toContain(
      "The person chose to go ahead without answering",
    );
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
    const cardsFor = async (extensionId: string) =>
      (await client.inbox(humanId)).requests.filter(
        (r) => (r.changeCard as { extensionId?: string } | null)?.extensionId === extensionId,
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
    const cardsFor = async (extensionId: string) =>
      (await client.inbox(humanId)).requests.filter(
        (r) => (r.changeCard as { extensionId?: string } | null)?.extensionId === extensionId,
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

  it("project card: a task an agent left needing the person without a card is named, not 'blocked'; its card makes it blocked; a person's Pause is neither (U-071, design §2)", async () => {
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
    // A session left it needing the person (a budget stop) with no card: named on the card.
    const t = await rt.store.task.mustGet(task.id);
    await rt.store.task.transition(t.id, t.version, "needs_human", "budget stop", { agentId });
    const named = await client.project(own.id);
    expect(named.health).toBe("attention");
    expect(named.needsYou).toEqual({ taskId: task.id, title: "Confirm the stack" });
    expect((await client.projects()).find((p) => p.id === own.id)?.needsYou?.title).toBe(
      "Confirm the stack",
    );
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
    const blocked = await client.project(own.id);
    expect(blocked.health).toBe("blocked");
    expect(blocked.needsYou).toBeNull();
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

/** The UI client against a real daemon whose first specialist run waits until it is stopped. */
async function composeWithWaitingRun(): Promise<{
  rt: RuntimeApp;
  client: DaemonClient;
  provider: ScriptedProvider;
}> {
  const home = mkdtempSync(join(tmpdir(), "fr-ui-real-run-"));
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  // Model calls 1, 3 and 4 wait an hour of simulated time that never passes (each test's
  // running task); call 2 answers (U-039's next task).
  const waiting = { ttftMs: 3_600_000, text: "never sent" };
  const provider = new ScriptedProvider([waiting, { text: "Done." }, waiting, waiting], clock);
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
): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what} (${await seen()})`);
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
    expect((await client.session(sessionId)).summary).toContain(
      'Moved by you while it ran: "Long first task" (cancelled)',
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
    // End the running task so nothing is left running.
    const row = (await client.tasks(project.id)).find((t) => t.id === task.id);
    await client.transitionTask(task.id, {
      version: row?.version ?? 0,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
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
    const sessionId = started.session?.id ?? "";
    const rowOf = async () => (await client.tasks(project.id)).find((t) => t.id === task.id);
    await eventually(
      async () => (await rowOf())?.display?.key === "running" && provider.calls.length === 4,
      "the task's run",
      async () => `${(await rowOf())?.status}, ${provider.calls.length} model call(s)`,
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
  });
});
