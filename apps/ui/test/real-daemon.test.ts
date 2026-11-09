// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appDirs, join, run, SimulatedClock, SystemClock } from "@forerunner/platform";
import { KILL_ACTIVE_START_MESSAGE } from "@forerunner/runtime/daemon/api-types";
import {
  type ComposeOptions,
  composeRuntime,
  type RuntimeApp,
} from "@forerunner/runtime/daemon/compose";
import { createDaemonApp } from "@forerunner/runtime/daemon/server";
import { planEstimateUsdMicro } from "@forerunner/runtime/estimates/model";
import { projectWorkspaceDir } from "@forerunner/runtime/loop/docs";
import { evidenceRootOf, type TryPagesRequest } from "@forerunner/runtime/loop/try-it";
import type { ModelRequest } from "@forerunner/runtime/provider/types";
import { FakeContainerEngine } from "@forerunner/runtime/sandbox/fake-engine";
import { conflictNoticeSentence } from "@forerunner/runtime/session/dependent-branches";
import { fileReviewFailedRequest } from "@forerunner/runtime/session/findings";
import { answersBlockFor } from "@forerunner/runtime/session/person-questions";
import { SECRET_NAMES } from "@forerunner/runtime/setup/wizard";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GitOps } from "../../../packages/capabilities/src/githost/git.ts";
import { GitHubHost } from "../../../packages/capabilities/src/githost/github.ts";
import { MemoryGitHost } from "../../../packages/capabilities/src/githost/memory.ts";
import { saidByName } from "../../../packages/critic/src/followup.ts";
import {
  AcceptingCriticProvider,
  ScriptedProvider,
} from "../../../packages/runtime/test/helpers.ts";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import {
  type BenchOptions,
  benchOptionsFromEnv,
  createRolePlayer,
} from "../../../testenv/src/bench/role-player.ts";
import { detectRole } from "../../../testenv/src/bench/roles.ts";
import { FakeGitHost } from "../../../testenv/src/githost/fake-git-host.ts";
import {
  keyRule,
  messagesApiStandIn,
  standInFetch,
} from "../../../testenv/src/provider/messages-api.ts";
import { ApiError, createClient, type DaemonClient, isRouteMissing } from "../src/api/client.ts";
import { followSandboxPull } from "../src/api/sandbox.ts";
import { taskStepsFromLog } from "../src/lib/session-steps.ts";
import {
  actionExplain,
  reviewLevelName,
  reviewLevelValue,
  specialistName,
} from "../src/lib/task-actions.ts";
import { intakeCardOf } from "../src/pages/InboxPage.tsx";
import { goalFromBrief } from "../src/pages/NewProjectDialog.tsx";

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
      ["projectPullRequests", () => client.projectPullRequests(projectId)],
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

  /**
   * A ready task for the next start: a session runs only when there is something to run
   * (design §4.8; POST /sessions refuses with the start check's sentence otherwise, later #38).
   */
  const someWork = (title: string) =>
    client.createTask(projectId, { title, outcome: `${title} exists`, riskTier: 0 });

  it("start session: answers with the session it started, which the dialog opens (U-003)", async () => {
    // Nothing to run yet: refused in the Start dialog's words, no session.
    await expect(
      client.startSession({ agentId, projectId, trigger: "manual" }),
    ).rejects.toMatchObject({ code: "conflict", message: "Nothing can run: no task is ready." });
    await someWork("Write contract.md");
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
    await someWork("Write note.md");
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

  it("files: the project's folder and what the work wrote, one file's text, nothing outside it; Docs opens a decision record (design §3.10)", async () => {
    const card = await client.project(projectId);
    const listed = await client.projectFiles(projectId);
    // The folder the card names is the one listed: the project's workspace here.
    expect(listed.folder).toBeTruthy();
    expect(listed.folder).toBe(card.folder);
    const folder = listed.folder ?? "";
    // What a specialist writes there, a folder with a file and a file that is not text.
    mkdirSync(join(folder, "site"), { recursive: true });
    writeFileSync(join(folder, "site", "index.html"), "<!doctype html><h1>Quotes</h1>\n");
    writeFileSync(join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
    writeFileSync(join(folder, "node_modules", "x", "index.js"), "skip me");
    const after = await client.projectFiles(projectId);
    const paths = after.entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["README.md", "site", "site/index.html"]));
    expect(after.entries.find((e) => e.path === "site")?.kind).toBe("dir");
    // The git folder and node_modules are left out; a session's .gitignore is a file like any
    // other (ADR 0106), listed now that the cases above ran sessions in this project.
    expect(
      paths.some(
        (p) =>
          p === "node_modules" ||
          p.startsWith("node_modules/") ||
          p === ".git" ||
          p.startsWith(".git/"),
      ),
    ).toBe(false);
    const page = await client.projectFile(projectId, "site/index.html");
    expect(page).toMatchObject({ path: "site/index.html", binary: false });
    expect(page.content).toContain("<h1>Quotes</h1>");
    const logo = await client.projectFile(projectId, "logo.png");
    expect(logo).toMatchObject({ binary: true, content: null });
    // A path that leaves the folder is refused, whatever its form.
    for (const outside of [
      "../daemon.json",
      "/etc/passwd",
      "site/../../x",
      "node_modules/x/index.js",
    ]) {
      const refused = await client.projectFile(projectId, outside).catch((e: unknown) => e);
      expect(refused, outside).toBeInstanceOf(ApiError);
      expect((refused as ApiError).status, outside).toBe(404);
    }
    // Docs opens a decision record, not only the standard set (walk: "not one of the docs").
    mkdirSync(join(folder, "docs", "decisions"), { recursive: true });
    writeFileSync(
      join(folder, "docs", "decisions", "0001-where-it-is-published.md"),
      "# 0001 Where it is published\n\nOnly as a local file for now.\n",
    );
    const record = await client.doc(projectId, "docs/decisions/0001-where-it-is-published.md");
    expect(record.content).toContain("Only as a local file for now.");
    const notADoc = await client.doc(projectId, "site/index.html").catch((e: unknown) => e);
    expect((notADoc as ApiError).status).toBe(404);
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
    await someWork("Write stop.md");
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
    // Leave nothing running or waiting for the next case: a queued start now runs as soon as
    // the session before it ends (no scheduler tick needed), so wait until it has run.
    await eventually(
      async () =>
        !rt.scheduler.isActive(agentId) && rt.scheduler.pendingStarts(agentId).length === 0,
      "the agent to be free",
      async () =>
        `active ${rt.scheduler.isActive(agentId)}, ${rt.scheduler.pendingStarts(agentId).length} waiting`,
      10_000,
    );
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
    // A deploy keeps the full review (ADR 0104, the owner's decision 4): its wait suggests no
    // light review as a way out.
    const ops = await client.createProject({ name: "Site deploy", goal: "Deploy the site" });
    const deploy = await client.createTask(ops.id, {
      title: "Deploy the site",
      outcome: "The site is live with a rollback runbook",
      riskTier: 2,
      specialist: "ops-deploy",
    });
    const deployRow = (await client.tasks(ops.id)).find((t) => t.id === deploy.id);
    expect(deployRow?.display?.label).toBe("Waiting for Docker");
    expect(deployRow?.display?.detail).toBe(
      "A deploy or a migration keeps the full review, which needs Docker. Set it up in Settings.",
    );
    expect(deployRow?.display?.detail?.length).toBeLessThanOrEqual(100);
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

  it("project status sentence: Ready to continue, Waiting for you, Done with the folder, and the Overview's Next (design §2, §3.4)", async () => {
    const own = await client.createProject({ name: "Status line", goal: "One sentence" });
    const first = await client.createTask(own.id, {
      title: "Create index.html",
      outcome: "a page",
    });
    const second = await client.createTask(own.id, {
      title: "Style the page",
      outcome: "styled",
      dependsOn: [first.id],
    });
    const ready = await client.project(own.id);
    expect(ready.statusLine).toEqual({
      kind: "ready",
      text: "Ready to continue: 1 task ready",
      action: { kind: "start", label: "Continue", to: null },
    });
    expect(ready.progress).toEqual({ done: 0, total: 2 });
    expect(ready.working).toBeNull();
    // A model is in force here: /me names it, so the header shows no "not connected" bar.
    expect(typeof (await client.me()).provider).toBe("string");
    // The list Home reads carries the same sentence.
    expect((await client.projects()).find((p) => p.id === own.id)?.statusLine?.text).toBe(
      "Ready to continue: 1 task ready",
    );
    // The Overview's Next, computed when read.
    expect((await client.projectSummary(own.id)).next).toEqual([
      '"Create index.html": Ready',
      '"Style the page": Waiting for "Create index.html"',
    ]);
    const card = await rt.store.humanRequest.insert({
      human_id: humanId,
      project_id: own.id,
      task_id: null,
      kind: "decision",
      why: "Where is it published?",
      steps: [],
      options: ["Locally"],
      blocking: true,
      risk: "low",
      change_card: null,
    });
    expect((await client.project(own.id)).statusLine).toMatchObject({
      kind: "waiting",
      text: "Waiting for you: 1 question",
    });
    await rt.store.humanRequest.answer(card.id, card.version, "Locally", humanId);
    for (const id of [first.id, second.id])
      for (const to of ["claimed", "in_progress", "in_review", "done"] as const) {
        const t = await rt.store.task.mustGet(id);
        await rt.store.task.transition(t.id, t.version, to, "finished", { agentId });
      }
    const done = await client.project(own.id);
    expect(done.statusLine?.kind).toBe("done");
    // later #53/#54 (polish-words): no path in the line (it held the project's id, about 130
    // characters); "Open your files" opens Files, and the Overview shows the folder.
    expect(done.statusLine?.text).toBe("Done: all 2 tasks.");
    expect(done.statusLine?.action).toMatchObject({
      label: "Open your files",
      to: `/projects/${own.id}/files`,
    });
    expect(done.folder).toBeTruthy();
    expect(done.progress).toEqual({ done: 2, total: 2 });
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

  it("Settings → Basics → Your name: the setup assistant's profile route renames you, and /me says so (design §6)", async () => {
    const before = (await client.me()).name;
    try {
      // The body the Basics form sends.
      const status = await client.setupProfile({ name: "Robin" });
      expect(status.name).toBe("Robin");
      expect((await client.me()).name).toBe("Robin");
    } finally {
      await client.setupProfile({ name: before });
    }
    expect((await client.me()).name).toBe(before);
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
    expect((await client.tasks(tab.id)).map((t) => t.title)).toContain("Write the tab README");
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
    // Its title as a title (phase E: capitalised), the words as said its outcome.
    const made = (await client.tasks(projectId)).find((t) => t.title === "Finish me");
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
    // The critic reviews every task (ADR 0104), tier 0 too: it accepts here, so the script
    // (and `provider.calls`) sees only the specialists' calls it was written for.
    provider: new AcceptingCriticProvider(provider),
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
    // W14-6 (polish-words): an amount above zero never reads "CHF 0.00".
    expect((await client.session(sessionId)).summary).toBe(
      'Did 1 task: "Second task".\nNothing left. Less than CHF 0.01.',
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

describe("the UI client against the real daemon: a start waiting behind a session runs when it ends (wave 1-2 handoff)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    ({ rt, client, provider } = await composeWithWaitingRun([WAITING_CALL]));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("'Starts after the current session' is true at once: the waiting start begins when the running one ends, with no scheduler tick", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Queued", goal: "One after the other" });
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
    await eventually(
      async () => provider.calls.length >= 1,
      "the running task's model call",
      async () => `${provider.calls.length} model call(s)`,
      10_000,
    );
    // The Start dialog's call while it runs: it waits its turn.
    const waiting = await client.startSession({ agentId, projectId: project.id });
    expect(waiting).toMatchObject({ result: "queued", ahead: 0, session: null });
    const sessionsOf = async () => (await client.sessions({ projectId: project.id })).length;
    expect(await sessionsOf()).toBe(1);
    // The person cancels the running task: the session ends. The simulated clock does not move,
    // so no scheduler tick runs; the waiting start begins all the same.
    const row = (await client.tasks(project.id)).find((t) => t.id === task.id);
    await client.transitionTask(task.id, {
      version: row?.version ?? 0,
      to: "cancelled",
      reason: "Cancelled in the app",
    });
    await eventually(
      async () => (await sessionsOf()) === 2 && rt.scheduler.pendingStarts(agentId).length === 0,
      "the waiting start to begin its session",
      async () =>
        `${await sessionsOf()} session(s), ${rt.scheduler.pendingStarts(agentId).length} waiting, active ${rt.scheduler.isActive(agentId)}`,
      10_000,
    );
    // Nothing is left running or waiting for the next test: the second session finds nothing
    // to run and ends.
    await eventually(
      async () => !rt.scheduler.isActive(agentId),
      "the agent to be free",
      async () => `active ${rt.scheduler.isActive(agentId)}`,
      10_000,
    );
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
    // W14-6 (polish-words): an amount above zero never reads "CHF 0.00".
    expect(session.summary).toBe('Did 1 task: "Second task".\nLess than CHF 0.01.');
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
async function composeWithRolePlayer(
  env: Record<string, string>,
  over: Partial<ComposeOptions> = {},
  /** The daemon's own environment beside its home (`FORERUNNER_WEB_FETCH=off`, ...). */
  daemonEnv: Record<string, string> = {},
): Promise<{
  rt: RuntimeApp;
  client: DaemonClient;
  /** The stand-in's knobs, read at each call: a case can plant a failure for one step. */
  bench: BenchOptions;
  /** The intake calls the stand-in received, in order (what the planner was told). */
  intakeCalls: ModelRequest[];
  /** The chat turns' calls the stand-in received, in order (what the chat was told). */
  chatCalls: ModelRequest[];
  /** The critic's calls the stand-in received, in order (what each review was given). */
  criticCalls: ModelRequest[];
  /** The specialists' calls (merged-copy: what a run saw of its folder, tool results included). */
  specialistCalls: ModelRequest[];
}> {
  const home = mkdtempSync(join(tmpdir(), "fr-ui-real-needs-me-"));
  const bench = benchOptionsFromEnv(
    { FORERUNNER_BENCH_DELAY_MS: "0", ...env },
    new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
  );
  const provider = createRolePlayer(bench);
  const intakeCalls: ModelRequest[] = [];
  const chatCalls: ModelRequest[] = [];
  const criticCalls: ModelRequest[] = [];
  const specialistCalls: ModelRequest[] = [];
  const stream = provider.stream.bind(provider);
  provider.stream = (req) => {
    const role = detectRole(req).role;
    if (role === "intake") intakeCalls.push(req);
    if (role === "critic") criticCalls.push({ ...req, messages: structuredClone(req.messages) });
    if (role === "specialist")
      specialistCalls.push({ ...req, messages: structuredClone(req.messages) });
    // A copy: the loop appends the reply to the same messages after the call.
    if (role === "chat") chatCalls.push({ ...req, messages: structuredClone(req.messages) });
    return stream(req);
  };
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home, ...daemonEnv },
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
    // The role-player is the bench's stand-in: composed as `fr daemon --provider bench` is, with
    // the page reader's loopback seam, so a research task reads the test's pages on 127.0.0.1
    // ('sites': no list opens this computer any more).
    webReadLoopback: true,
    ...over,
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
  return { rt, client, bench, intakeCalls, chatCalls, criticCalls, specialistCalls };
}

/** A PNG of one pixel: what a try's screenshot file holds here. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("the UI client against the real daemon: nothing is Done without the right check (ADR 0104)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let bench: BenchOptions;
  const tries: TryPagesRequest[] = [];

  beforeAll(async () => {
    // The try port stands in for the headless browser (its own test drives a real Chromium):
    // it stores a screenshot where the daemon keeps them and says what a person would see.
    let evidenceRoot = "";
    ({ rt, client, bench } = await composeWithRolePlayer(
      { FORERUNNER_BENCH_ASK: "Members chart", FORERUNNER_BENCH_MISSING: "Members chart" },
      {
        tryIt: {
          tryPages: async (req) => {
            tries.push(req);
            const dir = join(evidenceRoot, req.taskId, req.reviewKey);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "index-1280.png"), ONE_PIXEL_PNG);
            return {
              tried: req.pages.map((page) => ({
                what: `opened ${page} in a browser, 1280 pixels wide`,
                target: page,
                ok: true,
                blocking: false,
                output: `opened ${page} at 1280 pixels wide, the network off\ntitle: Page\ntext seen: Hello`,
                screenshots: [
                  {
                    label: "1280 pixels wide (a computer)",
                    file: `${req.reviewKey}/index-1280.png`,
                  },
                ],
              })),
            };
          },
        },
      },
    ));
    evidenceRoot = evidenceRootOf(rt.dirs);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const runSession = async (projectId: string) => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", "),
      30_000,
    );
  };

  it("a page task the planner put at tier 0: the critic reviews it, the page is tried, the task says Reviewed and tried, and the drawer opens the evidence", async () => {
    const project = await client.createProject({ name: "Garden page", goal: "A welcome page" });
    const page = await client.createTask(project.id, {
      title: "Build index.html with the club's welcome page",
      outcome: "index.html shows the club's name and a welcome line",
      riskTier: 0,
      specialist: "coder",
    });
    await runSession(project.id);
    const row = (await client.tasks(project.id)).find((t) => t.id === page.id);
    expect(row?.status).toBe("done");
    expect(row?.check).toEqual({ label: "Reviewed and tried", tried: true });
    // The page was tried in the task's folder.
    expect(tries.map((t) => [t.taskId, t.pages])).toEqual([[page.id, ["index.html"]]]);
    const detail = await client.task(page.id);
    // Reviewed by the critic (its run is in the drawer), never closed on the coder's word.
    expect(detail.runs.map((r) => [r.kind, r.specialist])).toEqual([
      ["review", "critic"],
      ["work", "coder"],
    ]);
    expect(detail.review?.check).toEqual({ label: "Reviewed and tried", tried: true });
    const tried = detail.review?.evidence?.tried ?? [];
    expect(tried.map((t) => [t.target, t.ok])).toEqual([["index.html", true]]);
    expect(tried[0]?.output).toContain("text seen: Hello");
    const file = tried[0]?.screenshots[0]?.file ?? "";
    expect(file).toMatch(/^[A-Za-z0-9._-]+\/index-1280\.png$/);
    // One click away: the screenshot itself, as the drawer reads it.
    const shot = await client.taskEvidence(page.id, file);
    expect(shot).toMatchObject({ file, contentType: "image/png" });
    expect(Buffer.from(shot.base64, "base64").equals(ONE_PIXEL_PNG)).toBe(true);
    // Nothing outside the task's own evidence folder is served.
    for (const bad of ["../../runtime/daemon.json", `${file}/../../x.png`, "x.png"])
      await expect(client.taskEvidence(page.id, bad)).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it("a task keeps only its latest review's screenshots: a review sent back and tried again replaces the first try's (phase E, C-20)", async () => {
    // Before, every review's screenshots stayed under <data>/evidence/<task>/<review>/ for
    // good (Redo and Try again added more); the drawer shows the latest review only.
    const project = await client.createProject({ name: "About page", goal: "An about page" });
    const page = await client.createTask(project.id, {
      title: "Build about.html with the club's history",
      outcome: "about.html tells the club's history in two paragraphs",
      riskTier: 0,
      specialist: "coder",
    });
    // The critic sends the first attempt back once, so the page is tried twice.
    bench.reject = ["Build about.html"];
    bench.rejectTimes = 1;
    try {
      await runSession(project.id);
    } finally {
      bench.reject = [];
    }
    const ofTask = tries.filter((t) => t.taskId === page.id);
    expect(ofTask.length, JSON.stringify(ofTask.map((t) => t.reviewKey))).toBe(2);
    const [first, latest] = ofTask;
    expect((await client.tasks(project.id)).find((t) => t.id === page.id)?.status).toBe("done");
    // On disk: the latest review's folder only.
    expect(readdirSync(join(evidenceRootOf(rt.dirs), page.id))).toEqual([latest?.reviewKey]);
    // The drawer still opens the latest review's screenshot; the first try's is gone.
    const detail = await client.task(page.id);
    const file = detail.review?.evidence?.tried?.[0]?.screenshots[0]?.file ?? "";
    expect(file).toBe(`${latest?.reviewKey}/index-1280.png`);
    const shot = await client.taskEvidence(page.id, file);
    expect(Buffer.from(shot.base64, "base64").equals(ONE_PIXEL_PNG)).toBe(true);
    await expect(
      client.taskEvidence(page.id, `${first?.reviewKey}/index-1280.png`),
    ).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it("a data task whose input file is missing, answered Go ahead without: it ends waiting for you with a card that asks for the file, never Done", async () => {
    const project = await client.createProject({ name: "Garden data", goal: "A members chart" });
    const chart = await client.createTask(project.id, {
      title: "Members chart",
      outcome: "charts/members.svg: a bar chart of members per year from data/members.csv",
      acceptanceCriteria: [
        "Every bar uses the exact number from data/members.csv",
        "No number is invented",
      ],
      specialist: "data-analyst",
    });
    await runSession(project.id);
    const me = await client.me();
    const cardsOf = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.taskId === chart.id && r.status === "open",
      );
    // First the specialist asks; the person answers with the card's own button.
    const [asked] = await cardsOf();
    if (!asked) throw new Error("no question card");
    const goAhead = asked.choices?.find((c) => c.label === "Go ahead without");
    expect(goAhead).toBeDefined();
    const sessionsBefore = (await client.sessions({ projectId: project.id })).length;
    await client.answerRequest(asked.id, { version: asked.version, answer: "Go ahead without" });
    await eventually(
      async () => {
        const sessions = await client.sessions({ projectId: project.id });
        return sessions.length > sessionsBefore && sessions.every((s) => s.status !== "running");
      },
      "the session the answer started to end",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      30_000,
    );
    // The work made no chart and asked for the file: not done, it needs you.
    const row = (await client.tasks(project.id)).find((t) => t.id === chart.id);
    expect(row?.status).toBe("needs_human");
    expect(row?.check ?? null).toBeNull();
    expect(row?.display?.label).toMatch(/^Needs your answer/);
    const cards = await cardsOf();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.title).toBe('"Members chart": the specialist asks you');
    expect(card?.steps).toEqual([
      'Please add data/members.csv to the project\'s folder: "Members chart" needs it and no number may be invented.',
    ]);
    // In the specialist's own words, never the critic's accept of a chart that was not made.
    expect(card?.body).toContain("data/members.csv is missing");
    expect(card?.body).not.toMatch(/Accepted/);
    // Go ahead without was chosen already: it is not offered again (live L-3), on the card or
    // on the Tasks tab, which offers Answer and Cancel.
    expect(card?.choices?.map((c) => c.label)).toEqual(["Cancel task"]);
    expect(row?.display?.blocker).toMatchObject({ cardKind: "questions", goAhead: false });
    expect((await client.inbox(me.id)).needsYouCount).toBeGreaterThan(0);
  }, 90_000);
});

describe("the UI client against the real daemon: a retry that changes no file is checked again (review of 2026-11-02)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let criticCalls: ModelRequest[];

  beforeAll(async () => {
    // The project's test runs through npm in the task's sandbox, as on a person's computer: the
    // daemon's environment carries what finds and starts npm there (the other cases give it
    // FORERUNNER_HOME only).
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-checks-"));
    const env: Record<string, string> = { FORERUNNER_HOME: home };
    for (const k of ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "HOME"])
      if (process.env[k]) env[k] = process.env[k] as string;
    ({ rt, client, criticCalls } = await composeWithRolePlayer(
      {},
      { env, dirs: appDirs({ env: { FORERUNNER_HOME: home } }), tryIt: false },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a code task whose project test always fails: every review runs the test, also after a run that changed nothing, and the task is never Done", async () => {
    // Bench walk C: reviews 1 and 2 ran the failing test and sent the work back; attempt 3
    // rewrote src/clamp.js as it was, review 3 had no files, no checks and accepted, and the
    // accept closed the failed test: "Done · Reviewed" with the test still failing.
    const project = await client.createProject({ name: "Clamp lib", goal: "A tiny maths library" });
    const folder = (await client.projectFiles(project.id)).folder ?? "";
    expect(folder).not.toBe("");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ name: "clamp-lib", private: true, scripts: { test: "node fail.js" } }),
    );
    writeFileSync(
      join(folder, "fail.js"),
      "console.log('not ok 1 - clamp keeps 5 inside 0..3');\nprocess.exit(1);\n",
    );
    const clamp = await client.createTask(project.id, {
      title: "Add clamp in src/clamp.js",
      outcome: "src/clamp.js exports clamp(x, lo, hi)",
      acceptanceCriteria: ["clamp(5, 0, 3) is 3"],
      riskTier: 1,
      specialist: "coder",
    });
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      60_000,
    );
    const detail = await client.task(clamp.id);
    const work = detail.runs.filter((r) => r.kind === "work");
    const reviews = detail.runs.filter((r) => r.kind === "review");
    expect(work.length, JSON.stringify(detail.runs)).toBeGreaterThan(1);
    // The walk's hole: a run after the first changed no file, and was still checked.
    expect(
      work.slice(0, -1).some((r) => r.files.length === 0),
      JSON.stringify(work),
    ).toBe(true);
    // Each review was given the project's test result, the failure included.
    const firstTurns = criticCalls.filter(
      (c) =>
        JSON.stringify(c.messages).includes("Add clamp in src/clamp.js") && c.messages.length === 1,
    );
    expect(firstTurns).toHaveLength(reviews.length);
    for (const c of firstTurns)
      expect(JSON.stringify(c.messages)).toContain("not ok 1 - clamp keeps 5 inside 0..3");
    // Never Done while the test fails; what the drawer opens says the test failed.
    const row = (await client.tasks(project.id)).find((t) => t.id === clamp.id);
    expect(row?.status).not.toBe("done");
    expect(row?.check ?? null).toBeNull();
    expect(detail.review?.evidence?.checks.find((c) => c.name === "test")).toMatchObject({
      passed: false,
    });
    // What the critic still asks for, in the drawer: the test to pass.
    expect(detail.review?.open).toContain(
      'Make the check "test" pass; if it failed before this task, say so and why under "Questions for the person:"',
    );
  }, 90_000);
});

describe("the UI client against the real daemon: what was checked survives a restart (ADR 0104)", () => {
  it("a page task reads 'Reviewed and tried', with its evidence and its screenshot, after the daemon starts again on the same home", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-evidence-"));
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const first = await composeWithRolePlayer(
      {},
      {
        env,
        dirs,
        stateUrl,
        tryIt: {
          tryPages: async (req) => {
            const dir = join(evidenceRootOf(dirs), req.taskId, req.reviewKey);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "index-1280.png"), ONE_PIXEL_PNG);
            return {
              tried: req.pages.map((page) => ({
                what: `opened ${page} in a browser, 1280 pixels wide`,
                target: page,
                ok: true,
                blocking: false,
                output: `opened ${page} at 1280 pixels wide, the network off\ntitle: Quotes\ntext seen: Hello`,
                screenshots: [
                  {
                    label: "1280 pixels wide (a computer)",
                    file: `${req.reviewKey}/index-1280.png`,
                  },
                ],
              })),
            };
          },
        },
      },
    );
    let projectId = "";
    let taskId = "";
    try {
      const project = await first.client.createProject({ name: "Quotes", goal: "A quote page" });
      projectId = project.id;
      const page = await first.client.createTask(project.id, {
        title: "Build index.html with a random quote",
        outcome: "index.html shows a quote",
        riskTier: 1,
        specialist: "coder",
      });
      taskId = page.id;
      const agentId = (await first.client.agents())[0]?.id ?? "";
      const started = await first.client.startSession({ agentId, projectId });
      await eventually(
        async () => (await first.client.session(started.session?.id ?? "")).status !== "running",
        "the session to end",
        async () => (await first.client.tasks(projectId)).map((t) => t.status).join(", "),
        30_000,
      );
      const before = (await first.client.tasks(projectId)).find((t) => t.id === taskId);
      expect(before?.check).toEqual({ label: "Reviewed and tried", tried: true });
    } finally {
      await first.rt.close();
    }

    // The daemon starts again on the same home: the same words, the same evidence, the same file.
    const second = await composeWithRolePlayer({}, { env, dirs, stateUrl, tryIt: false });
    try {
      const row = (await second.client.tasks(projectId)).find((t) => t.id === taskId);
      expect(row?.status).toBe("done");
      expect(row?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const detail = await second.client.task(taskId);
      expect(detail.review?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const tried = detail.review?.evidence?.tried ?? [];
      expect(tried.map((t) => [t.target, t.ok])).toEqual([["index.html", true]]);
      const file = tried[0]?.screenshots[0]?.file ?? "";
      const shot = await second.client.taskEvidence(taskId, file);
      expect(Buffer.from(shot.base64, "base64").equals(ONE_PIXEL_PNG)).toBe(true);
    } finally {
      await second.rt.close();
    }
  }, 90_000);
});

describe("the UI client against the real daemon: a command line tool and an API are tried in the task's sandbox (ADR 0110)", () => {
  // The daemon as composed, on the stand-in model, without Docker: a light review's tries run in
  // the process sandbox. No browser stand-in: nothing here is a page.
  const runSession = async (client: DaemonClient, projectId: string) => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", "),
      30_000,
    );
  };

  it("a word-count tool: Done · Reviewed and tried, the drawer's evidence shows the command, its sample file and its output, also after a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-cli-"));
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const first = await composeWithRolePlayer({}, { env, dirs, stateUrl, tryIt: false });
    let taskId = "";
    let projectId = "";
    try {
      const project = await first.client.createProject({
        name: "Word count",
        goal: "A command that counts the words in a file",
      });
      projectId = project.id;
      const task = await first.client.createTask(project.id, {
        title: "Write wc.js",
        outcome: "A command line tool that counts the words in a file",
        acceptanceCriteria: ["`node wc.js <file>` prints the number of words in the file"],
        riskTier: 1,
        specialist: "coder",
      });
      taskId = task.id;
      await runSession(first.client, project.id);
      const row = (await first.client.tasks(project.id)).find((t) => t.id === task.id);
      expect(row?.status).toBe("done");
      expect(row?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const detail = await first.client.task(task.id);
      expect(detail.review?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const tried = detail.review?.evidence?.tried ?? [];
      expect(tried.map((t) => [t.kind, t.target, t.ok])).toEqual([
        ["command", "node wc.js <file>", true],
      ]);
      expect(tried[0]?.screenshots).toEqual([]);
      const out = tried[0]?.output ?? "";
      expect(out).toContain(
        "ran node wc.js <file> (from an acceptance criterion) on this computer, not in a container (a program that ignores proxy settings can still reach the network)",
      );
      expect(out).toContain("<file>: a sample text file written for the try (2 lines, 9 words):");
      // The stand-in's tool counted the sample's words, in the sandbox, as a person would.
      expect(out).toMatch(/exit 0 in \d+ ms\noutput:\n9(\n|$)/);
      // The try's own files left the project's folder.
      const listed = await first.client.projectFiles(project.id);
      expect(JSON.stringify(listed)).not.toContain(".forerunner-try");
    } finally {
      await first.rt.close();
    }
    // The daemon starts again on the same home: the same words and the same evidence.
    const second = await composeWithRolePlayer({}, { env, dirs, stateUrl, tryIt: false });
    try {
      const row = (await second.client.tasks(projectId)).find((t) => t.id === taskId);
      expect(row?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const tried = (await second.client.task(taskId)).review?.evidence?.tried ?? [];
      expect(tried.map((t) => [t.kind, t.target])).toEqual([["command", "node wc.js <file>"]]);
    } finally {
      await second.rt.close();
    }
  }, 90_000);

  it("a tiny HTTP API: it is started and the route the brief names is called; the reply is the evidence", async () => {
    const { rt, client } = await composeWithRolePlayer({}, { tryIt: false });
    try {
      const project = await client.createProject({ name: "Tiny API", goal: "A health route" });
      const task = await client.createTask(project.id, {
        title: "Write server.js",
        outcome:
          'A tiny HTTP API: `node server.js` listens on PORT (3000 when unset); GET /health answers {"ok":true}',
        acceptanceCriteria: ['GET /health answers 200 with {"ok":true}'],
        riskTier: 1,
        specialist: "coder",
      });
      await runSession(client, project.id);
      const detail = await client.task(task.id);
      expect(detail.task.status).toBe("done");
      expect(detail.review?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const tried = detail.review?.evidence?.tried ?? [];
      expect(tried.map((t) => [t.kind, t.target, t.ok])).toEqual([
        ["server", "node server.js", true],
      ]);
      expect(tried[0]?.output).toContain(
        "started node server.js (from the brief) on this computer, not in a container (a program that ignores proxy settings can still reach the network); it listened",
      );
      expect(tried[0]?.output).toContain(
        'GET /health (named in the brief) -> 200 application/json: {"ok":true}',
      );
    } finally {
      await rt.close();
    }
  }, 90_000);

  it("a full-review task's tool is tried in the task's container when Docker is ready (the engine is a stand-in; CI's sandbox-full-review job runs the real one)", async () => {
    const IMAGE = "registry.example/forerunner-runner:ui-contract";
    const engine = new FakeContainerEngine({ images: [IMAGE] });
    const { rt, client } = await composeWithRolePlayer(
      {},
      {
        tryIt: false,
        sandboxDetection: undefined,
        sandboxRun: engine.run,
        sandboxWhich: engine.which,
      },
      { FORERUNNER_RUNNER_IMAGE: IMAGE },
    );
    try {
      expect((await client.sandboxStatus()).state).toBe("ready");
      const project = await client.createProject({ name: "Greeting", goal: "A greeting tool" });
      const task = await client.createTask(project.id, {
        title: "Write src/greet.js",
        outcome: "src/greet.js greets the name it is given",
        acceptanceCriteria: ["`node src/greet.js Ada` prints Hello, Ada!"],
        riskTier: 2,
        specialist: "coder",
      });
      await runSession(client, project.id);
      const detail = await client.task(task.id);
      expect(detail.task.status).toBe("done");
      expect(detail.review?.check).toEqual({ label: "Reviewed and tried", tried: true });
      const tried = detail.review?.evidence?.tried ?? [];
      expect(tried.map((t) => [t.kind, t.target, t.ok])).toEqual([
        ["command", "node src/greet.js Ada", true],
      ]);
      expect(tried[0]?.output).toContain(
        "ran node src/greet.js Ada (from an acceptance criterion) in the task's Docker container, the network off",
      );
      expect(tried[0]?.output).toMatch(/output:\nHello, Ada!/);
      // The engine was asked to run the try inside the task's container, never on the host.
      const execs = engine.calls.filter((c) => c[1] === "exec").map((c) => c.join(" "));
      expect(execs.some((c) => / timeout -s KILL \d+ node src\/greet\.js Ada$/.test(c))).toBe(true);
      // The review's container had no network.
      const runs = engine.calls.filter((c) => c[1] === "run").map((c) => c.join(" "));
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((c) => c.includes("--network none"))).toBe(true);
    } finally {
      await rt.close();
    }
  }, 90_000);
});

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
  let chatCalls: ModelRequest[];

  beforeAll(async () => {
    ({ rt, client, bench, intakeCalls, chatCalls } = await composeWithRolePlayer({}));
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

  it("'Only these websites' reaches the planner: it is told to plan no research that needs another website ('sites')", async () => {
    const project = await client.createProject({ name: "Docs only", goal: "Explain CSS grid" });
    const set = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: {
            key: "web_access",
            value: { mode: "only", only: ["developer.mozilla.org"], never: [] },
            project: project.id,
          },
        },
      ],
      wordsUsed: "Settings: Web pages research may read to Only these websites",
      source: "ui",
      projectId: project.id,
    });
    expect(set.status).toBe("done");
    const before = intakeCalls.length;
    await client.retryIntake(project.id);
    await rt.intake.inFlight(project.id);
    const request = String(intakeCalls[before]?.messages[0]?.content);
    expect(request).toContain(
      "Web access: this project's research reads only these websites and their subdomains: developer.mozilla.org. Plan no research that needs another website",
    );
  }, 60_000);

  it("a one-line brief without a Goal: the dialog's goal, a small plan, a first reply without tasks asked for once more, one card (live check of 2026-11-01)", async () => {
    bench.intakeBad = "missing-tasks";
    try {
      const before = intakeCalls.length;
      const brief = "A page that shows a random quote";
      // What New project sends when the Goal is left empty (NewProjectDialog).
      const project = await client.createProject({
        name: "One line",
        goal: goalFromBrief(brief),
        brief,
        intake: true,
      });
      expect(project.goal).toBe("A page that shows a random quote");
      // A short brief asks for a small plan, without small-project mode: its tasks keep the
      // critic's review (ADR 0103; the owner's decision of 2026-11-01).
      expect(project.smallProjectMode).toBe(false);
      expect(project.defaultRiskTier).toBe(1);
      await rt.intake.inFlight(project.id);
      // The first reply had no tasks; the intake asked once more, with the problem in words.
      const calls = intakeCalls.slice(before);
      expect(calls).toHaveLength(2);
      expect(String(calls[0]?.messages[0]?.content)).toContain(
        "Plan size: small (a short brief: see Size in your instructions)",
      );
      expect(String(calls[1]?.messages[2]?.content)).toContain("- plan: the plan has no task");
      expect(await client.intakeStatus(project.id)).toMatchObject({ state: "pending" });
      const me = await client.me();
      const cards = (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]?.title).toBe('Plan for "One line": 2 tasks');
    } finally {
      bench.intakeBad = "none";
    }
  }, 60_000);

  it("a reply that cannot be read, twice: the project page says so in words", async () => {
    bench.intake = "malformed";
    try {
      const project = await client.createProject({
        name: "Unreadable",
        goal: "A quote page",
        brief: BRIEF,
        intake: true,
      });
      await rt.intake.inFlight(project.id)?.catch(() => undefined);
      expect(await client.intakeStatus(project.id)).toMatchObject({
        state: "failed",
        error: "Claude's plan could not be read. Forerunner asked Claude twice.",
      });
    } finally {
      bench.intake = "ok";
    }
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
    // Home's row and the header say it in one sentence with the button (design §3.3, §5.1).
    expect((await client.project(project.id)).statusLine).toEqual({
      kind: "planning_failed",
      text: "You rejected the plan. Nothing was written.",
      action: { kind: "retry", label: "Draft a new plan", to: null },
    });
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
    // Home's row and the header: a few words and Try again (design §2 item 5, §5.1).
    expect((await client.project(project.id)).statusLine).toEqual({
      kind: "planning_failed",
      text: "Planning failed: Claude did not answer",
      action: { kind: "retry", label: "Try again", to: null },
    });
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

  it("planning failed: a chat turn is told why and that Try again drafts the plan again (the live run of 2026-11-01)", async () => {
    // The live model answered "The Quote page project has no tasks yet… I can add tasks…"
    // after planning had failed: the chat was told "(no tasks yet)" and nothing of the plan.
    bench.intake = "malformed";
    let project: Awaited<ReturnType<DaemonClient["createProject"]>>;
    try {
      project = await client.createProject({
        name: "Quote failed",
        goal: "A quote page",
        brief: BRIEF,
        intake: true,
      });
      await rt.intake.inFlight(project.id)?.catch(() => undefined);
    } finally {
      bench.intake = "ok";
    }
    const failed = await client.intakeStatus(project.id);
    expect(failed.state).toBe("failed");
    const cause = (failed.error ?? "").replace(/[.\s]+$/, "");
    expect(cause).not.toBe("");
    const me = await client.me();
    const before = chatCalls.length;
    // What the project's Chat tab sends.
    const reply = await client.chat({
      humanId: me.id,
      agentId: rt.agent.id,
      projectId: project.id,
      projectTab: true,
      text: "what is left to do?",
      source: "text",
    });
    expect(chatCalls.length).toBeGreaterThan(before);
    const sent = JSON.stringify(chatCalls.at(-1)?.messages.at(-1)?.content ?? "");
    expect(sent).toContain(
      `Planning failed: ${cause}. The person can press Try again on the project page.`,
    );
    // The empty task list says why it is empty, never the "(no tasks yet)" the live reply echoed.
    expect(sent).toContain("(none yet: planning failed, so nothing was written)");
    expect(sent).not.toContain("(no tasks yet)");
    // The stand-in says what it was told about the plan, so the person reads it in the reply.
    expect(reply.reply).toContain(`Planning failed: ${cause}.`);
    // Once the plan waits in the Inbox, the chat is told that instead.
    await client.retryIntake(project.id);
    await rt.intake.inFlight(project.id);
    await client.chat({
      humanId: me.id,
      agentId: rt.agent.id,
      projectId: project.id,
      projectTab: true,
      text: "what is left to do?",
      source: "text",
    });
    const after = JSON.stringify(chatCalls.at(-1)?.messages.at(-1)?.content ?? "");
    expect(after).toContain("The plan from your brief waits for your approval in the Inbox.");
    expect(after).toContain("(none yet: the plan from the brief writes them once it is approved)");
    expect(after).not.toContain("Planning failed");
  }, 60_000);
});

describe("the UI client against the real daemon: a one-line brief's work is reviewed by the critic (the owner's decision of 2026-11-01)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    ({ rt, client } = await composeWithRolePlayer({}));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("New project with a one-line brief, Approve and start: the coder builds, then the critic reviews, before the task is done", async () => {
    const brief = "A page that shows a random quote";
    const project = await client.createProject({
      name: "Reviewed quote",
      goal: goalFromBrief(brief),
      brief,
      intake: true,
    });
    // A small plan, not small-project mode: a task that names no tier gets light review.
    expect(project.smallProjectMode).toBe(false);
    expect(project.defaultRiskTier).toBe(1);
    await rt.intake.inFlight(project.id);
    const me = await client.me();
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.projectId === project.id && r.status === "open",
    );
    if (!card) throw new Error("no plan card");
    expect(card.title).toBe('Plan for "Reviewed quote": 2 tasks');
    await client.answerRequest(card.id, { version: card.version, answer: "Approve and start" });
    const tasks = await client.tasks(project.id);
    const build = tasks.find((t) => t.specialist === "coder");
    if (!build) throw new Error(`no coder task in ${tasks.map((t) => t.title).join(", ")}`);
    expect(build.riskTier).toBeGreaterThanOrEqual(1);
    const states = async () =>
      (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
    await eventually(
      async () => (await client.task(build.id)).task.status === "done",
      "the build task to be done",
      states,
      60_000,
    );
    // The task's runs, newest first: the critic's review after the coder's work.
    const runs = (await client.task(build.id)).runs;
    expect(runs.map((r) => [r.kind, r.specialist])).toEqual([
      ["review", "critic"],
      ["work", "coder"],
    ]);
    // Nothing is left running for the next case: the session Approve and start began ends.
    await eventually(
      async () =>
        (await client.sessions({ projectId: project.id })).every((s) => s.status !== "running"),
      "the session to end",
      states,
      60_000,
    );
  }, 150_000);
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
      "Write the README",
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

  it("/me says no provider is in force, which the header's no-key bar reads (design §3.1)", async () => {
    expect((await client.me()).provider).toBeNull();
  });

  // Review of fix/progress-navigation: Home read "Planning failed: Planning from the brief needs
  // a Claude key or subscription. Add one in the app: Settings → Accounts and keys → Open the
  // setup assistant, then retry." (about 170 characters) with no button. Design §2 item 5, §5.1.
  it("a brief without Claude: the project's card says planning failed in one short sentence with Connect Claude, and the screens hear it", async () => {
    const heard: Promise<string>[] = [];
    const onProject = (p: { id: string }) =>
      heard.push(rt.intake.status(p.id).then((s) => s.state));
    rt.events.on("project", onProject);
    try {
      const created = await client.createProject({
        name: "No key plan",
        goal: "One page",
        brief: "A page that shows a random quote.",
        intake: true,
      });
      expect(created.statusLine?.text).toBe("Drafting the plan…");
      await rt.intake.inFlight(created.id)?.catch(() => undefined);
      // The draft's end is announced (`project.changed`), so Home and the header re-read the
      // card without a reload; before, only the creation was, while the plan was drafting.
      await eventually(
        async () => (await Promise.all(heard)).includes("failed"),
        "a project.changed after the plan failed",
        async () => (await Promise.all(heard)).join(", "),
        10_000,
      );
      const row = (await client.projects()).find((p) => p.id === created.id);
      expect(row?.statusLine).toEqual({
        kind: "planning_failed",
        text: "Planning failed: Claude is not connected",
        action: { kind: "link", label: "Connect Claude", to: "/setup" },
      });
      expect(row?.statusLine?.text.length).toBeLessThanOrEqual(80);
      // The project page's plan banner keeps the reason in full, with where to add a key.
      expect((await client.intakeStatus(created.id)).error).toContain(
        "Settings → Accounts and keys → Open the setup assistant",
      );
    } finally {
      rt.events.off("project", onProject);
    }
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

    // No: the card's No, then "yes". ("Skip the FAQ task" cancels it since L-10; a pause is
    // "pause" or "skip it for now".)
    const first = await say("pause the FAQ task");
    expect(first.pendingConfirmation?.readback).toMatch(/^Pause "Write the FAQ"\?/);
    expect((await say("no")).reply).toBe("Cancelled; nothing was changed.");
    expect((await say("yes")).reply).toBe("Yes to what? Nothing is waiting for your yes.");
    expect(await status()).toBe("Ready");

    // Yes: the card's Yes, then "yes".
    await say("skip the FAQ task for now");
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

describe("the UI client against the real daemon: work continues correctly (phase C, continuity)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-continuity-"));
    const clock = new SimulatedClock("2026-11-01T08:00:00Z");
    rt = await composeRuntime({
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

  it("GET /projects/:id/start-check prices a task at most at what is left of its own budget (live walk 2, B3)", async () => {
    const project = await client.createProject({ name: "Estimates", goal: "Priced right" });
    // As New task sends it: a budget of USD 0.02, below what the planner would estimate (a
    // coder task starts at its calibrated USD 0.04 since 'cost', L-22; it was USD 1.50).
    await client.createTask(project.id, {
      title: "About page",
      outcome: "about.html",
      acceptanceCriteria: ["about.html exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 20_000,
      specialist: "coder",
    });
    const check = await client.startCheck(project.id, { budgetUsdMicro: 5_000_000 });
    expect(check.runnable.map((t) => [t.title, t.estimate.usdMicro])).toEqual([
      ["About page", 20_000],
    ]);
  });
});

describe("the UI client against the real daemon: estimates start where the work costs ('cost', L-22)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-cost-"));
    const clock = new SimulatedClock("2026-11-03T08:00:00Z");
    rt = await composeRuntime({
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

  it("GET /projects/:id/start-check runs three tasks a person made in a CHF 0.50 session", async () => {
    const project = await client.createProject({ name: "Notes site", goal: "A notes site" });
    // As New task sends them: no estimate and no budget of their own.
    for (const title of ["Write the home page", "Write the about page", "Write the contact page"])
      await client.createTask(project.id, {
        title,
        outcome: `${title} in plain HTML`,
        acceptanceCriteria: [],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        specialist: "coder",
      });
    // The Start dialog's CHF 0.50 at about the day's rate (USD 0.61).
    const check = await client.startCheck(project.id, { budgetUsdMicro: 610_000 });
    // Before: each started at half the coder's registry cap and "needs about CHF 0.82, more
    // than this session's work budget of CHF 0.40": nothing could run.
    expect(check.overBudget).toEqual([]);
    expect(check.runnable.map((t) => t.title)).toEqual([
      "Write the home page",
      "Write the about page",
      "Write the contact page",
    ]);
    for (const t of check.runnable) expect(t.estimate.usdMicro).toBeLessThanOrEqual(100_000);
  });
});

describe("the UI client against the real daemon: a task that stops waits on one card (phase C, continuity)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let bench: BenchOptions;

  beforeAll(async () => {
    ({ rt, client, bench } = await composeWithRolePlayer({}));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** Waits (at least 10 s of real time) until no session of any project runs. */
  const allEnded = async () => {
    const running = async () =>
      (await client.sessions({})).filter((s) => ["running", "paused"].includes(s.status));
    await eventually(
      async () => (await running()).length === 0,
      "every session to end",
      async () => (await running()).map((s) => `${s.status}: ${s.summary ?? ""}`).join(" | "),
      20_000,
    );
  };

  /** Starts a session on the project and waits (at least 10 s of real time) for it to end. */
  const runSession = async (projectId: string) => {
    await allEnded();
    const agentId = (await client.agents())[0]?.id ?? "";
    const before = (await client.sessions({ projectId })).length;
    const started = await client.startSession({ agentId, projectId });
    expect(started.session?.id, JSON.stringify(started)).toBeTruthy();
    const sessions = async () => client.sessions({ projectId });
    await eventually(
      async () => {
        const all = await sessions();
        return all.length > before && all.every((s) => !["running", "paused"].includes(s.status));
      },
      "the session to end",
      async () => (await sessions()).map((s) => `${s.status}: ${s.summary ?? ""}`).join(" | "),
      20_000,
    );
    return client.session(started.session?.id ?? "");
  };

  it("a task paused at its budget: one card in CHF that the session's result and the Tasks tab agree with; Continue runs it to done (live walk 2, B2; budget-resume)", async () => {
    const me = await client.me();
    const project = await client.createProject({ name: "Budget card", goal: "Asked once" });
    // What New task sends with a budget of CHF 0.01 (USD 0.0125 at the test's rate).
    const created = await client.createTask(project.id, {
      title: "Contact page",
      outcome: "contact.html says how to reach the club",
      acceptanceCriteria: ["contact.html exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 12_500,
      specialist: "coder",
      riskTier: 1,
    });
    // Earlier runs spent the whole budget (setup, not under test): the next run stops before it
    // calls the model, as the live walk's run did "after spending $0.00". Its estimate is USD
    // 0.10 (CHF 0.08), more than its budget: Continue adds at least that.
    await rt.store.task.patch(created.id, {
      actual_cost_usd_micro: 12_500,
      est_cost_usd_micro: 100_000,
    });
    const session = await runSession(project.id);

    const cardsOf = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.taskId === created.id && r.status === "open",
      );
    const cards = await cardsOf();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    // budget-resume (ADR 0112 amended): it paused, and Continue adds the same budget again, at
    // least its estimate (before: "stopped at", "So far it spent", "Raise the budget" to CHF 0.44).
    expect(card?.title).toBe('"Contact page" paused at its budget of CHF 0.01');
    expect(card?.body).toBe(
      "It stopped before it could say where it stood; its work so far is kept.",
    );
    expect(card?.choices?.map((c) => [c.label, c.explain, c.tone])).toEqual([
      [
        "Continue (CHF 0.08 more)",
        "Adds CHF 0.08 to its budget and starts a session that goes on from where it stopped.",
        "primary",
      ],
      ["Cancel task", "Drops it; its work is set aside unless a later task built on it.", "danger"],
    ]);
    // The session's result points at the card that is there; the Tasks tab says the same.
    expect(session.summary).toContain(
      '"Contact page" paused at its budget of CHF 0.01: continue or cancel it in the Inbox.',
    );
    const view = (await client.tasks(project.id)).find((t) => t.id === created.id);
    expect(view?.display).toMatchObject({
      key: "answer",
      // ADR 0112: a stop at a budget is a pause (before: "Needs your decision: its budget is used").
      label: "Paused at its budget",
      blocker: { kind: "card", requestId: card?.id, cardKind: "budget" },
    });
    // CHF everywhere a person reads it.
    for (const text of [card?.title, card?.body, view?.reason, JSON.stringify(view?.display)])
      expect(String(text)).not.toMatch(/\$|USD/);

    // The click sends the button's words; the budget is raised and a session runs the task.
    const answered = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: "Continue (CHF 0.08 more)",
    });
    expect(answered.outcome).toMatch(
      /^Gave "Contact page" CHF 0\.08 more: (a session started|it runs after the current session)\.$/,
    );
    await eventually(
      async () =>
        (await client.tasks(project.id)).find((t) => t.id === created.id)?.status === "done",
      "the task to be done after the raise",
      async () => {
        const t = (await client.tasks(project.id)).find((x) => x.id === created.id);
        return `${t?.status}: ${t?.reason}`;
      },
      20_000,
    );
    const done = (await client.tasks(project.id)).find((t) => t.id === created.id);
    // What it had spent (USD 0.0125) plus USD 0.10.
    expect(done?.budget.usdMicro).toBe(112_500);
    expect(await cardsOf()).toEqual([]);
    // Nothing left running for the next case.
    await allEnded();
  });

  it("a task the run refused at once: one card that says why, the Tasks tab offers no Resume, Cancel task cancels it (live walk 4)", async () => {
    const me = await client.me();
    const project = await client.createProject({ name: "Logo club", goal: "A logo" });
    // A specialist this install does not have, as a plan can name one: the run refuses before
    // any call. (Live walk 4's refusal, the researcher on an API key, is gone since ADR 0107:
    // the researcher reads the web there now.)
    const created = await client.createTask(project.id, {
      title: "Draw the club's logo",
      outcome: "logo.svg shows the club's name",
      acceptanceCriteria: ["logo.svg names the club"],
      priority: "high",
      status: "ready",
      dependsOn: [],
      specialist: "illustrator",
      riskTier: 1,
    });
    const session = await runSession(project.id);
    const cards = (await client.inbox(me.id)).requests.filter(
      (r) => r.taskId === created.id && r.status === "open",
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.title).toBe('"Draw the club\'s logo" could not run');
    expect(card?.body).toMatch(
      /^No specialist is named "illustrator", so nothing ran\. The specialists are: coder, /,
    );
    expect(card?.body).not.toMatch(/cc:/);
    expect(card?.choices?.map((c) => [c.label, c.tone])).toEqual([
      ["Try again", "primary"],
      ["Cancel task", "danger"],
    ]);
    expect(session.summary).toContain('"Draw the club\'s logo" needs your decision (Inbox).');
    const view = (await client.tasks(project.id)).find((t) => t.id === created.id);
    expect(view?.display).toMatchObject({
      key: "answer",
      label: "Needs your decision: it could not run",
      blocker: { kind: "card", requestId: card?.id, cardKind: "cannot_run" },
    });
    const cancelled = await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: "Cancel task",
    });
    expect(cancelled.outcome).toBe('"Draw the club\'s logo" was cancelled.');
    expect((await client.tasks(project.id)).find((t) => t.id === created.id)?.status).toBe(
      "cancelled",
    );
  });

  it("Cancel while the task runs: the reply says its work is removed, its file leaves the folder, Undo brings it back (ADR 0105)", async () => {
    const project = await client.createProject({ name: "About club", goal: "An about page" });
    const created = await client.createTask(project.id, {
      title: "Write the About page in about.html",
      outcome: "about.html tells the club's story",
      acceptanceCriteria: ["about.html exists"],
      priority: "high",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 1,
    });
    const files = async () => (await client.projectFiles(project.id)).entries.map((e) => e.path);
    await allEnded();
    // Each of the stand-in's replies takes a while, so the run is still going after it wrote.
    bench.delayMs = 400;
    try {
      const agentId = (await client.agents())[0]?.id ?? "";
      await client.startSession({ agentId, projectId: project.id });
      await eventually(
        async () =>
          (await client.tasks(project.id)).find((t) => t.id === created.id)?.status ===
            "in_progress" && (await files()).includes("about.html"),
        "the run to write about.html",
        async () => (await files()).join(", "),
        20_000,
      );
      const row = (await client.tasks(project.id)).find((t) => t.id === created.id);
      const cancelled = await client.taskAction(created.id, {
        version: row?.version ?? 0,
        action: "cancel",
      });
      expect(cancelled.change?.sentence).toBe(
        'Cancelled "Write the About page in about.html": its run stopped and its changes are removed; Undo restores them unless the files changed.',
      );
      await allEnded();
    } finally {
      bench.delayMs = 0;
    }
    expect((await client.tasks(project.id)).find((t) => t.id === created.id)?.status).toBe(
      "cancelled",
    );
    expect(await files()).not.toContain("about.html");
    // Nothing reviewed the cancelled task.
    expect((await client.task(created.id)).runs.filter((r) => r.kind !== "work")).toEqual([]);
    const changeId = (await client.changes({ projectId: project.id })).find((c) =>
      c.sentence.startsWith('Cancelled "Write the About page'),
    )?.id;
    const undone = await client.undoChange(changeId ?? "");
    expect(undone.sentence).toBe(
      'Undone: reopened the task "Write the About page in about.html"; it is ready again. What it changed is back in the folder.',
    );
    expect(await files()).toContain("about.html");
  });

  it("Stop now while the critic reviews: the task is Ready again with its file and no review, and the next session reviews it (design §4.9, phase C review)", async () => {
    const project = await client.createProject({ name: "Contact club", goal: "A contact page" });
    const created = await client.createTask(project.id, {
      title: "Write the Contact page in contact.html",
      outcome: "contact.html says how to reach the club",
      acceptanceCriteria: ["contact.html exists"],
      priority: "high",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 1,
    });
    const row = async () => (await client.tasks(project.id)).find((t) => t.id === created.id);
    const files = async () => (await client.projectFiles(project.id)).entries.map((e) => e.path);
    await allEnded();
    // The stand-in critic takes its time, as the real model's review does.
    bench.criticDelayMs = 60_000;
    let sessionId = "";
    try {
      const agentId = (await client.agents())[0]?.id ?? "";
      sessionId = (await client.startSession({ agentId, projectId: project.id })).session?.id ?? "";
      await eventually(
        async () => (await row())?.display?.key === "review",
        "the critic to review the task",
        async () => `${(await row())?.display?.label}`,
        20_000,
      );
      // The session page's Stop now.
      await client.stopSession(sessionId);
      await allEnded();
    } finally {
      bench.criticDelayMs = 0;
    }
    const after = await row();
    expect(after?.status).toBe("ready");
    expect(after?.display?.label).toBe("Ready");
    // Stop now keeps what it wrote (ADR 0102); no review was recorded (the critic's run, when
    // it had begun, reads Stopped), no card waits.
    expect(await files()).toContain("contact.html");
    const stopped = await client.task(created.id);
    expect(stopped.review).toBeNull();
    expect(
      stopped.runs.filter((r) => r.kind !== "work").every((r) => r.outcome === "Stopped"),
    ).toBe(true);
    const me = await client.me();
    expect(
      (await client.inbox(me.id)).requests.filter(
        (r) => r.taskId === created.id && r.status === "open",
      ),
    ).toEqual([]);
    expect((await client.session(sessionId)).summary).toContain(
      '"Write the Contact page in contact.html" is ready to continue.',
    );
    expect((await client.startCheck(project.id)).runnable.map((t) => t.taskId)).toContain(
      created.id,
    );
    // The next Start runs it again, and the critic reviews it this time.
    await runSession(project.id);
    expect((await row())?.status).toBe("done");
    expect((await client.task(created.id)).review?.verdict).toBeTruthy();
  });

  it("a task in review whose card waits reads Needs your decision, and Cancel says only that it is cancelled (phase C review)", async () => {
    const project = await client.createProject({ name: "Review club", goal: "A contact page" });
    // Its review failed in a session that ended (U-045): in review, with its card; no review runs.
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the Contact page in contact.html",
      outcome: "contact.html says how to reach the club",
      acceptance_criteria: ["contact.html exists"],
      risk_tier: 1,
      status: "in_review",
      priority: 5,
      specialist: "coder",
      reason: "Wrote contact.html.",
    } as never);
    const me = await client.me();
    await fileReviewFailedRequest({
      store: rt.store,
      task,
      session: null,
      humanId: me.id,
      agentId: (await client.agents())[0]?.id ?? "",
      runId: null,
      error: "the critic's model did not answer",
    });
    const view = (await client.tasks(project.id)).find((t) => t.id === task.id);
    expect(view?.display).toMatchObject({
      key: "answer",
      label: "Needs your decision",
      blocker: { kind: "card", cardKind: "retry" },
    });
    const cancelled = await client.taskAction(task.id, {
      version: view?.version ?? 0,
      action: "cancel",
    });
    expect(cancelled.change?.sentence).toBe(
      'Cancelled "Write the Contact page in contact.html". Its card in the Inbox was withdrawn.',
    );
  });
});

describe("the UI client against the real daemon: a project linked to a repository (ADR 0106)", () => {
  // The GitHub walk (2026-11-01/02): an empty repository failed every task and the doc
  // scaffold; "N reviewed pull requests wait for you to merge" linked none of them; the
  // repository was shown nowhere; the Docs tab said "missing" for docs waiting in a PR.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let emptyBare = "";
  const host = new MemoryGitHost("alice");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-repo-"));
    emptyBare = join(home, "empty.git");
    await run(["git", "init", "--bare", "-b", "main", emptyBare]);
    await host.createRepo({ owner: "o", name: "empty", private: true, cloneUrl: emptyBare });
    const seededBare = join(home, "seeded.git");
    await run(["git", "init", "--bare", "-b", "main", seededBare]);
    const seed = new GitOps({
      cwd: join(home, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(seededBare);
    writeFileSync(join(home, "seed", "README.md"), "# seeded\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name: "seeded", private: true, cloneUrl: seededBare });
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    rt = await composeRuntime({
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
      gitHost: host,
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

  it("an empty repository gets the doc set as its first commit; the card names the repository, not a folder", async () => {
    const project = await client.createProject({
      name: "Fresh",
      goal: "A page in a new repository",
      repos: ["o/empty"],
    });
    const log = await run(["git", "--git-dir", emptyBare, "log", "--format=%s", "main"]);
    expect(log.stdout.trim()).toBe("docs: start the repository with the standard doc set");
    const card = await client.project(project.id);
    expect(card.repository).toEqual({ fullName: "o/empty", url: "https://github.com/o/empty" });
    expect(card.folder).toBeNull();
    const prs = await client.projectPullRequests(project.id);
    expect(prs).toEqual({
      repository: { fullName: "o/empty", url: "https://github.com/o/empty" },
      waiting: [],
      error: null,
      errorKind: null,
      // merge-in-app: who merges the project's accepted work, for the Overview's line.
      mode: { key: "you", label: "You press Merge" },
    });
    // The docs are on main: the Docs tab reads them as present.
    const docs = await client.docs(project.id);
    expect(docs.find((d) => d.path === "docs/overview.md")).toMatchObject({ exists: true });
  }, 60_000);

  it("the PRs that wait for the person: the done task's and the docs scaffold's, each with its link; the Docs tab names the PR a doc waits in", async () => {
    const project = await client.createProject({
      name: "Seeded",
      goal: "A page in a repository with a README",
      repos: ["o/seeded"],
    });
    // The creation-time scaffold opened PR #1 (the seeded README stays as it is).
    const docs = await client.docs(project.id);
    const overview = docs.find((d) => d.path === "docs/overview.md");
    expect(overview).toMatchObject({
      exists: false,
      note: "waiting in pull request #1: merge it to add it",
      pullRequest: { number: 1, url: "memory://o/seeded/pull/1" },
    });
    expect(docs.find((d) => d.path === "README.md")).toMatchObject({ exists: true });
    // A task the critic accepted, whose PR waits for the person's merge (level 2 never merges),
    // and one still in review, whose PR is not waiting for a merge yet.
    const done = await rt.store.task.insert({
      project_id: project.id,
      title: "Create the page skeleton in index.html",
      outcome: "index.html exists",
      acceptance_criteria: ["it opens"],
      risk_tier: 1,
      status: "done",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      branch: "fr/aaaa-create-the-page",
    });
    const reviewing = await rt.store.task.insert({
      project_id: project.id,
      title: "Style the page",
      outcome: "styles.css exists",
      acceptance_criteria: ["it is styled"],
      risk_tier: 1,
      status: "in_review",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
      branch: "fr/bbbb-style-the-page",
    });
    // The critic's accepting review of the done task (its reason is then the merge's "left
    // open" words, so the review row, not the reason, says it was reviewed).
    await rt.store.review.insert({
      task_id: done.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 90,
      confidence: 0.9,
      verdict: "accept",
      evidence: [],
      summary: "Looks right.",
      author_agent: rt.criticAgent.id,
    });
    await rt.store.task.patch(done.id, {
      reason: "PR left open for you: autonomy level 2 does not merge (level 3 Trusted does)",
    });
    // A task the person marked done from its card after the critic asked for changes: its PR
    // waits too, but no critic accepted it (review, 2026-11-02: it read "Reviewed by the
    // critic").
    const unreviewed = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the README",
      outcome: "README.md says how to open the page",
      acceptance_criteria: ["it says how"],
      risk_tier: 1,
      status: "done",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "accepted without review: you marked it done in the Inbox",
      branch: "fr/cccc-write-the-readme",
    });
    await rt.store.review.insert({
      task_id: unreviewed.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 40,
      confidence: 0.9,
      verdict: "revise",
      evidence: [],
      summary: "The README does not say how to open the page.",
      author_agent: rt.criticAgent.id,
    });
    const repo = { owner: "o", name: "seeded" };
    const pr = await host.createPullRequest(repo, {
      title: done.title,
      body: "work",
      head: "fr/aaaa-create-the-page",
      base: "main",
    });
    await rt.store.task.patch(done.id, { pr_url: pr.htmlUrl });
    await host.createPullRequest(repo, {
      title: reviewing.title,
      body: "work",
      head: "fr/bbbb-style-the-page",
      base: "main",
    });
    const readmePr = await host.createPullRequest(repo, {
      title: unreviewed.title,
      body: "work",
      head: "fr/cccc-write-the-readme",
      base: "main",
    });
    // A task whose work the person accepted at sign-off: their own review.
    const signedOff = await rt.store.task.insert({
      project_id: project.id,
      title: "Add the deploy script",
      outcome: "deploy.sh publishes the page",
      acceptance_criteria: ["it publishes"],
      risk_tier: 3,
      status: "done",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "you accepted the work at sign-off",
      branch: "fr/dddd-add-the-deploy-script",
    });
    const deployPr = await host.createPullRequest(repo, {
      title: signedOff.title,
      body: "work",
      head: "fr/dddd-add-the-deploy-script",
      base: "main",
    });
    const view = await client.projectPullRequests(project.id);
    expect(view.error).toBeNull();
    expect(view.repository?.fullName).toBe("o/seeded");
    expect(view.waiting).toEqual([
      {
        kind: "docs",
        taskId: null,
        title: "The project's standard docs",
        number: 1,
        url: "memory://o/seeded/pull/1",
        branch: "fr/docs-scaffold",
        review: null,
        // merge-in-app: what the Overview's Merge does for it.
        merge: { state: "ready", canMerge: true, sentence: null, first: [] },
      },
      {
        kind: "task",
        taskId: done.id,
        title: "Create the page skeleton in index.html",
        number: pr.number,
        url: pr.htmlUrl,
        branch: "fr/aaaa-create-the-page",
        review: "critic",
        // merge-in-app: what the Overview's Merge does for it.
        merge: { state: "ready", canMerge: true, sentence: null, first: [] },
      },
      {
        kind: "task",
        taskId: unreviewed.id,
        title: "Write the README",
        number: readmePr.number,
        url: readmePr.htmlUrl,
        branch: "fr/cccc-write-the-readme",
        review: "none",
        // merge-in-app: what the Overview's Merge does for it.
        merge: { state: "ready", canMerge: true, sentence: null, first: [] },
      },
      {
        kind: "task",
        taskId: signedOff.id,
        title: "Add the deploy script",
        number: deployPr.number,
        url: deployPr.htmlUrl,
        branch: "fr/dddd-add-the-deploy-script",
        review: "you",
        // merge-in-app: what the Overview's Merge does for it.
        merge: { state: "ready", canMerge: true, sentence: null, first: [] },
      },
    ]);
    // Merged on GitHub: gone at once, since the list is read from the host when asked.
    await host.mergePullRequest(repo, pr.number);
    expect((await client.projectPullRequests(project.id)).waiting.map((w) => w.review)).toEqual([
      null,
      "none",
      "you",
    ]);
  }, 60_000);
});

describe("the UI client against the real daemon: research on an API key reads the web (ADR 0107)", () => {
  // Live (2026-11-02, phase D): on an API key the researcher was refused at once ("Paused",
  // "needs your decision" with no card in the Inbox) and nothing ran. The bench's stand-in runs
  // on the loop driver as an API key does; its researcher reads the pages a brief names through
  // `web_fetch` and writes from them.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let criticCalls: ModelRequest[];
  let server: Server;
  let pageUrl = "";
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>Static site generators compared</title></head><body><main>" +
          "<h1>Static site generators compared</h1>" +
          "<p>Hugo builds a 10,000-page site in about 2 seconds.</p>" +
          "<p>Eleventy needs Node.js 18 or newer.</p></main></body></html>",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ssg.html`;
    ({ rt, client, criticCalls } = await composeWithRolePlayer({}));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("a researcher task fetches the page, writes docs/research.md citing it, and the critic is shown the page", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Docs site", goal: "Pick a generator" });
    // The fixture runs on this computer: the daemon reads it through the bench's loopback seam
    // (`webReadLoopback`, as `--provider bench` composes it); no list opens this computer.
    const task = await client.createTask(project.id, {
      title: "Compare two static site generators",
      outcome: `docs/research.md says how fast Hugo builds and which Node.js Eleventy needs, citing ${pageUrl}`,
      riskTier: 1,
      specialist: "researcher",
    });
    // A page the network rules refuse: a private address the project does not name.
    const refused = await client.createTask(project.id, {
      title: "Read the router's admin page",
      outcome: "docs/router.md says what http://10.0.0.7/admin shows",
      riskTier: 1,
      specialist: "researcher",
    });
    const states = async () =>
      (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, await states()).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      states,
      60_000,
    );
    // The researcher ran (no refusal, no hand-over to the person) and the critic reviewed it.
    const done = await client.task(task.id);
    expect(done.task.status, await states()).toBe("done");
    expect(done.runs.map((r) => [r.kind, r.specialist])).toEqual([
      ["review", "critic"],
      ["work", "researcher"],
    ]);
    expect(hits).toContain("GET /ssg.html");
    // The person opens the file on the Files tab: it cites the page and quotes it.
    const file = await client.projectFile(project.id, "docs/research.md");
    expect(file.content).toContain(pageUrl);
    expect(file.content).toContain("Hugo builds a 10,000-page site in about 2 seconds.");
    // The session's log names the page it read, in one short line.
    const lines = (await client.sessionEvents(sessionId)).map((e) => e.text);
    expect(lines).toContain(`read the web page ${new URL(pageUrl).host}/ssg.html`);
    expect(lines).toContain("read the web page 10.0.0.7/admin (failed)");
    // The critic was shown the page the researcher read, as data, beside the report.
    const shown = criticCalls.map((c) => JSON.stringify(c.messages)).join("\n");
    expect(shown).toContain(`### web page ${pageUrl}`);
    expect(shown).toContain("Eleventy needs Node.js 18 or newer.");
    // The refused page: the researcher was told why in words and wrote that it was not read.
    const router = await client.projectFile(project.id, "docs/router.md");
    expect(router.content).toContain(
      "http://10.0.0.7/admin was not read: Refused: 10.0.0.7 is a private or local network address",
    );
    expect(shown).toContain("web page not read: http://10.0.0.7/admin (");
    expect((await client.task(refused.id)).task.status, await states()).toBe("done");
    expect(hits.every((h) => h === "GET /ssg.html")).toBe(true);
    // This install reads the web: Settings' specialists list says nothing is missing.
    const models = await client.modelSettings();
    expect(models.specialists.find((x) => x.name === "researcher")?.limitation).toBeNull();
  }, 120_000);

  it("'Web pages research may read' ('sites'): PUT's old block list becomes the one never list, settings.set changes the next page read, and the Overview carries the line", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Rules", goal: "Read only one site" });
    const rowOf = async () =>
      (await client.settings({ scope: "project", scopeId: project.id })).find(
        (s) => s.key === "project.web_access" && s.scopeId === project.id,
      );
    // The default: any public website, on the row and on the Overview's line.
    expect((await rowOf())?.value).toEqual({ mode: "any", only: [], never: [] });
    expect((await rowOf())?.label).toBe("Web pages research may read");
    expect((await client.project(project.id)).researchReads).toBe(
      "Research reads: any public website",
    );
    // A block written the old way (PUT /projects/:id/settings, browser.blockedDomains) is taken
    // into the one never list in the same write, with an audit row: enforced and shown.
    const row = await rt.store.project.mustGet(project.id);
    const put = await client.updateProjectSettings(project.id, {
      version: row.version,
      settings: { browser: { blockedDomains: ["*.example.org", "https://www.facebook.com/x"] } },
    });
    expect(put.settings).toMatchObject({
      web_access: { mode: "any", only: [], never: ["example.org", "facebook.com"] },
    });
    expect(put.settings.browser).toBeUndefined();
    expect((await rowOf())?.value).toEqual({
      mode: "any",
      only: [],
      never: ["example.org", "facebook.com"],
    });
    const moved = await rt.store.auditLog.list({ tool: "project.settings" } as never);
    expect(moved.map((r) => r.result_summary)).toEqual([
      "browser.blockedDomains taken into web_access.never: example.org, facebook.com",
    ]);
    // The rule itself is not written through that route: it skips the yes a widening needs.
    const sneak = await rt.store.project.mustGet(project.id);
    await expect(
      client.updateProjectSettings(project.id, {
        version: sneak.version,
        settings: { web_access: { mode: "any", only: [], never: [] } },
      }),
    ).rejects.toMatchObject({ status: 403 });
    // "Only these websites" through settings.set (the Settings row's command): a narrowing,
    // done at once.
    const set = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: {
            key: "web_access",
            value: { mode: "only", only: ["https://example.com/docs"], never: ["example.org"] },
            project: project.id,
          },
        },
      ],
      wordsUsed: "Settings: Web pages research may read to only example.com",
      source: "ui",
      projectId: project.id,
    });
    expect(set.status).toBe("done");
    expect((await rowOf())?.value).toEqual({
      mode: "only",
      only: ["example.com"],
      never: ["example.org"],
    });
    expect((await client.project(project.id)).researchReads).toBe(
      "Research reads: only example.com",
    );
    // Back to any public website is a widening: a yes first.
    const widen = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: {
            key: "web_access",
            value: { mode: "any", only: [], never: [] },
            project: project.id,
          },
        },
      ],
      wordsUsed: "Settings: Web pages research may read to Any public website",
      source: "ui",
      projectId: project.id,
    });
    expect(widen.status).toBe("pending");
    if (widen.pendingId) await client.confirmCommand(widen.pendingId, { answer: "no" });
    // The next page read follows the rule: the stand-in page is not on the "only" list, and the
    // words the researcher got (and wrote) name the rule.
    hits.length = 0;
    const task = await client.createTask(project.id, {
      title: "Compare two static site generators",
      outcome: `docs/research.md says how fast Hugo builds, citing ${pageUrl}`,
      riskTier: 1,
      specialist: "researcher",
    });
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(project.id)).map((t) => t.status).join(", "),
      60_000,
    );
    expect(hits).toEqual([]);
    const file = await client.projectFile(project.id, "docs/research.md");
    expect(file.content).toContain(
      `${pageUrl} was not read: Refused: 127.0.0.1 is not on this project's "only these websites" list (example.com).`,
    );
    const drawer = await client.task(task.id);
    expect(JSON.stringify(drawer.runs)).toContain("only these websites");
  }, 120_000);

  it("an install without web access says so for the researcher, and its task still runs from the project's files", async () => {
    // The page reader turned off and no subscription: no specialist reads the web.
    const off = await composeWithRolePlayer({}, {}, { FORERUNNER_WEB_FETCH: "off" });
    try {
      const models = await off.client.modelSettings();
      const limits = Object.fromEntries(models.specialists.map((x) => [x.name, x.limitation]));
      expect(limits.researcher).toBe("Cannot read the web on this computer");
      expect(limits["science-evaluator"]).toBe("Cannot read the web on this computer");
      expect(limits.coder).toBeNull();
      const agentId = (await off.client.agents())[0]?.id ?? "";
      const project = await off.client.createProject({ name: "Notes", goal: "Summaries" });
      const task = await off.client.createTask(project.id, {
        title: "Summarise the notes",
        outcome: `docs/summary.md says what ${pageUrl} and the notes say`,
        riskTier: 1,
        specialist: "researcher",
      });
      const started = await off.client.startSession({ agentId, projectId: project.id });
      const sessionId = started.session?.id ?? "";
      await eventually(
        async () => (await off.client.session(sessionId)).status !== "running",
        "the session to end",
        async () => (await off.client.tasks(project.id)).map((t) => t.status).join(", "),
        60_000,
      );
      // Never handed to the person for a missing tool: the researcher ran and was reviewed.
      const done = await off.client.task(task.id);
      expect(done.task.status).toBe("done");
      expect(done.runs.map((r) => [r.kind, r.specialist])).toEqual([
        ["review", "critic"],
        ["work", "researcher"],
      ]);
      expect((await off.client.projectFile(project.id, "docs/summary.md")).content).toBeTruthy();
      expect(hits.filter((h) => h !== "GET /ssg.html")).toEqual([]);
    } finally {
      await off.rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: answers do what the person said (phase E, answers)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let chatCalls: ModelRequest[];
  let bench: BenchOptions;

  beforeAll(async () => {
    ({ rt, client, chatCalls, bench } = await composeWithRolePlayer({
      FORERUNNER_BENCH_PERSON: "1",
    }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /**
   * The reference the chat's model has for a card, from what its last call was given (the
   * `open_requests` line: "<reference>: [<project>] <the card in words>").
   */
  const referenceIn = (projectName: string): string => {
    const told = JSON.stringify(chatCalls.at(-1)?.messages ?? []);
    const found = new RegExp(`([0-9a-f-]{8,36}): \\[${projectName}[\\],]`).exec(told);
    if (!found?.[1])
      throw new Error(
        `no reference for ${projectName} in the chat's context: ${told.slice(0, 1500)}`,
      );
    return found[1];
  };

  /** A project planned from a brief, its plan card open in the Inbox. */
  const planned = async (name: string) => {
    const project = await client.createProject({
      name,
      goal: "A page for the bakery",
      brief: "A one-page website for a small bakery with its opening hours.",
      intake: true,
    });
    await rt.intake.inFlight(project.id);
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    const open = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    const [card] = await open();
    if (!card) throw new Error("no plan card");
    const say = (text: string) =>
      client.chat({
        humanId: me.id,
        agentId,
        projectId: project.id,
        projectTab: true,
        text,
        source: "text",
      });
    return { project, card, me, open, say };
  };

  it('"go ahead" on the person\'s own card is refused in words, typed or from the chat; the card and the task wait', async () => {
    const { project, card, open, say } = await planned("Bakery hours");
    await client.answerRequest(card.id, { version: card.version, answer: "Approve and start" });
    let asked: Awaited<ReturnType<typeof open>>[number] | undefined;
    await eventually(
      async () => {
        asked = (await open()).find((r) => r.reply === "form" && !!r.taskId);
        return !!asked;
      },
      "the person task's card",
      async () => (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", "),
      30_000,
    );
    if (!asked) throw new Error("no person card");
    // What the Inbox offers on it: the form and Cancel task.
    expect(asked.choices?.map((c) => c.label)).toEqual(["Cancel task"]);
    // The phone and the web approvals send the person's typed words as the answer.
    const refused = await client
      .answerRequest(asked.id, { version: asked.version, answer: "go ahead" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).message).toBe(
      "This card needs your answers: type them, or Cancel task.",
    );
    // The chat's request_answer gets the same refusal, and says it.
    const reply = await say(
      `tool: request_answer {"request": "${asked.id}", "answer": "go ahead"}`,
    );
    expect(reply.reply).toContain("This card needs your answers: type them, or Cancel task.");
    expect(reply.pendingConfirmation ?? null).toBeNull();
    const still = (await open()).find((r) => r.id === asked?.id);
    expect(still?.status).toBe("open");
    const task = (await client.tasks(project.id)).find((t) => t.id === asked?.taskId);
    expect(task?.status).toBe("needs_human");
    expect(task?.display?.label).toMatch(/^Needs your answer/);
  }, 60_000);

  it("the plan card answered from the chat: its read-back is the chat's, the Inbox keeps one card, and Yes approves the plan from that card", async () => {
    const { project, card, me, open, say } = await planned("Bakery chat");
    const before = (await client.inbox(me.id)).needsYouCount;
    // The chat's reference to the card, as its model has it: unique among the open cards,
    // although the person card of the case before was filed within the same minute.
    await say("what is waiting for me?");
    const ref = referenceIn("Bakery chat");
    expect(card.id.startsWith(ref)).toBe(true);
    const header = async () => {
      const shown = await client.project(project.id);
      return { statusLine: shown.statusLine, waitingOnYou: shown.waitingOnYou };
    };
    const headerBefore = await header();
    const asked = await say(
      `tool: request_answer {"request": "${ref}", "answer": "Approve and start"}`,
    );
    const written = card.choices?.[0]?.explain ?? "";
    expect(asked.pendingConfirmation?.readback).toBe(
      `Approve and start (${card.title})? ${written}`,
    );
    // The model is told the same words, with no id it could repeat to the person.
    const told = JSON.stringify(chatCalls.at(-1)?.messages ?? []);
    expect(told).toContain("Needs confirmation. The person is asked: Approve and start (");
    expect(told).not.toContain(asked.pendingConfirmation?.id ?? "no id");
    // One card about the plan: the read-back is not filed as a second card beside it.
    expect((await open()).map((r) => r.id)).toEqual([card.id]);
    expect((await client.inbox(me.id)).needsYouCount).toBe(before);
    // The header's sentence and count are the Inbox's: still the one plan card.
    expect(await header()).toEqual(headerBefore);
    const yes = await say("yes");
    const tasks = await client.tasks(project.id);
    expect(tasks.length).toBeGreaterThan(0);
    // The card's Done line (a session of the case before still runs, so the start waits for it).
    expect(yes.reply).toMatch(new RegExp(`^Plan approved: ${tasks.length} tasks written; `));
    const inbox = await client.inbox(me.id);
    const answered = inbox.requests.filter(
      (r) => r.projectId === project.id && r.status !== "open",
    );
    // The Answered list holds the plan card with its Done line, and nothing about the read-back.
    expect(answered.map((r) => r.id)).toEqual([card.id]);
    expect(answered[0]?.outcome).toBe(yes.reply);
  }, 60_000);

  it("a failed task's card answered Try again from the chat: one card, and Yes tries the task again", async () => {
    const project = await client.createProject({ name: "Review club", goal: "A contact page" });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the Contact page in contact.html",
      outcome: "contact.html says how to reach the club",
      acceptance_criteria: ["contact.html exists"],
      risk_tier: 1,
      status: "in_review",
      priority: 5,
      specialist: "coder",
      reason: "Wrote contact.html.",
    } as never);
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    await fileReviewFailedRequest({
      store: rt.store,
      task,
      session: null,
      humanId: me.id,
      agentId,
      runId: null,
      error: "the critic's model did not answer",
    });
    const open = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    const [card] = await open();
    if (!card) throw new Error("no card");
    const option = card.choices?.find((c) => c.label === "Try again");
    expect(option).toBeDefined();
    const say = (text: string) =>
      client.chat({
        humanId: me.id,
        agentId,
        projectId: project.id,
        projectTab: true,
        text,
        source: "text",
      });
    await say("what is waiting for me?");
    // What Home and the project's header say before the chat answers the card.
    const shown = async () => {
      const card = await client.project(project.id);
      const onHome = (await client.projects()).find((p) => p.id === project.id);
      return {
        statusLine: card.statusLine,
        waitingOnYou: card.waitingOnYou,
        health: card.health,
        needsYou: card.needsYou ?? null,
        home: onHome
          ? {
              statusLine: onHome.statusLine,
              waitingOnYou: onHome.waitingOnYou,
              health: onHome.health,
            }
          : null,
      };
    };
    const before = await shown();
    expect(before.statusLine?.text).toBe(`Waiting for you: "${task.title}"`);
    expect(before.waitingOnYou).toBe(1);
    const told: { kind: string; title: string }[] = [];
    const onNotification = (n: { kind: string; title: string }) => told.push(n);
    rt.events.on("notification", onNotification);
    const asked = await say(
      `tool: request_answer {"request": "${referenceIn("Review club")}", "answer": "Try again"}`,
    );
    expect(asked.pendingConfirmation?.readback).toBe(
      `Try again (${card.title})? ${option?.explain ?? ""}`.trim(),
    );
    expect((await open()).map((r) => r.id)).toEqual([card.id]);
    // The read-back is the chat's: Home and the header still say the one card, not "2
    // questions", and no notification points to an Inbox card the Inbox does not show.
    expect(await shown()).toEqual(before);
    await new Promise((r) => setTimeout(r, 50));
    rt.events.off("notification", onNotification);
    expect(told.filter((n) => n.kind === "request_opened")).toEqual([]);
    await say("yes");
    expect((await rt.store.humanRequest.mustGet(card.id)).status).toBe("answered");
    expect((await open()).map((r) => r.id)).toEqual([]);
    expect(["ready", "claimed", "in_progress", "in_review", "done"]).toContain(
      (await rt.store.task.mustGet(task.id)).status,
    );
  }, 60_000);

  it("a deploy or a migration is stored at the full review however it is made: New task, chat, an edit (phase C leftover C-2)", async () => {
    const project = await client.createProject({ name: "Shop deploy", goal: "The shop online" });
    // New task as the dialog sends it: no level picked, so the daemon applies the project's.
    const deploy = await client.createTask(project.id, {
      title: "Deploy the shop to the host",
      outcome: "The shop answers on its domain",
      specialist: "ops-deploy",
    });
    expect(deploy.riskTier).toBe(2);
    // A light review asked for explicitly is raised too: the owner's decision 4.
    const migrate = await client.createTask(project.id, {
      title: "Move the orders to the new schema",
      outcome: "Every order is in the new table",
      specialist: "migration-specialist",
      riskTier: 1,
    });
    expect(migrate.riskTier).toBe(2);
    // An edit that hands a light task to the deploy specialist raises it.
    const plain = await client.createTask(project.id, {
      title: "Write the deploy notes",
      outcome: "docs/deploy.md",
      specialist: "writer-marketing",
    });
    expect(plain.riskTier).toBe(1);
    const edited = await client.updateTask(plain.id, {
      version: plain.version,
      specialist: "ops-deploy",
    });
    expect((await rt.store.task.mustGet(plain.id)).risk_tier).toBe(2);
    expect(edited.riskTier).toBe(2);
    // The chat's task.create: the same floor.
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    await client.chat({
      humanId: me.id,
      agentId,
      projectId: project.id,
      projectTab: true,
      text: 'tool: task_create {"title": "Deploy the docs site", "outcome": "docs online", "specialist": "ops-deploy"}',
      source: "text",
    });
    const rows = await client.tasks(project.id);
    const viaChat = rows.find((t) => t.title === "Deploy the docs site");
    expect(viaChat?.riskTier).toBe(2);
    for (const t of rows.filter((r) => r.specialist === "ops-deploy"))
      expect(t.riskTier, t.title).toBe(2);
  }, 60_000);

  it("a coder's task the retry ladder retries stays the coder's at the level it is stored and run at: never a migration's full review and sign-off on the host (phase E review, C-2)", async () => {
    const project = await client.createProject({ name: "Notes ladder", goal: "A notes CLI" });
    const task = await client.createTask(project.id, {
      title: "Build the notes CLI in src/notes.js",
      outcome: "node src/notes.js add and list notes",
      specialist: "coder",
      riskTier: 1,
    });
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    // Nothing of the cases before may still run: this start must begin at once.
    await eventually(
      async () => (await client.sessions({})).every((s) => s.status !== "running"),
      "the sessions of the cases before to end",
      async () => (await client.sessions({})).map((s) => s.status).join(", "),
      30_000,
    );
    bench.fail = ["Build the notes CLI"];
    try {
      const started = await client.startSession({ agentId, projectId: project.id });
      await eventually(
        async () =>
          (await client.session(started.session?.id ?? "")).status !== "running" &&
          (await client.task(task.id)).task.status !== "in_progress",
        "the session to run the task's attempts and end",
        async () => `${(await client.task(task.id)).task.status}`,
        60_000,
      );
    } finally {
      bench.fail = [];
    }
    const detail = await client.task(task.id);
    const work = detail.runs.filter((r) => r.kind === "work");
    // Every attempt (the ladder ran past its second rung) was the coder's.
    expect(work.length, JSON.stringify(work)).toBeGreaterThanOrEqual(3);
    expect(new Set(work.map((r) => r.specialist))).toEqual(new Set(["coder"]));
    // At the store and on the row: the coder's task at the light review it was created at.
    const stored = await rt.store.task.mustGet(task.id);
    expect(stored.specialist).toBe("coder");
    expect(stored.risk_tier).toBe(1);
    const row = (await client.tasks(project.id)).find((t) => t.id === task.id);
    expect(row?.specialist).toBe("coder");
    expect(reviewLevelName(reviewLevelValue(row?.riskTier ?? 0, row?.specialist))).toBe(
      "Light review",
    );
    // One card after the retries, about the task (me: the Inbox's own list).
    const openCards = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    const cards = await openCards();
    expect(cards.map((c) => c.taskId)).toEqual([task.id]);
    const card = cards[0];
    if (!card) throw new Error("no card");
    const before = (await client.inbox(me.id)).needsYouCount;
    // "Try X again" in the chat about that task is an answer to its card, not a second card
    // beside it (phase E review: it read back 'Resume "…"?' and filed a Resume card).
    const said = await client.chat({
      humanId: me.id,
      agentId,
      projectId: project.id,
      projectTab: true,
      text: 'try the task "Build the notes CLI in src/notes.js" again',
      source: "text",
    });
    expect((await openCards()).map((c) => c.id)).toEqual([card.id]);
    expect((await client.inbox(me.id)).needsYouCount).toBe(before);
    // The card after the ladder's last rung carries the critic's high findings: it needs this
    // computer's OK, so the reply points to it, and nothing else is filed.
    expect((await rt.store.humanRequest.mustGet(card.id)).risk).toBe("high");
    expect(said.pendingConfirmation ?? null).toBeNull();
    expect(said.reply).toBe(
      `Answer it on its card in the Inbox: ${card.title}. Nothing else was filed.`,
    );
    expect(card.title).toBe('"Build the notes CLI in src/notes.js" failed 4 times');
    expect((await rt.store.humanRequest.mustGet(card.id)).status).toBe("open");
    expect((await rt.store.task.mustGet(task.id)).status).toBe("needs_human");
  }, 90_000);

  it('"try X again" in the chat on a task whose failed card is open answers that card, read back in its words; Yes is its Try again (phase E review)', async () => {
    const project = await client.createProject({ name: "Quote retry", goal: "A quote page" });
    const task = await client.createTask(project.id, {
      title: "Write the quote page in quote.html",
      outcome: "quote.html shows a quote",
      specialist: "coder",
      riskTier: 1,
    });
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    await eventually(
      async () => (await client.sessions({})).every((s) => s.status !== "running"),
      "the sessions of the cases before to end",
      async () => (await client.sessions({})).map((s) => s.status).join(", "),
      30_000,
    );
    // The run errors (the model call fails): the session files the failed-task card.
    bench.fail = ["Write the quote page"];
    bench.failMode = "error";
    const openCards = async () =>
      (await client.inbox(me.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    try {
      await client.startSession({ agentId, projectId: project.id });
      await eventually(
        async () => (await openCards()).length > 0,
        "the failed task's card",
        async () => `${(await client.task(task.id)).task.status}`,
        60_000,
      );
      await eventually(
        async () => (await client.sessions({})).every((s) => s.status !== "running"),
        "the session to end",
        async () => (await client.sessions({})).map((s) => s.status).join(", "),
        30_000,
      );
    } finally {
      bench.fail = [];
      bench.failMode = "report";
    }
    const cards = await openCards();
    expect(cards.map((c) => c.taskId)).toEqual([task.id]);
    const card = cards[0];
    if (!card) throw new Error("no card");
    expect((await rt.store.humanRequest.mustGet(card.id)).risk).toBe("medium");
    const tryAgain = card.choices?.find((c) => c.label === "Try again");
    expect(tryAgain).toBeDefined();
    const before = await client.project(project.id);
    const say = (text: string) =>
      client.chat({
        humanId: me.id,
        agentId,
        projectId: project.id,
        projectTab: true,
        text,
        source: "text",
      });
    const asked = await say('try the task "Write the quote page in quote.html" again');
    expect(asked.pendingConfirmation?.readback).toBe(
      `Try again (${card.title})? ${tryAgain?.explain ?? ""}`.trim(),
    );
    // One card about the task; Home and the header say the same as before.
    expect((await openCards()).map((c) => c.id)).toEqual([card.id]);
    const after = await client.project(project.id);
    expect({ statusLine: after.statusLine, waitingOnYou: after.waitingOnYou }).toEqual({
      statusLine: before.statusLine,
      waitingOnYou: before.waitingOnYou,
    });
    const yes = await say("yes");
    // The card's own Try again: its Done line, and the card is answered with its option.
    expect(yes.reply).toMatch(
      /^Trying "Write the quote page in quote\.html" again: (a session started|it runs after the current session)\.$/,
    );
    const answered = await rt.store.humanRequest.mustGet(card.id);
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("Try again");
    expect((await openCards()).map((c) => c.id)).toEqual([]);
    await eventually(
      async () => (await client.sessions({})).every((s) => s.status !== "running"),
      "the session the answer started to end",
      async () => (await client.sessions({})).map((s) => s.status).join(", "),
      30_000,
    );
  }, 120_000);

  it("'start a session' in the chat waits for the run and links the session it started", async () => {
    const project = await client.createProject({ name: "Quote chat", goal: "A quote page" });
    await client.createTask(project.id, {
      title: "Write the quote page in index.html",
      outcome: "index.html shows a quote",
      specialist: "coder",
    });
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    // Nothing of the cases before may still run: this start must begin at once.
    await eventually(
      async () => (await client.sessions({})).every((s) => s.status !== "running"),
      "the sessions of the cases before to end",
      async () => (await client.sessions({})).map((s) => s.status).join(", "),
      30_000,
    );
    const say = (text: string) =>
      client.chat({
        humanId: me.id,
        agentId,
        projectId: project.id,
        projectTab: true,
        text,
        source: "text",
      });
    const asked = await say("start a session");
    expect(asked.pendingConfirmation?.readback).toMatch(/^Start a session on Quote chat/);
    const yes = await say("yes");
    expect(yes.reply).toMatch(/^Started a session on Quote chat/);
    const started = (await client.sessions({ projectId: project.id }))[0];
    expect(started).toBeDefined();
    // The turn links the session it started.
    const seen = await client.conversation(project.id);
    const action = seen.turns.at(-1)?.reply?.actions[0];
    expect(action?.kind).toBe("session.start");
    expect(action?.sessionId).toBe(started?.id);
    await eventually(
      async () => (await client.session(started?.id ?? "")).status !== "running",
      "the started session to end",
      async () => (await client.session(started?.id ?? "")).status,
      30_000,
    );
  }, 90_000);

  it("a Settings confirmation says in the Answered list what came of it: the change made, or nothing changed (phase C leftover C-29)", async () => {
    const me = await client.me();
    // As Settings sends a raise of the monthly cap: it waits for this computer's OK.
    const raise = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 900 } }],
      source: "ui",
    });
    expect(raise.status).toBe("pending");
    const lower = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 950 } }],
      source: "ui",
    });
    expect(lower.status).toBe("pending");
    const confirmed = await client.confirmCommand(raise.pendingId ?? "", { answer: "device" });
    expect(confirmed.status).toBe("done");
    await client.cancelCommand(lower.pendingId ?? "");
    const answered = (await client.inbox(me.id)).requests.filter(
      (r) => r.id === raise.pendingId || r.id === lower.pendingId,
    );
    const byId = new Map(answered.map((r) => [r.id, r.outcome]));
    expect(byId.get(raise.pendingId ?? "")).toBe(confirmed.sentence);
    expect(byId.get(raise.pendingId ?? "")).toMatch(/monthly cap .*CHF 900/);
    expect(byId.get(lower.pendingId ?? "")).toBe("You said no; nothing changed.");
  }, 60_000);
});

describe("the UI client against the real daemon: screens that lead somewhere (phase E, screens)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let bench: BenchOptions;
  let criticCalls: ModelRequest[];
  let server: Server;
  let pageUrl = "";

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>Quotes people like</title></head><body><main>" +
          "<p>Most people keep a favourite quote.</p></main></body></html>",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/quotes.html`;
    ({ rt, client, bench, criticCalls } = await composeWithRolePlayer({}));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  /** A session on the project, waited for until it ends (60 s: Windows CI is slow). */
  async function runSession(projectId: string): Promise<string> {
    const agentId = (await client.agents())[0]?.id ?? "";
    const states = async () =>
      (await client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", ");
    const started = await client.startSession({ agentId, projectId });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, await states()).not.toBe("");
    await eventually(
      async () =>
        !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
      "the session to end",
      states,
      60_000,
    );
    return sessionId;
  }

  it("GET /tasks/:id: each run names its session, its files open on the Files tab, its step lines are in that session's log, a research run names the pages it read (later #46, C-72)", async () => {
    const project = await client.createProject({ name: "Drawer links", goal: "Open what ran" });
    const page = await client.createTask(project.id, {
      title: "Build the quote page in index.html",
      outcome: "index.html shows a quote",
      riskTier: 1,
      specialist: "coder",
    });
    const research = await client.createTask(project.id, {
      title: "Find what quotes people like",
      outcome: `docs/research.md says what ${pageUrl} and http://10.0.0.7/admin say`,
      riskTier: 1,
      specialist: "researcher",
    });
    const sessionId = await runSession(project.id);

    const done = await client.task(page.id);
    const work = done.runs.find((r) => r.kind === "work");
    expect(work?.sessionId).toBe(sessionId);
    expect(work?.files.length).toBeGreaterThan(0);
    // Each file the drawer links opens through the Files tab's route, as the link sends it.
    for (const f of work?.files ?? []) {
      expect((await client.projectFile(project.id, f)).path).toBe(f);
    }
    // While it ran, the drawer showed the run's step lines from that session's log: the log up
    // to the task's end has them for this task.
    const log = await client.sessionEvents(sessionId);
    const end = log.findIndex(
      (e) => e.type === "task.finished" && (e.payload as { taskId?: string }).taskId === page.id,
    );
    expect(end).toBeGreaterThan(0);
    const live = taskStepsFromLog(log.slice(0, end), page.id);
    expect(live?.length, JSON.stringify(log.map((e) => e.type))).toBeGreaterThan(0);
    expect(taskStepsFromLog(log, page.id)).toBeNull();

    // The research run lists the page it read and the one the network rules refused.
    const read = (await client.task(research.id)).runs.find((r) => r.kind === "work");
    expect(read?.webSources).toEqual([
      expect.objectContaining({ url: pageUrl, title: "Quotes people like", refused: null }),
      expect.objectContaining({
        url: "http://10.0.0.7/admin",
        refused: expect.stringMatching(/private or local network address/),
      }),
    ]);
  }, 120_000);

  it("GET /tasks/:id: a review stopped by Stop now says so and who stopped it (C-41)", async () => {
    const project = await client.createProject({ name: "Review stopped", goal: "Say why" });
    const task = await client.createTask(project.id, {
      title: "Write notes/todo.md",
      outcome: "notes/todo.md lists three things",
      riskTier: 1,
      specialist: "coder",
    });
    const agentId = (await client.agents())[0]?.id ?? "";
    // The critic takes a minute to answer: the review is in flight when the person stops.
    bench.criticDelayMs = 60_000;
    try {
      const started = await client.startSession({ agentId, projectId: project.id });
      const sessionId = started.session?.id ?? "";
      const status = async () =>
        (await client.tasks(project.id)).find((t) => t.id === task.id)?.status;
      const asked = criticCalls.length;
      await eventually(
        async () => (await status()) === "in_review" && criticCalls.length > asked,
        "the critic's call to begin",
        async () => `task ${await status()}, ${criticCalls.length - asked} critic call(s)`,
        30_000,
      );
      await client.stopSession(sessionId, "stopped from the live view");
      await eventually(
        async () => !["running", "paused"].includes((await client.session(sessionId)).status),
        "the session to end",
        async () => `session ${(await client.session(sessionId)).status}`,
        30_000,
      );
    } finally {
      bench.criticDelayMs = 0;
    }
    const runs = (await client.task(task.id)).runs;
    const review = runs.find((r) => r.kind === "review");
    expect(review, JSON.stringify(runs)).toMatchObject({
      outcome: "Review stopped",
      report: "The review stopped before the critic decided: you stopped the session.",
    });
  }, 120_000);

  it("GET /changes: a session start whose session ended is not undoable and says why, before anyone tries (later #36)", async () => {
    const project = await client.createProject({ name: "Start undo", goal: "Say why" });
    await client.createTask(project.id, {
      title: "Write notes/plan.md",
      outcome: "notes/plan.md exists",
      riskTier: 1,
      specialist: "coder",
    });
    // The chat's start (the change log's session.start), with the words a person typed.
    const asked = await client.executeCommands({
      commands: [{ name: "session.start", params: { project: project.id, budgetChf: 5 } }],
      wordsUsed: "start a session on Start undo",
      source: "text",
      projectId: project.id,
    });
    // A start above CHF 1.60 asks for a yes first, as the chat's read-back does.
    const started =
      asked.status === "pending" && asked.pendingId
        ? await client.confirmCommand(asked.pendingId, { answer: "tap" })
        : asked;
    expect(started.status, JSON.stringify(started)).toBe("done");
    const row = async () =>
      (await client.changes({ projectId: project.id })).find((c) => c.id === started.changeLogId);
    expect((await row())?.wordsUsed).toBe("start a session on Start undo");
    await eventually(
      async () =>
        (await client.tasks(project.id)).every((t) => t.status === "done") &&
        !(await client.sessions()).some(
          (s) => s.projectId === project.id && ["running", "paused", "planned"].includes(s.status),
        ),
      "the started session to end",
      async () => (await client.tasks(project.id)).map((t) => t.status).join(", "),
      60_000,
    );
    expect(await row()).toMatchObject({
      undoState: "undoable",
      undoable: false,
      undoBlockedReason: "the session this start began has already ended; there is nothing to undo",
    });
    expect(
      (await client.changes({ projectId: project.id, undoable: true })).map((c) => c.id),
    ).not.toContain(started.changeLogId);
  }, 120_000);

  it("POST /sessions on a project with nothing to run answers the start check's sentence and starts nothing (later #38)", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Nothing to run", goal: "Say so" });
    const before = (await client.sessions()).length;
    const refused = await client
      .startSession({ agentId, projectId: project.id, reason: "continue where it stopped" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const check = await client.startCheck(project.id);
    expect(check.blocked?.kind).toBe("nothing_runnable");
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused, JSON.stringify(refused)).toMatchObject({
      code: "conflict",
      status: 409,
      message: check.blocked?.sentence,
    });
    expect((await client.sessions()).length).toBe(before);
  });

  it("the session log names the specialist that runs: after two failed attempts '… takes over … from the tester', and the finished line and the drawer name the same one (later #75, U-044)", async () => {
    // Before: the runner wrote task.started and task.finished with the plan's specialist, while
    // the executor handed the third attempt to another one inside its run ("The coder started …"
    // and "The coder finished …" for the migration specialist's work), with no "takes over".
    // A stand-in never crosses the sign-off line ('answers', C-2), so the coder keeps its own
    // tasks; the hand-over is shown with the tester's task, which the coder takes over.
    const project = await client.createProject({ name: "Ladder", goal: "Name who runs" });
    const task = await client.createTask(project.id, {
      title: "Ladder notes: write notes/ladder.md",
      outcome: "notes/ladder.md lists the steps",
      riskTier: 1,
      specialist: "tester",
    });
    bench.fail = ["Ladder notes"];
    bench.failTimes = 2;
    try {
      for (let i = 0; i < 4; i++) {
        const now = (await client.tasks(project.id)).find((t) => t.id === task.id);
        if (now?.status === "done") break;
        if (now?.status !== "ready" && now?.status !== "failed") break;
        if (now.status === "failed")
          await client.taskAction(task.id, { version: now.version, action: "try_again" });
        await runSession(project.id);
      }
    } finally {
      bench.fail = [];
      bench.failTimes = Number.POSITIVE_INFINITY;
    }
    const detail = await client.task(task.id);
    const work = detail.runs.filter((r) => r.kind === "work");
    const states = JSON.stringify(work.map((r) => [r.specialist, r.outcome]));
    expect(work.length, states).toBeGreaterThanOrEqual(3);
    const third = work[0];
    expect(third?.specialist, states).not.toBe("tester");
    const events = (
      await Promise.all(
        [...new Set(work.map((r) => r.sessionId ?? ""))].map((id) => client.sessionEvents(id)),
      )
    ).flat();
    const mine = (type: string) =>
      events.filter(
        (e) => e.type === type && (e.payload as { taskId?: string }).taskId === task.id,
      );
    const lastStart = mine("task.started").at(-1);
    expect(
      lastStart?.payload,
      JSON.stringify(mine("task.started").map((e) => e.payload)),
    ).toMatchObject({
      specialist: third?.specialist,
      handedFrom: "tester",
    });
    expect(lastStart?.audience).toBe("person");
    expect(lastStart?.text).toMatch(
      / takes over "Ladder notes: write notes\/ladder\.md" from the tester\.$/,
    );
    expect(mine("task.finished").at(-1)?.payload).toMatchObject({ specialist: third?.specialist });
  }, 120_000);

  it("after a hand-over, the stand-in's own failed attempt is told as the stand-in's: its 'could not do' line names who ran it (U-044, review of later #75)", async () => {
    // Before: the critic's line about the stand-in's run named the plan's specialist, right
    // under "The migration specialist takes over …": "The coder could not do …. Trying again."
    // The hand-over is the tester's task to the coder (a stand-in never crosses the sign-off
    // line, 'answers' C-2).
    const project = await client.createProject({ name: "Third ladder", goal: "Name who ran" });
    const task = await client.createTask(project.id, {
      title: "Third ladder: write notes/third.md",
      outcome: "notes/third.md lists the steps",
      riskTier: 1,
      specialist: "tester",
    });
    bench.fail = ["Third ladder"];
    bench.failTimes = 3;
    try {
      for (let i = 0; i < 4; i++) {
        const now = (await client.tasks(project.id)).find((t) => t.id === task.id);
        if (now?.status !== "ready" && now?.status !== "failed") break;
        if (now.status === "failed")
          await client.taskAction(task.id, { version: now.version, action: "try_again" });
        await runSession(project.id);
      }
    } finally {
      bench.fail = [];
      bench.failTimes = Number.POSITIVE_INFINITY;
    }
    const work = (await client.task(task.id)).runs.filter((r) => r.kind === "work");
    const said: string[] = [];
    let handOver: {
      who: string;
      specialist: string;
      verdict?: Awaited<ReturnType<DaemonClient["sessionEvents"]>>[number];
    } | null = null;
    for (const sessionId of [...new Set(work.map((r) => r.sessionId ?? ""))]) {
      const log = (await client.sessionEvents(sessionId)).filter(
        (e) => (e.payload as { taskId?: string }).taskId === task.id,
      );
      said.push(...log.filter((e) => e.audience === "person").map((e) => e.text));
      const at = log.findIndex(
        (e) => e.type === "task.started" && !!(e.payload as { handedFrom?: string }).handedFrom,
      );
      const started = log[at];
      if (!started) continue;
      handOver = {
        who: started.text.split(" takes over ")[0] ?? "",
        specialist: String((started.payload as { specialist?: string }).specialist),
        verdict: log.slice(at + 1).find((e) => e.type === "critic.verdict"),
      };
    }
    expect(handOver, JSON.stringify(said)).not.toBeNull();
    expect(handOver?.specialist).not.toBe("tester");
    // The stand-in's own attempt failed too (the third planted failure): the critic's line
    // about it names the stand-in, as the line above it did.
    expect(handOver?.verdict?.payload, JSON.stringify(said)).toMatchObject({
      specialist: handOver?.specialist,
      couldNot: expect.any(String),
    });
    expect(handOver?.verdict?.text, JSON.stringify(said)).toMatch(
      new RegExp(`^${handOver?.who} could not do "Third ladder: write notes/third\\.md"`),
    );
  }, 180_000);

  it("GET /projects/:id/summary: a task the session left for the person reads what it is now once it moved on (C-54)", async () => {
    // Before: after Mark done anyway the Overview kept the session's '"X" needs your decision
    // (Inbox).' while the header said done and the Inbox had no such card.
    const me = await client.me();
    const project = await client.createProject({ name: "Since then", goal: "True now" });
    const task = await client.createTask(project.id, {
      title: "Write docs/plan.md",
      outcome: "docs/plan.md lists the steps",
      riskTier: 1,
      specialist: "coder",
    });
    bench.fail = ["Write docs/plan.md"];
    try {
      await runSession(project.id);
    } finally {
      bench.fail = [];
    }
    const before = await client.projectSummary(project.id);
    expect(before.lastSession?.summary, JSON.stringify(before.lastSession)).toMatch(
      /needs your decision/,
    );
    expect(before.lastSession?.since).toBeUndefined();
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.taskId === task.id && r.status === "open",
    );
    expect(card, "the failed task's card").toBeDefined();
    await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: "Mark done anyway",
    });
    const after = await client.projectSummary(project.id);
    expect(after.lastSession?.summary).toBe(before.lastSession?.summary);
    expect(after.lastSession?.since).toEqual([
      'Since then: "Write docs/plan.md" is done: accepted without review.',
    ]);
  }, 120_000);

  it("GET /projects: under Stop all a project with ready work offers no Continue the Start dialog would refuse (later #62, #49)", async () => {
    const project = await client.createProject({ name: "Ready under Stop all", goal: "Wait" });
    await client.createTask(project.id, {
      title: "Write notes/later.md",
      outcome: "notes/later.md exists",
      riskTier: 1,
    });
    await client.kill({ scope: "all", reason: "stop all from the UI" });
    try {
      const card = (await client.projects()).find((p) => p.id === project.id);
      expect(card?.statusLine).toEqual({
        kind: "ready",
        text: "Ready: 1 task. Sessions are stopped.",
        action: null,
      });
      expect((await client.startCheck(project.id)).blocked?.kind).toBe("stopped");
    } finally {
      await client.resume();
    }
    expect((await client.projects()).find((p) => p.id === project.id)?.statusLine).toMatchObject({
      text: "Ready to continue: 1 task ready",
      action: { kind: "start", label: "Continue" },
    });
    // Nothing is left ready for the next case's session.
    const [task] = await client.tasks(project.id);
    if (task) await client.taskAction(task.id, { version: task.version, action: "cancel" });
  });
});

describe("the UI client against the real daemon without a Claude key: the ready line (phase E, screens)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-nokey-ready-"));
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

  it("GET /projects: a project with a ready task reads 'Claude is not connected' with Connect Claude, the Start dialog's blocker (later #62)", async () => {
    // Before: "Ready to continue: 1 task ready [Continue]", and Continue led to a disabled Start.
    const project = await client.createProject({ name: "No key, ready", goal: "Say so" });
    await client.createTask(project.id, { title: "Write the README", outcome: "README.md exists" });
    const card = (await client.projects()).find((p) => p.id === project.id);
    expect(card?.statusLine).toEqual({
      kind: "ready",
      text: "Ready: 1 task. Claude is not connected.",
      action: { kind: "link", label: "Connect Claude", to: "/setup" },
    });
    expect((await client.startCheck(project.id)).blocked?.kind).toBe("no_model");
  });
});

describe("the UI client against the real daemon: Continue where it stopped starts only what Stop all stopped (phase E, screens, later #60)", () => {
  /** The daemon on `home`, its specialist runs waiting until they are stopped. */
  async function compose(home: string) {
    const env = { FORERUNNER_HOME: home };
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const provider = new ScriptedProvider([WAITING_CALL, WAITING_CALL, WAITING_CALL], clock);
    const rt = await composeRuntime({
      env,
      dirs: appDirs({ env }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider: new AcceptingCriticProvider(provider),
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
    return { rt, client, provider };
  }

  /** Two projects with a ready task each; a session runs the first's task. */
  async function twoProjectsOneRunning(
    client: DaemonClient,
    provider: ScriptedProvider,
    name: string,
  ) {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = (n: string) =>
      client.createProject({ name: n, goal: "Two pages", autonomyLevel: 2 });
    const a = await project(`${name} A`);
    const b = await project(`${name} B`);
    for (const p of [a, b])
      await client.createTask(p.id, {
        title: `Write ${p.name}.html`,
        outcome: "the page exists",
        riskTier: 0,
      });
    const calls = provider.calls.length;
    const started = await client.startSession({ agentId, projectId: a.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    await eventually(
      async () => provider.calls.length > calls,
      "the first project's run",
      async () => `session ${(await client.session(sessionId)).status}`,
      10_000,
    );
    return { a, b, sessionId };
  }

  it("POST /kill/resume names the projects whose sessions Stop all ended, in this process and after a restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-continue-"));
    const first = await compose(home);
    let a = "";
    try {
      const one = await twoProjectsOneRunning(first.client, first.provider, "Now");
      await first.client.kill({ scope: "all", reason: "stop all from the UI" });
      await eventually(
        async () => (await first.client.session(one.sessionId)).stopReason === "stop_all",
        "the session to end by Stop all",
        async () => `session ${(await first.client.session(one.sessionId)).status}`,
        10_000,
      );
      // Only the project that ran: the other one has ready work too, and nothing stopped it.
      expect((await first.client.resume()).stoppedProjects).toEqual([one.a.id]);
      // Allowed again: a second resume names nothing.
      expect((await first.client.resume()).stoppedProjects).toEqual([]);

      // Stop all again, then the daemon stops and starts on the same home before Continue.
      const agentId = (await first.client.agents())[0]?.id ?? "";
      const calls = first.provider.calls.length;
      const again = await first.client.startSession({ agentId, projectId: one.a.id });
      await eventually(
        async () => first.provider.calls.length > calls,
        "the run again",
        async () => `session ${(await first.client.session(again.session?.id ?? "")).status}`,
        10_000,
      );
      await first.client.kill({ scope: "all", reason: "stop all from the UI" });
      a = one.a.id;
    } finally {
      await first.rt.close();
    }
    const second = await compose(home);
    try {
      expect((await second.client.resume()).stoppedProjects).toEqual([a]);
    } finally {
      await second.rt.close();
    }
  }, 60_000);

  it("a Stop all said in the chat is remembered as the header's: after a restart, POST /kill/resume names the project it stopped (answers + screens, later #60)", async () => {
    // 'answers' made the chat's "stop everything" write kill.json as POST /kill does, so the
    // freeze survives a restart; 'screens' made POST /kill keep the sessions it ended in that
    // file, so Continue where it stopped starts them after a restart. The chat's file must
    // carry them too, or a restart forgets what the chat's Stop all stopped.
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-continue-chat-"));
    const first = await compose(home);
    let a = "";
    try {
      const one = await twoProjectsOneRunning(first.client, first.provider, "Chat");
      const me = await first.client.me();
      const agentId = (await first.client.agents())[0]?.id ?? "";
      const said = await first.client.chat({
        humanId: me.id,
        agentId,
        projectId: one.a.id,
        projectTab: true,
        text: "stop everything",
        source: "text",
      });
      expect(said.actions.map((x) => x.kind)).toEqual(["session.stop"]);
      await eventually(
        async () => (await first.client.session(one.sessionId)).stopReason === "stop_all",
        "the session to end by the chat's Stop all",
        async () => JSON.stringify(await first.client.session(one.sessionId)),
        15_000,
      );
      a = one.a.id;
    } finally {
      await first.rt.close();
    }
    const second = await compose(home);
    try {
      expect((await second.client.resume()).stoppedProjects).toEqual([a]);
    } finally {
      await second.rt.close();
    }
  }, 60_000);

  it("a session the person undid is not started again: POST /kill/resume names only what Stop all stopped (review of later #60)", async () => {
    // Before: the undo of the chat's start stops its session with the freeze on, so the kill
    // switch counted it as stopped by Stop all; the next Stop all and Continue where it stopped
    // started the undone project again, and it spent.
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-continue-undo-"));
    const { rt, client, provider } = await compose(home);
    try {
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = (n: string) =>
        client.createProject({ name: n, goal: "One page", autonomyLevel: 2 });
      const undone = await project("Undone start");
      const other = await project("Victor notes");
      for (const p of [undone, other])
        await client.createTask(p.id, {
          title: `Write ${p.name}.html`,
          outcome: "the page exists",
          riskTier: 0,
        });
      const sessionOf = async (projectId: string) =>
        (await client.sessions()).find(
          (s) => s.projectId === projectId && ["running", "paused", "planned"].includes(s.status),
        );

      // The chat starts a session on the first project, and its run begins.
      let calls = provider.calls.length;
      const asked = await client.executeCommands({
        commands: [{ name: "session.start", params: { project: undone.id, budgetChf: 5 } }],
        wordsUsed: "start a session on Undone start",
        source: "text",
        projectId: undone.id,
      });
      const started =
        asked.status === "pending" && asked.pendingId
          ? await client.confirmCommand(asked.pendingId, { answer: "tap" })
          : asked;
      expect(started.status, JSON.stringify(started)).toBe("done");
      await eventually(
        async () => provider.calls.length > calls,
        "the chat's session to run its task",
        async () => `session ${(await sessionOf(undone.id))?.status ?? "none"}`,
        15_000,
      );
      const undoneSession = (await sessionOf(undone.id))?.id ?? "";
      expect(undoneSession).not.toBe("");

      // Changes → Undo stops it.
      await client.undoChange(started.changeLogId ?? "");
      await eventually(
        async () => (await client.session(undoneSession)).stopReason === "you",
        "the undone session to end, stopped by you",
        async () => JSON.stringify(await client.session(undoneSession)),
        15_000,
      );

      // A session on the other project, then Stop all.
      calls = provider.calls.length;
      const second = await client.startSession({ agentId, projectId: other.id });
      const otherSession = second.session?.id ?? "";
      await eventually(
        async () => provider.calls.length > calls,
        "the other project's run",
        async () => `session ${(await client.session(otherSession)).status}`,
        15_000,
      );
      await client.kill({ scope: "all", reason: "stop all from the UI" });
      await eventually(
        async () => (await client.session(otherSession)).stopReason === "stop_all",
        "the other session to end by Stop all",
        async () => `session ${(await client.session(otherSession)).status}`,
        15_000,
      );
      expect((await client.resume()).stoppedProjects).toEqual([other.id]);
    } finally {
      await rt.close();
    }
  }, 90_000);
});

describe("the UI client against the real daemon: a start on a project with nothing to run while another project's session runs (phase E, screens, later #38)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let provider: ScriptedProvider;

  beforeAll(async () => {
    ({ rt, client, provider } = await composeWithWaitingRun([WAITING_CALL]));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("POST /sessions, the Start dialog and the chat refuse it in the start check's words; no session is queued for it", async () => {
    // Before: a running session of the agent made every start wait for it (`busy`), so the
    // start on the empty project was queued and became a session that ended with "Nothing
    // could run: no task is ready."; its Start dialog offered an enabled Start, "Starts after
    // the current session". Another project's work makes none of this project's tasks ready.
    const agentId = (await client.agents())[0]?.id ?? "";
    const me = await client.me();
    const busy = await client.createProject({ name: "Busy one", goal: "Keeps the agent busy" });
    await client.createTask(busy.id, {
      title: "Write the busy page",
      outcome: "it is done",
      riskTier: 0,
    });
    const empty = await client.createProject({ name: "Empty one", goal: "Nothing to do yet" });
    const running = await client.startSession({ agentId, projectId: busy.id });
    const runningId = running.session?.id ?? "";
    expect(runningId).not.toBe("");
    try {
      await eventually(
        async () => provider.calls.length >= 1,
        "the busy project's model call",
        async () => `${provider.calls.length} model call(s)`,
        10_000,
      );
      const check = await client.startCheck(empty.id);
      expect(check.busy).toBe(true);
      expect(check.blocked).toMatchObject({
        kind: "nothing_runnable",
        sentence: "Nothing can run: no task is ready.",
      });
      const refused = await client.startSession({ agentId, projectId: empty.id }).then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(refused, JSON.stringify(refused)).toMatchObject({
        code: "conflict",
        status: 409,
        message: "Nothing can run: no task is ready.",
      });
      const reply = await client.chat({
        humanId: me.id,
        agentId: rt.agent.id,
        projectId: empty.id,
        projectTab: true,
        text: "start a session",
        source: "text",
      });
      expect(reply.reply).toMatch(/^Nothing can run: no task is ready\./);
      expect(reply.pendingConfirmation).toBeNull();
      expect(rt.scheduler.pendingStarts(agentId)).toEqual([]);
      // The busy project's own Start still waits its turn: that session's work is its own.
      expect((await client.startCheck(busy.id)).blocked).toBeNull();
    } finally {
      await client.stopSession(runningId, "stopped from the live view");
      await eventually(
        async () =>
          !rt.scheduler.isActive(agentId) && rt.scheduler.pendingStarts(agentId).length === 0,
        "the agent to be free, with nothing waiting",
        async () =>
          `active ${rt.scheduler.isActive(agentId)}, ${rt.scheduler.pendingStarts(agentId).length} waiting`,
        10_000,
      );
    }
    expect(await client.sessions({ projectId: empty.id })).toEqual([]);
  }, 60_000);
});

describe("the UI client against the real daemon: what the bench walks (phase E, bench)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  /** Holds the next specialist call until `release()`: a session is seen while it runs. */
  let hold: { armed: boolean; held: boolean; release: () => void; gate: Promise<void> } = {
    armed: false,
    held: false,
    release: () => undefined,
    gate: Promise.resolve(),
  };
  const arm = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hold = { armed: true, held: false, release, gate };
  };

  beforeAll(async () => {
    // The bench's stand-in as `fr daemon --provider bench` runs it: the check task asks the
    // person first (FORERUNNER_BENCH_ASK), so a session ends with a task that needs them.
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-bench-"));
    const player = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0", FORERUNNER_BENCH_ASK: "Check that" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    const stream = player.stream.bind(player);
    player.stream = async function* (req) {
      if (hold.armed && !hold.held && detectRole(req).role === "specialist") {
        hold.held = true;
        await hold.gate;
      }
      yield* stream(req);
    };
    ({ rt, client } = await composeWithRolePlayer({}, { provider: player }));
  }, 120_000);
  afterAll(async () => {
    hold.release();
    await rt?.close();
  });

  const BRIEF = "A page that shows a random quote";
  const planCard = async (name: string) => {
    const project = await client.createProject({
      name,
      goal: goalFromBrief(BRIEF),
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
  /** The task titles the plan card shows (the Inbox's own reading of the card). */
  const shownTasks = (card: { changeCard?: unknown } | undefined) =>
    (intakeCardOf(card?.changeCard)?.milestones ?? []).flatMap((m) => m.tasks.map((t) => t.title));

  it("Change the plan with the stand-in: the new plan card shows the change the person typed", async () => {
    const { project, card, me } = await planCard("Changed by words");
    const before = shownTasks(card);
    expect(before.some((t) => /^Check /.test(t))).toBe(true);
    // What the Inbox sends for Change the plan with the words in its text box.
    await client.answerRequest(card.id, {
      version: card.version,
      answer: { choice: "Change the plan", text: "drop the check and add a README task" },
    });
    await rt.intake.inFlight(project.id);
    const status = await client.intakeStatus(project.id);
    expect(status.state).toBe("pending");
    const next = (await client.inbox(me.id)).requests.find((r) => r.id === status.requestId);
    const after = shownTasks(next);
    expect(after).toContain(before[0]);
    expect(after.some((t) => /check/i.test(t))).toBe(false);
    expect(after.filter((t) => /README/.test(t))).toHaveLength(1);
    expect(next?.title).toBe(`Plan for "Changed by words": ${after.length} tasks`);
    // Nothing is left open for the next case: Reject writes nothing.
    await client.answerRequest(next?.id ?? "", { version: next?.version ?? 0, answer: "Reject" });
    expect(await client.tasks(project.id)).toEqual([]);
  }, 60_000);

  it("a session Approve and start began: Working now while it runs, then 'Ended: 1 task needs you', the files it changed, and the plan and its record among the decisions (rule 3)", async () => {
    const { project, card } = await planCard("Seen working");
    arm();
    await client.answerRequest(card.id, { version: card.version, answer: "Approve and start" });
    const tasks = await client.tasks(project.id);
    const build = tasks.find((t) => t.specialist === "coder");
    if (!build) throw new Error(`no coder task in ${tasks.map((t) => t.title).join(", ")}`);
    const states = async () =>
      `${(await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ")}; held=${hold.held}`;
    // The specialist's first call is held: the session runs the build task now.
    await eventually(async () => hold.held, "the build task's first model call", states, 30_000);
    const session = (await client.sessions({ projectId: project.id })).find(
      (s) => s.status === "running",
    );
    if (!session) throw new Error("no running session");
    const running = (await client.projects()).find((p) => p.id === project.id);
    expect(running?.working).toMatchObject({
      sessionId: session.id,
      agentName: "Alice",
      taskId: build.id,
      taskTitle: build.title,
    });
    expect(running?.working?.since).toBeTruthy();
    expect((await client.project(project.id)).working?.sessionId).toBe(session.id);
    hold.release();
    await eventually(
      async () => (await client.session(session.id)).status !== "running",
      "the session to end",
      states,
      60_000,
    );
    // The check task asked the person; the session finished with it waiting for them.
    const ended = await client.session(session.id);
    expect(ended.status).toBe("completed");
    expect(ended.statusText).toBe("Ended: 1 task needs you");
    expect((await client.project(project.id)).working).toBeNull();
    const summary = await client.projectSummary(project.id);
    expect(summary.lastSession?.id).toBe(session.id);
    expect(summary.lastSession?.changedFiles).toEqual(
      expect.arrayContaining(["index.html", "script.js", "styles.css"]),
    );
    // The plan the person approved and the decision record it wrote are decisions too.
    const decisions = await client.decisions(project.id);
    expect(decisions.find((d) => d.kind === "plan")).toMatchObject({
      id: card.id,
      question: "The plan for Seen working",
      chosen: "Approved.",
      decidedByName: "J",
      path: null,
    });
    expect(decisions.find((d) => d.kind === "record")).toMatchObject({
      question: "A plain static page, no build step",
      chosen: "docs/decisions/0001-plain-static-page.md",
      path: "docs/decisions/0001-plain-static-page.md",
      decidedByName: null,
    });
  }, 120_000);
});

describe("the UI client against the real daemon: a session on a repository opens the pull request the Overview lists (phase E, bench, C-62)", () => {
  // The repository block above puts the done task and its PR into the store by hand; here a
  // session does the work on a git host (bare repositories behind the memory host, as the
  // bench's --githost serves them) and the Overview's list is read after it.
  let rt: RuntimeApp;
  let client: DaemonClient;
  const host = new MemoryGitHost("alice");

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-ui-real-pr-"));
    const bare = join(dir, "seeded.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({
      cwd: join(dir, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(dir, "seed", "README.md"), "# seeded\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name: "seeded", private: true, cloneUrl: bare });
    ({ rt, client } = await composeWithRolePlayer({}, { gitHost: host }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("Start runs the task on a branch, the critic accepts it, and its pull request waits for the person with its link", async () => {
    const project = await client.createProject({
      name: "On a repository",
      goal: "A page in a repository",
      repos: ["o/seeded"],
    });
    const task = await client.createTask(project.id, {
      title: "Create the page skeleton in index.html",
      outcome: "index.html is a valid HTML5 page with a heading",
      riskTier: 1,
      specialist: "coder",
    });
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    const states = async () =>
      (await client.tasks(project.id))
        .map((t) => `${t.title}=${t.status} (${t.reason})`)
        .join(", ");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      states,
      90_000,
    );
    const done = await client.task(task.id);
    expect(done.task.status, await states()).toBe("done");
    expect(done.runs.map((r) => [r.kind, r.specialist])).toEqual([
      ["review", "critic"],
      ["work", "coder"],
    ]);
    // The work is on its own branch of the repository, in the pull request the session opened.
    const prUrl = done.task.prUrl ?? "";
    expect(prUrl).toMatch(/^memory:\/\/o\/seeded\/pull\/\d+$/);
    const view = await client.projectPullRequests(project.id);
    expect(view.error).toBeNull();
    expect(view.repository).toEqual({
      fullName: "o/seeded",
      url: "https://github.com/o/seeded",
    });
    const waiting = view.waiting.find((w) => w.kind === "task");
    expect(waiting).toMatchObject({
      taskId: task.id,
      title: "Create the page skeleton in index.html",
      url: prUrl,
      review: "critic",
    });
    expect(waiting?.branch).toMatch(/^fr\//);
    expect(waiting?.number).toBe(Number(prUrl.split("/").at(-1)));
    // Merged on the host: no longer waiting, read from the host when asked.
    await host.mergePullRequest({ owner: "o", name: "seeded" }, waiting?.number ?? 0);
    expect(
      (await client.projectPullRequests(project.id)).waiting.filter((w) => w.kind === "task"),
    ).toEqual([]);
  }, 150_000);
});

describe("the UI client against the real daemon: Quit during 'Being reviewed', then the daemon starts again (stops, L-1)", () => {
  it("the task reads Ready, the Update says it is ready again, and the next Start runs and reviews it", async () => {
    // Live check of phase C (2026-11-02): Quit while the critic reviewed "Contact page", then
    // reopen: the row and drawer read "Being reviewed · The critic is checking the work." for
    // good, Start had nothing to run, and the Update said "Nothing was left half done." Quit's
    // stop had released the task's claim, which leaves a task in review in review, and the
    // next start freed only the tasks still claimed.
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-quit-review-"));
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    // The review holds where the live one was: opening the page in a browser, a step that
    // does not end when the process is asked to stop.
    let trying = false;
    const first = await composeWithRolePlayer(
      {},
      {
        env,
        dirs,
        stateUrl,
        tryIt: {
          tryPages: () => {
            trying = true;
            return new Promise(() => undefined);
          },
        },
      },
    );
    let projectId = "";
    let taskId = "";
    try {
      const project = await first.client.createProject({ name: "Garden club", goal: "Pages" });
      projectId = project.id;
      const page = await first.client.createTask(project.id, {
        title: "Contact page in contact.html",
        outcome: "contact.html says how to reach the club",
        riskTier: 1,
        specialist: "coder",
      });
      taskId = page.id;
      const agentId = (await first.client.agents())[0]?.id ?? "";
      await first.client.startSession({ agentId, projectId });
      await eventually(
        async () =>
          trying &&
          (await first.client.tasks(projectId)).find((t) => t.id === taskId)?.display?.label ===
            "Being reviewed",
        "the task to read Being reviewed",
        async () => (await first.client.tasks(projectId)).map((t) => t.status).join(", "),
        30_000,
      );
      // Quit, as the desktop shell's Quit asks the daemon (`POST /shutdown`): every run stops
      // and every claim is released; then the process ends.
      const { app, token } = createDaemonApp(first.rt, { onShutdown: () => undefined });
      const quit = await app.request("/shutdown", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(quit.status).toBe(202);
    } finally {
      await first.rt.close();
    }

    // Forerunner opens again on the same home.
    const second = await composeWithRolePlayer({}, { env, dirs, stateUrl, tryIt: false });
    try {
      const row = (await second.client.tasks(projectId)).find((t) => t.id === taskId);
      expect(row?.display?.label).toBe("Ready");
      const me = await second.client.me();
      const updates = (await second.client.inbox(me.id)).messages.map((m) => m.body);
      expect(updates).toContain(
        'Your last session was interrupted when Forerunner closed. "Contact page in contact.html" is ready again.',
      );
      expect(updates.join("\n")).not.toContain("Nothing was left half done.");
      const check = await second.client.startCheck(projectId);
      expect(check.runnable.map((t) => t.taskId)).toContain(taskId);
      // The next Start runs it and the critic reviews it.
      const agentId = (await second.client.agents())[0]?.id ?? "";
      const started = await second.client.startSession({ agentId, projectId });
      await eventually(
        async () => (await second.client.session(started.session?.id ?? "")).status !== "running",
        "the next session to end",
        async () => (await second.client.tasks(projectId)).map((t) => t.status).join(", "),
        30_000,
      );
      const done = await second.client.task(taskId);
      expect(done.task.status).toBe("done");
      expect(done.runs.some((r) => r.kind === "review")).toBe(true);
      expect(second.criticCalls.length).toBeGreaterThan(0);
    } finally {
      await second.rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: Cancel in the first moment of 'Being reviewed' (stops, L-8)", () => {
  it("the review stops at once: no critic call after the Cancel, its files leave the folder, the line is true", async () => {
    // Live check of phase C (2026-11-02), c9b: Cancel pressed about 0.1 s into "Being
    // reviewed" (the page was being opened in a browser): the kill switch stopped the review,
    // yet two critic calls ran after it to an accept (CHF 0.03), and credits.html stayed in
    // Files about 6 s, until the review ended. 3 s in, it worked. The critic's own run never
    // got the review's signal: only a run already going was stopped.
    let release: () => void = () => undefined;
    let trying = false;
    const { rt, client, criticCalls } = await composeWithRolePlayer(
      {},
      {
        tryIt: {
          tryPages: (req) => {
            trying = true;
            // Opening the page takes a while; it ends when the test lets it.
            return new Promise((resolve) => {
              release = () =>
                resolve({
                  tried: req.pages.map((page) => ({
                    what: `opened ${page} in a browser`,
                    target: page,
                    ok: true,
                    blocking: false,
                    output: `opened ${page}`,
                    screenshots: [],
                  })),
                });
            });
          },
        },
      },
    );
    try {
      const project = await client.createProject({ name: "Quote page", goal: "Credits" });
      const page = await client.createTask(project.id, {
        title: "Credits page in credits.html",
        outcome: "credits.html names who made the page",
        riskTier: 1,
        specialist: "coder",
      });
      const agentId = (await client.agents())[0]?.id ?? "";
      const started = await client.startSession({ agentId, projectId: project.id });
      const row = async () => (await client.tasks(project.id)).find((t) => t.id === page.id);
      await eventually(
        async () => trying && (await row())?.display?.label === "Being reviewed",
        "the task to read Being reviewed",
        async () => `${(await row())?.status}`,
        30_000,
      );
      const files = async () => (await client.projectFiles(project.id)).entries.map((e) => e.path);
      expect(await files()).toContain("credits.html");
      // The row's Cancel, as the Tasks tab sends it.
      const shown = await row();
      const cancelled = await client.taskAction(page.id, {
        version: shown?.version ?? 0,
        action: "cancel",
      });
      expect(cancelled.change?.sentence).toMatch(
        /^Cancelled "Credits page in credits\.html": its review stopped and its changes are removed/,
      );
      // The browser step ends; the review must not go on to the critic's model.
      release();
      await eventually(
        async () => (await client.session(started.session?.id ?? "")).status !== "running",
        "the session to end",
        async () => `${(await row())?.status}, ${criticCalls.length} critic calls`,
        30_000,
      );
      expect(criticCalls).toHaveLength(0);
      expect((await row())?.display?.label).toBe("Cancelled");
      expect(await files()).not.toContain("credits.html");
      const detail = await client.task(page.id);
      expect(detail.review).toBeNull();
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: 'Skip the … task' in Chat cancels it (stops, L-10)", () => {
  it("read back as a cancel; Yes cancels it with the line the row's Cancel gives", async () => {
    // Live check of phase C (2026-11-02): "Skip the Credits page task" while it ran was read
    // back as 'Stop "Credits page in credits.html"? Its run stops now and it is paused', and
    // Yes left it "Paused by you".
    // Each specialist reply waits a minute, so the task stays Running while the chat is used.
    const { rt, client } = await composeWithRolePlayer({ FORERUNNER_BENCH_DELAY_MS: "60000" });
    try {
      const me = await client.me();
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = await client.createProject({ name: "Quote page", goal: "Credits" });
      const page = await client.createTask(project.id, {
        title: "Credits page in credits.html",
        outcome: "credits.html names who made the page",
        riskTier: 1,
        specialist: "coder",
      });
      const started = await client.startSession({ agentId, projectId: project.id });
      const row = async () => (await client.tasks(project.id)).find((t) => t.id === page.id);
      await eventually(
        async () => (await row())?.display?.label === "Running",
        "the task to run",
        async () => `${(await row())?.status}`,
        30_000,
      );
      const say = (text: string) =>
        client.chat({
          humanId: me.id,
          agentId,
          projectId: project.id,
          projectTab: true,
          text,
          source: "text",
        });
      const asked = await say("Skip the Credits page task");
      expect(asked.pendingConfirmation?.readback).toBe(
        'Cancel "Credits page in credits.html"? Drops it. Its run stops and its changes are removed; Undo restores them unless the files changed.',
      );
      const yes = await say("yes");
      expect(yes.actions.map((a) => a.kind)).toEqual(["task.transition"]);
      // The same line as the row's Cancel (`POST /tasks/:id/action` with "cancel").
      expect(yes.reply).toBe(
        'Cancelled "Credits page in credits.html": its run stopped and its changes are removed; Undo restores them unless the files changed.',
      );
      expect((await row())?.display?.label).toBe("Cancelled");
      await eventually(
        async () => (await client.session(started.session?.id ?? "")).status !== "running",
        "the session to end",
        async () => `${(await row())?.status}`,
        30_000,
      );
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: Cancel promises a removal only while a review goes on (stops, L-7)", () => {
  it("a task being reviewed says whether its review goes on here; the chat's read-back and the line follow it", async () => {
    // Live check of phase C (2026-11-02): a task left "Being reviewed" with no review going
    // on (Forerunner had closed during it) got the Cancel dialog "Drops it. Its review stops
    // now and what it changed is removed; Undo brings it back." and nothing was removed. The
    // dialog was worded from the status, while only a review going on is stopped.
    // The critic's replies wait a minute: one task's review goes on while the test looks.
    const { rt, client } = await composeWithRolePlayer({
      FORERUNNER_BENCH_CRITIC_DELAY_MS: "60000",
    });
    try {
      const me = await client.me();
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = await client.createProject({ name: "Garden club", goal: "Pages" });
      const running = await client.createTask(project.id, {
        title: "About page in about.html",
        outcome: "about.html tells the club's story",
        riskTier: 1,
        specialist: "coder",
        priority: "high",
      });
      // Left in review with no review going on here (what a closed Forerunner left before
      // L-1, or another computer's session).
      const left = await rt.store.task.insert({
        project_id: project.id,
        title: "Contact page in contact.html",
        outcome: "contact.html says how to reach the club",
        acceptance_criteria: ["contact.html exists"],
        risk_tier: 1,
        status: "in_review",
        priority: 1,
        specialist: "coder",
        reason: "Wrote contact.html.",
      } as never);
      const started = await client.startSession({ agentId, projectId: project.id });
      const view = async (id: string) => (await client.tasks(project.id)).find((t) => t.id === id);
      await eventually(
        async () => (await view(running.id))?.display?.label === "Being reviewed",
        "the About page's review to begin",
        async () => `${(await view(running.id))?.status}`,
        30_000,
      );
      // Its review goes on here; the other one's does not.
      expect((await view(running.id))?.display?.live).toBe(true);
      const idle = await view(left.id);
      expect(idle?.display?.label).toBe("Being reviewed");
      expect(idle?.display?.live).toBe(false);
      // The drawer reads the same view.
      expect((await client.task(left.id)).task.display?.live).toBe(false);
      // Chat's read-back promises nothing about its files; the reviewed one says its review stops.
      const say = (text: string) =>
        client.chat({
          humanId: me.id,
          agentId,
          projectId: project.id,
          projectTab: true,
          text,
          source: "text",
        });
      expect((await say("cancel the Contact page task")).pendingConfirmation?.readback).toBe(
        'Cancel "Contact page in contact.html"? Drops it.',
      );
      expect((await say("no")).reply).toBe("Cancelled; nothing was changed.");
      expect((await say("cancel the About page task")).pendingConfirmation?.readback).toBe(
        'Cancel "About page in about.html"? Drops it. Its review stops and its changes are removed; Undo restores them unless the files changed.',
      );
      expect((await say("no")).reply).toBe("Cancelled; nothing was changed.");
      // The row's Cancel on the one with nothing going on: the line says only that.
      const cancelled = await client.taskAction(left.id, {
        version: idle?.version ?? 0,
        action: "cancel",
      });
      expect(cancelled.change?.sentence).toBe('Cancelled "Contact page in contact.html".');
      // Stop now during the review: the task is Ready again, with nothing going on for it.
      await client.stopSession(started.session?.id ?? "");
      await eventually(
        async () => (await client.session(started.session?.id ?? "")).status !== "running",
        "the session to end",
        async () => `${(await view(running.id))?.status}`,
        30_000,
      );
      const after = await view(running.id);
      expect(after?.display?.label).toBe("Ready");
      expect(after?.display?.live).toBeUndefined();
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("a task with a pull request: the chat's read-back says its pull request stays open, as the Yes line and the row's Cancel do", async () => {
    // Review of fix/stops: every task of a GitHub project carries its pull request from the
    // end of its run, before its review. "skip the About page task" during the review read back
    // 'It is dropped; its review stops now and what it changed is removed.', and Yes said
    // 'its review stopped; its pull request stays open.' (nothing is removed).
    const { rt, client } = await composeWithRolePlayer({
      FORERUNNER_BENCH_CRITIC_DELAY_MS: "60000",
    });
    try {
      const me = await client.me();
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = await client.createProject({ name: "Garden club", goal: "Pages" });
      const page = await client.createTask(project.id, {
        title: "About page in about.html",
        outcome: "about.html tells the club's story",
        riskTier: 1,
        specialist: "coder",
      });
      const started = await client.startSession({ agentId, projectId: project.id });
      const view = async () => (await client.tasks(project.id)).find((t) => t.id === page.id);
      await eventually(
        async () => (await view())?.display?.label === "Being reviewed",
        "the About page's review to begin",
        async () => `${(await view())?.status}`,
        30_000,
      );
      // Its pull request, as the runner records it for a repository project.
      await rt.store.task.patch(page.id, { pr_url: "https://github.test/o/garden/pull/3" });
      const shown = await view();
      expect(shown?.prUrl).toBe("https://github.test/o/garden/pull/3");
      expect(shown?.display?.live).toBe(true);
      const say = (text: string) =>
        client.chat({
          humanId: me.id,
          agentId,
          projectId: project.id,
          projectTab: true,
          text,
          source: "text",
        });
      expect((await say("skip the About page task")).pendingConfirmation?.readback).toBe(
        'Cancel "About page in about.html"? Drops it. Its review stops now; its pull request stays open.',
      );
      const yes = await say("yes");
      expect(yes.actions.map((a) => a.kind)).toEqual(["task.transition"]);
      expect(yes.reply).toBe(
        'Cancelled "About page in about.html": its review stopped; its pull request stays open.',
      );
      expect((await view())?.display?.label).toBe("Cancelled");
      await eventually(
        async () => (await client.session(started.session?.id ?? "")).status !== "running",
        "the session to end",
        async () => `${(await view())?.status}`,
        30_000,
      );
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: research on a Claude subscription alone reads pages too ('sites', was C-64)", () => {
  // Credential-shaped fixtures, built by concatenation so no scanner sees a token.
  const oauth = ["sk-ant-oat01-", "subscription", "0".repeat(40)].join(""); // not-a-secret
  const apiKey = ["sk-ant-api03-", "apikey", "0".repeat(40)].join(""); // not-a-secret

  it("a subscription and no API key: the researcher and the science-evaluator read pages there, so the screens say nothing is missing", async () => {
    const sub = await composeWithRolePlayer(
      {},
      { vault: new MemoryVault({ anthropic_subscription_token: oauth }) },
    );
    try {
      const models = await sub.client.modelSettings();
      const limits = Object.fromEntries(models.specialists.map((x) => [x.name, x.limitation]));
      // Before 'sites': "Searches the web but opens no page on a Claude subscription" and
      // "Reads no web page on a Claude subscription"; Forerunner's reader runs there now.
      expect(limits.researcher).toBeNull();
      expect(limits["science-evaluator"]).toBeNull();
      expect(limits.coder).toBeNull();
      // Where each runs and why, the chooser's words (the plan card's and New task's).
      const runsOn = Object.fromEntries(models.specialists.map((x) => [x.name, x.runsOn]));
      expect(runsOn.researcher).toEqual({ kind: "subscription", line: null });
      expect(runsOn["science-evaluator"]?.kind).toBe("subscription");
      // P7-33 (polish-words): asserted exactly, not only as not naming web pages.
      expect(runsOn["science-evaluator"]).toEqual({ kind: "subscription", line: null });
    } finally {
      await sub.rt.close();
    }
  }, 120_000);

  it("with an API key saved beside it, research reads pages there: no limitation (where it runs is the chooser's, below)", async () => {
    const both = await composeWithRolePlayer(
      {},
      {
        vault: new MemoryVault({
          anthropic_subscription_token: oauth,
          anthropic_api_key: apiKey,
        }),
      },
    );
    try {
      const models = await both.client.modelSettings();
      expect(models.specialists.find((x) => x.name === "researcher")?.limitation).toBeNull();
    } finally {
      await both.rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: the credential chooser says where each task runs and why (U-078)", () => {
  // Credential-shaped fixtures, built by concatenation so no scanner sees a token.
  const oauth = ["sk-ant-oat01-", "chooser", "0".repeat(40)].join(""); // not-a-secret
  const apiKey = ["sk-ant-api03-", "chooser", "0".repeat(40)].join(""); // not-a-secret
  // Since 'sites' both credentials read pages and search: research follows the person's order
  // (the subscription first here), and nothing needs saying. Before: "Runs on your API key: only
  // it can read web pages here."

  it("both credentials, the subscription first: the plan card, New task and Settings say the same words", async () => {
    const both = await composeWithRolePlayer(
      { FORERUNNER_BENCH_PLAN: "research" },
      {
        vault: new MemoryVault({
          anthropic_subscription_token: oauth,
          anthropic_api_key: apiKey,
        }),
      },
    );
    const { rt, client } = both;
    try {
      const brief =
        "Compare two static site generators and write a page that summarises them for a club website.";
      const project = await client.createProject({
        name: "Club research",
        goal: goalFromBrief(brief),
        brief,
        intake: true,
      });
      await rt.intake.inFlight(project.id);
      const me = await client.me();
      const card = (await client.inbox(me.id)).requests.find(
        (r) => r.projectId === project.id && r.status === "open",
      );
      if (!card?.planTasks) throw new Error(`no plan card with planTasks: ${JSON.stringify(card)}`);
      // The plan card's tasks, as the Inbox reads them, each with the daemon's view.
      const research = card.planTasks.find((t) => t.specialist === "researcher");
      expect(research?.runsOn).toEqual({ kind: "subscription", line: null });
      // A new project has no dependencies to install yet: the coder stays on the subscription,
      // with nothing to say.
      const coder = card.planTasks.find((t) => t.specialist === "coder");
      expect(coder?.runsOn).toEqual({ kind: "subscription", line: null });
      expect(card.planTasks.every((t) => t.unknown === null)).toBe(true);
      // New task and Settings: the same words, from GET /settings/models.
      const models = await client.modelSettings(undefined, project.id);
      const runsOn = Object.fromEntries(models.specialists.map((s) => [s.name, s.runsOn]));
      expect(runsOn.researcher).toEqual({ kind: "subscription", line: null });
      expect(runsOn["science-evaluator"]?.kind).toBe("subscription");
      // P7-33 (polish-words): asserted exactly, not only as not naming web pages.
      expect(runsOn["science-evaluator"]).toEqual({ kind: "subscription", line: null });
      // Settings' "What each can do here": the capability function's output.
      expect(models.credentials?.columns).toEqual([
        { kind: "api_key", name: "API key", saved: true },
        { kind: "subscription", name: "Claude subscription", saved: true },
      ]);
      expect(
        models.credentials?.rows.map((r) => [r.label, ...r.cells.map((c) => c.words)]),
      ).toEqual([
        // Forerunner's page reader on the subscription too ('sites'; before: "Not yet").
        ["Read web pages", "Yes", "Yes"],
        // Anthropic's web search on the API key ('web-search', the owner's decision of 2026-11-02).
        ["Search the web", "Yes", "Yes"],
        [
          "Run commands (its tests)",
          "Yes, in a separate folder; a full review waits for Docker",
          "No",
        ],
        ["Ask you while it works", "Yes", "No: it lists its questions in its report"],
        ["What it costs", "Money per use", "Your plan's limits, no money per use"],
      ]);
      // The project gets dependencies to install: the coder's tests will not run on the
      // subscription, and New task says so for this project.
      // (Nothing is written before the plan is approved: the project's workspace folder.)
      const folder = projectWorkspaceDir(rt.data.assets.projectsRoot, project.id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } }),
      );
      const withDeps = await client.modelSettings(undefined, project.id);
      expect(withDeps.specialists.find((s) => s.name === "coder")?.runsOn).toEqual({
        kind: "subscription",
        line: "On your subscription its tests will not run: it cannot run commands there.",
      });
      const plan = (await client.inbox(me.id)).requests.find((r) => r.id === card.id);
      // P7-14 (polish-words): the plan card says a shared runs-on line once, for the plan, under
      // the first task it holds for ("the tests of 2 tasks"), not under every code task.
      const said = (plan?.planTasks ?? []).map((t) => t.runsOn?.line).filter(Boolean);
      expect(said.filter((l) => /tests .*will not run/.test(l ?? ""))).toEqual([
        "On your subscription the tests of 2 tasks will not run: commands cannot run there.",
      ]);
      // "Code tasks that need commands: the API key", as the Settings dialog sends it (a yes).
      const asked = await client.executeCommands({
        commands: [{ name: "settings.set", params: { key: "code_commands", value: "api_key" } }],
        wordsUsed:
          "Settings: Code tasks that need commands to The API key (runs their tests; costs money)",
        source: "ui",
      });
      expect(asked.status, JSON.stringify(asked)).toBe("pending");
      const yes = await client.confirmCommand(asked.pendingId ?? "", { answer: "yes" });
      expect(yes.status, JSON.stringify(yes)).toBe("done");
      expect((await client.settings()).find((s) => s.key === "human.code_commands")?.value).toBe(
        "api_key",
      );
      const moved = await client.modelSettings(undefined, project.id);
      expect(moved.specialists.find((s) => s.name === "coder")?.runsOn).toEqual({
        kind: "api_key",
        line: "Runs on your API key: only it can run commands here.",
      });
      // Nothing is left open for another case.
      await client.answerRequest(card.id, { version: card.version, answer: "Reject" });
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("a plan naming a specialist this install does not have: the card says the task will wait (C-68)", async () => {
    const { rt, client } = await composeWithRolePlayer(
      {},
      { vault: new MemoryVault({ anthropic_api_key: apiKey }) },
    );
    try {
      const project = await client.createProject({ name: "Logo", goal: "A logo" });
      const me = await client.me();
      // A plan card as the intake files it, with a specialist the registry does not have.
      await rt.store.humanRequest.insert({
        human_id: me.id,
        project_id: project.id,
        task_id: null,
        session_id: null,
        kind: "approval",
        why: 'Intake for "Logo": 1 task.',
        steps: [],
        options: ["approve", "reject"],
        blocking: true,
        risk: "medium",
        change_card: {
          key: `intake:${project.id}`,
          project_id: project.id,
          proposal: {
            plan: {
              reason: "planned",
              milestones: [],
              tasks: [
                {
                  key: "logo",
                  title: "Draw the logo",
                  outcome: "logo.svg",
                  acceptanceCriteria: [],
                  specialist: "illustrator",
                },
                {
                  key: "page",
                  title: "Build the page",
                  outcome: "index.html",
                  acceptanceCriteria: [],
                  specialist: "Coder",
                },
              ],
            },
            docs: {},
            firstSession: { summary: "", items: [] },
          },
        },
        status: "open",
        answer: null,
      } as never);
      const card = (await client.inbox(me.id)).requests.find((r) => r.projectId === project.id);
      expect(card?.planTasks).toEqual([
        {
          key: "logo",
          title: "Draw the logo",
          specialist: null,
          unknown: "illustrator",
          // The plan's first session names no figure for it (leftovers7-session: each plan task
          // carries the figure the Start dialog will show; none here).
          estimateUsdMicro: null,
          runsOn: null,
        },
        // The plan's "Coder" is the registry's coder; on the API key alone nothing is said.
        {
          key: "page",
          title: "Build the page",
          specialist: "coder",
          unknown: null,
          estimateUsdMicro: null,
          runsOn: { kind: "api_key", line: null },
        },
      ]);
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("no credential saved while the daemon answers with the model it was started with: Settings is told so", async () => {
    const { rt, client } = await composeWithRolePlayer({});
    try {
      const view = await client.billingOrder();
      expect(view.sources).toEqual([]);
      expect(view.startedWith).toBe(rt.provider?.name);
      expect(view.startedWith).toBeTruthy();
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: a task that waits for unmerged work builds on it (C-49, ADR 0106)", () => {
  // Live (2026-11-02, forerunner-sandbox): the tester of a two-task plan branched from main
  // while the coder's pull request was still open, found nothing to check and failed. Here a
  // session on the stand-in model runs both tasks of a repository project on a local host.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let criticCalls: ModelRequest[] = [];
  let bare = "";
  const host = new MemoryGitHost("alice");
  const repo = { owner: "o", name: "chain" };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-chain-"));
    bare = join(home, "chain.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({
      cwd: join(home, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(home, "seed", "README.md"), "# chain\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ ...repo, private: true, cloneUrl: bare });
    ({ rt, client, criticCalls } = await composeWithRolePlayer(
      {},
      { gitHost: host, tryIt: false },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("B starts from A's open pull request; B's PR targets main and names A's; B's files and review are its own", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({
      name: "Chain",
      goal: "Notes and their summary",
      repos: ["o/chain"],
    });
    const a = await client.createTask(project.id, {
      title: "Write the notes in notes.md",
      outcome: "notes.md holds the meeting notes",
      riskTier: 1,
      specialist: "coder",
    });
    const b = await client.createTask(project.id, {
      title: "Write the summary in summary.md",
      outcome: "summary.md sums up the meeting in three lines",
      riskTier: 1,
      specialist: "coder",
      dependsOn: [a.id],
    });
    const statuses = async () =>
      (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, await statuses()).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      statuses,
      60_000,
    );
    expect(await statuses()).toBe(
      "Write the notes in notes.md=done, Write the summary in summary.md=done",
    );
    const taskA = await rt.store.task.mustGet(a.id);
    const taskB = await rt.store.task.mustGet(b.id);
    // B's branch holds A's file, which is not on main yet (level 2 merges nothing).
    const onBranch = await run([
      "git",
      "--git-dir",
      bare,
      "ls-tree",
      "-r",
      "--name-only",
      taskB.branch ?? "",
    ]);
    expect(onBranch.stdout.split(/\r?\n/)).toEqual(
      expect.arrayContaining(["notes.md", "summary.md"]),
    );
    const onMain = await run(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]);
    expect(onMain.stdout).not.toContain("notes.md");
    // B's pull request targets main and says it carries A's unmerged work, and how to merge
    // them (ADR 0111): never "Merge in any order".
    const open = await host.listPullRequests(repo, { state: "open" });
    const prA = open.find((p) => p.head.ref === taskA.branch);
    const prB = open.find((p) => p.head.ref === taskB.branch);
    expect(prB?.base.ref).toBe("main");
    expect(prB?.body).toContain(
      `Builds on #${prA?.number} (not merged yet): this pull request includes its changes. Merge #${prA?.number} first, or use Merge in Forerunner, which merges them in order.`,
    );
    expect(prB?.body).not.toMatch(/any order/i);
    // The Overview lists both as waiting for the person.
    const waiting = await client.projectPullRequests(project.id);
    expect(waiting.waiting.filter((w) => w.kind === "task").map((w) => w.number)).toEqual([
      prA?.number,
      prB?.number,
    ]);
    // The drawer's files for B are B's alone, and so is the diff the critic reviewed.
    const drawer = await client.task(b.id);
    expect(drawer.runs.filter((r) => r.kind === "work").flatMap((r) => r.files)).toEqual([
      "summary.md",
    ]);
    const reviewOfB = criticCalls
      .map((c) => JSON.stringify(c.messages))
      .filter((m) => m.includes("Write the summary in summary.md"));
    expect(reviewOfB.length).toBeGreaterThan(0);
    for (const m of reviewOfB) {
      expect(m).toContain("diff --git a/summary.md");
      expect(m).not.toContain("diff --git a/notes.md");
    }

    // C-57: no status pull request by default; the session's status is in the app, where the
    // Docs tab reads it, and Settings lists the switch for this repository project.
    expect(open.some((p) => p.head.ref === "fr/status")).toBe(false);
    expect(waiting.waiting.some((w) => w.branch === "fr/status")).toBe(false);
    const status = (await client.docs(project.id)).find((d) => d.path === "docs/status.md");
    expect(status).toMatchObject({
      exists: true,
      note: "kept in the app: no status pull request (Settings turns it on)",
    });
    expect((await client.doc(project.id, "docs/status.md")).content).toContain(
      `session ${sessionId}`,
    );
    const row = (await client.settings()).find(
      (s) => s.key === "project.status_pull_request" && s.scopeId === project.id,
    );
    expect(row).toMatchObject({ label: "Status pull request", value: false });
    const turnedOn = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: { key: "status_pull_request", value: true, project: project.id },
        },
      ],
      source: "ui",
    });
    expect(turnedOn.status).toBe("done");
    expect(
      (await client.settings()).find(
        (s) => s.key === "project.status_pull_request" && s.scopeId === project.id,
      )?.value,
    ).toBe(true);
  }, 120_000);

  it("a project made from a brief: after its session the Docs and Files tabs read the repository as merged, and a merge on the host shows after the next session (C-57)", async () => {
    // Review of fix/decisions (2026-11-02): with the status kept in the app, nothing made or
    // refreshed this computer's copy of the repository any more. A project made from a brief
    // (no scaffold, so no copy) read every doc but Status as "missing · not written yet",
    // although README.md was on main and the rest waited in the intake's PR, and Files said
    // "Nothing written yet"; after a merge on the host, the tabs still showed the old main.
    const briefRepo = { owner: "o", name: "brief" };
    const briefBare = join(bare, "..", "brief.git");
    await run(["git", "init", "--bare", "-b", "main", briefBare]);
    const seedDir = join(bare, "..", "brief-seed");
    const seedIdentity = { name: "Seed", email: "seed@example.test" };
    const seed = new GitOps({ cwd: seedDir, identity: seedIdentity });
    await seed.clone(briefBare);
    writeFileSync(join(seedDir, "README.md"), "# brief\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ ...briefRepo, private: true, cloneUrl: briefBare });
    const brief = "A page that shows a random quote";
    const project = await client.createProject({
      name: "Brief page",
      goal: goalFromBrief(brief),
      brief,
      intake: true,
      repos: ["o/brief"],
    });
    await rt.intake.inFlight(project.id);
    const me = await client.me();
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.projectId === project.id && r.status === "open",
    );
    expect(card?.title).toMatch(/^Plan for "Brief page"/);
    const planned = (await client.sessions({ projectId: project.id })).length;
    await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: "Approve and start",
    });
    const statuses = async () =>
      (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
    const sessionsEnded = async (count: number) => {
      const all = await client.sessions({ projectId: project.id });
      return all.length >= count && all.every((s) => s.status !== "running");
    };
    await eventually(
      () => sessionsEnded(planned + 1),
      "the session the approval started to end",
      statuses,
      60_000,
    );
    const intakePr = (await host.listPullRequests(briefRepo, { state: "open" })).find((p) =>
      /^fr\/intake-.+-docs$/.test(p.head.ref),
    );
    expect(intakePr, "the intake's docs pull request").toBeDefined();
    // README.md is on main; the intake's docs wait in its pull request; Status is in the app.
    const docs = await client.docs(project.id);
    expect(docs.find((d) => d.path === "README.md")).toMatchObject({
      exists: true,
      note: "from this PC's copy of the repository",
    });
    expect(docs.find((d) => d.path === "docs/overview.md")).toMatchObject({
      exists: false,
      note: `waiting in pull request #${intakePr?.number}: merge it to add it`,
    });
    expect(docs.find((d) => d.path === "docs/status.md")).toMatchObject({
      exists: true,
      note: "kept in the app: no status pull request (Settings turns it on)",
    });
    const files = await client.projectFiles(project.id);
    expect(files.folder).not.toBeNull();
    expect(files.entries.map((e) => e.path)).toContain("README.md");
    expect(files.entries.map((e) => e.path)).not.toContain("docs/overview.md");

    // The person merges the intake's pull request on the host; the next session's end brings
    // this computer's copy up to date, so the tabs read the merged docs. The merge commit is the
    // seed's, under its identity: CI's runners have none of their own (testenv/src/ci-env.ts).
    await seed.fetch();
    await run([
      "git",
      "-C",
      seedDir,
      "-c",
      `user.name=${seedIdentity.name}`,
      "-c",
      `user.email=${seedIdentity.email}`,
      "merge",
      "--no-ff",
      "-m",
      "Merge the doc set",
      `origin/${intakePr?.head.ref}`,
    ]);
    await seed.push("main");
    await host.mergePullRequest(briefRepo, intakePr?.number ?? 0);
    const agentId = (await client.agents())[0]?.id ?? "";
    await client.createTask(project.id, {
      title: "Write the credits in credits.md",
      outcome: "credits.md names where the quotes come from",
      riskTier: 1,
      specialist: "coder",
    });
    const before = (await client.sessions({ projectId: project.id })).length;
    const started = await client.startSession({ agentId, projectId: project.id });
    expect(started.session?.id, await statuses()).toBeDefined();
    await eventually(
      () => sessionsEnded(before + 1),
      "the second session to end",
      statuses,
      60_000,
    );
    const after = await client.docs(project.id);
    expect(after.find((d) => d.path === "docs/overview.md")).toMatchObject({
      exists: true,
      note: "from this PC's copy of the repository",
    });
    expect((await client.doc(project.id, "docs/overview.md")).content.length).toBeGreaterThan(0);
    expect((await client.projectFiles(project.id)).entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(["README.md", "docs/overview.md"]),
    );
    // Still no status pull request: the copy was refreshed without one.
    expect(
      (await host.listPullRequests(briefRepo, { state: "open" })).some(
        (p) => p.head.ref === "fr/status",
      ),
    ).toBe(false);
  }, 180_000);

  it("a second project on the same repository lists only its own docs pull requests, never the first one's scaffold (L-16)", async () => {
    // Live (2026-11-02): "The project's standard docs · pull request #1" on the Overview was a
    // scaffold PR an earlier project had left on forerunner-sandbox.
    const sharedBare = join(bare, "..", "shared.git");
    await run(["git", "init", "--bare", "-b", "main", sharedBare]);
    const seed = new GitOps({
      cwd: join(bare, "..", "shared-seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(sharedBare);
    writeFileSync(join(bare, "..", "shared-seed", "README.md"), "# shared\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name: "shared", private: true, cloneUrl: sharedBare });
    const first = await client.createProject({
      name: "Shared one",
      goal: "A page in a shared repository",
      repos: ["o/shared"],
    });
    const firstDocs = (await client.projectPullRequests(first.id)).waiting.filter(
      (w) => w.kind === "docs",
    );
    expect(firstDocs.map((w) => w.branch)).toEqual(["fr/docs-scaffold"]);
    const second = await client.createProject({
      name: "Shared two",
      goal: "More notes in the same repository",
      repos: ["o/shared"],
    });
    const listed = await client.projectPullRequests(second.id);
    expect(listed.waiting.filter((w) => w.kind === "docs")).toEqual([]);
    // Its Docs tab does not say its docs wait in the first project's pull request.
    for (const d of await client.docs(second.id))
      expect(d.note ?? "", d.path).not.toMatch(/waiting in pull request/);
  }, 120_000);
});

describe("the UI client against the real daemon: a budget stop is a clean pause (budget-stop, ADR 0112)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let criticCalls: ModelRequest[];

  beforeAll(async () => {
    // The stand-in writes the guide one part per call until it hears the wrap-up.
    ({ rt, client, criticCalls } = await composeWithRolePlayer({
      FORERUNNER_BENCH_LONG: "Write the guide",
    }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a task whose budget is a few times its run's reserve hears the wrap-up and pauses: its words say so, no critic reviews it, its report is kept", async () => {
    const project = await client.createProject({ name: "Budget pause", goal: "A guide" });
    // What New task sends with a budget of CHF 0.036 (USD 0.045): about three times the reserve
    // of two stand-in calls its run's budget line names.
    const created = await client.createTask(project.id, {
      title: "Write the guide",
      outcome: "guide.md explains the club",
      acceptanceCriteria: ["guide.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 45_000,
      specialist: "coder",
      riskTier: 1,
    });
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, JSON.stringify(started)).toBeTruthy();
    await eventually(
      async () =>
        !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
      "the session to end",
      async () => {
        const s = await client.session(sessionId);
        return `${s.status}: ${s.summary ?? ""}`;
      },
      20_000,
    );
    // The run's own lines: its budget line with the reserve, the wrap-up.
    const lines = (await client.sessionEvents(sessionId)).map((e) => e.text);
    expect(
      lines.some((l) =>
        /^This run may spend CHF [\d.]+: at CHF [\d.]+ it is told to wrap up, keeping a reserve of CHF [\d.]+ to finish\.$/.test(
          l,
        ),
      ),
      lines.join(" | "),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith("Told the coder to wrap up"))).toBe(true);
    // The task's words say paused, with its card to open.
    const view = (await client.tasks(project.id)).find((t) => t.id === created.id);
    expect(view?.status).toBe("needs_human");
    expect(view?.display).toMatchObject({
      key: "answer",
      label: "Paused at its budget",
      blocker: { kind: "card", cardKind: "budget" },
    });
    // No critic call for it, and no try counted.
    expect(criticCalls.filter((c) => (c.origin?.label ?? "").includes(created.id))).toEqual([]);
    expect(view?.attempt).toBe(0);
    // Its run's report is kept, with the two headings (the drawer's run).
    const detail = await client.task(created.id);
    const work = detail.runs.filter((r) => r.kind === "work");
    expect(work).toHaveLength(1);
    expect(work[0]?.outcome).toBe("Paused");
    const report = `${work[0]?.report ?? ""}\n${work[0]?.fullReport ?? ""}`;
    expect(report).toContain("Where I stopped:");
    expect(report).toContain("Left to do:");
  }, 60_000);
});

describe("the UI client against the real daemon: a session ended at this month's cap names it (review of budget-stop)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    // The stand-in writes the guide one part per call until it hears the wrap-up, so the
    // month's cap stops it long before its own budget's line.
    ({ rt, client } = await composeWithRolePlayer({ FORERUNNER_BENCH_LONG: "Write the guide" }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the session page, its result, its log and the Inbox Update say this month's cap, not the session's budget", async () => {
    // As Settings sends a lowered monthly cap (it applies at once).
    const lowered = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 0.02 } }],
      source: "ui",
      confirm: "tap",
    });
    expect(lowered.status, JSON.stringify(lowered)).toBe("done");
    const project = await client.createProject({ name: "Month cap", goal: "A guide" });
    // What New task sends with a budget of CHF 1.00: far above what is left this month.
    await client.createTask(project.id, {
      title: "Write the guide",
      outcome: "guide.md explains the club",
      acceptanceCriteria: ["guide.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 1_250_000,
      specialist: "coder",
      riskTier: 1,
    });
    const me = await client.me();
    const agentId = (await client.agents())[0]?.id ?? "";
    // A start without a typed budget (a budget card's Raise, the chat, a schedule).
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, JSON.stringify(started)).toBeTruthy();
    await eventually(
      async () =>
        !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
      "the session to end",
      async () => {
        const s = await client.session(sessionId);
        return `${s.status}: ${s.summary ?? ""}`;
      },
      20_000,
    );
    const session = await client.session(sessionId);
    // Before: "Stopped: the budget is used" and "The session's budget is used." at 1% of the
    // session's own CHF 5.00.
    expect(session.statusText).toBe("Stopped at this month's cap");
    expect(session.summary ?? "").toContain("Stopped at this month's cap of CHF 0.02.");
    expect(session.summary ?? "").not.toMatch(/budget is used/);
    const lines = (await client.sessionEvents(sessionId)).map((e) => e.text);
    expect(
      lines.some((l) => /^Stopped at this month's cap: /.test(l)),
      lines.join(" | "),
    ).toBe(true);
    expect(lines.join(" | ")).not.toMatch(/budget is used/);
    const updates = (await client.inbox(me.id)).messages
      .filter((m) => m.projectId === project.id)
      .map((m) => m.body);
    expect(updates.join(" | ")).toContain("Stopped at this month's cap of CHF 0.02.");
    expect(updates.join(" | ")).not.toMatch(/budget is used/);
  }, 60_000);
});

describe("the UI client against the real daemon: a Claude credential at its limit (credential-limits, U-078)", () => {
  // Credential-shaped fixtures, built by concatenation so no scanner sees a token.
  const oauth = ["sk-ant-oat01-", "credlimit", "8".repeat(40)].join(""); // not-a-secret
  const apiKey = ["sk-ant-api03-", "credlimit", "9".repeat(40)].join(""); // not-a-secret
  const resetAt = "2026-03-05T10:40:00.000Z";

  /** Claude Code at the plan's limit on its first `limited` turns, then answering. */
  const claudeCode =
    (calls: string[], limited: number): NonNullable<ComposeOptions["sdkQuery"]> =>
    ({ prompt }) => {
      calls.push(prompt);
      const atLimit = calls.length <= limited;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk" };
        if (atLimit) {
          yield {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", resetsAt: Date.parse(resetAt) / 1000 },
          };
          yield {
            type: "assistant",
            error: "rate_limit",
            message: { content: [{ type: "text", text: "You've hit your limit" }] },
          };
          yield { type: "result", subtype: "success", is_error: true, result: "limit" };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: `m${calls.length}`,
            content: [{ type: "text", text: "Wrote it. Lesson: none." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "Wrote it." };
      })();
    };

  async function compose(sdkQuery: NonNullable<ComposeOptions["sdkQuery"]>) {
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-cred-"));
    const onKey = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ anthropic_subscription_token: oauth, anthropic_api_key: apiKey }),
      provider: new AcceptingCriticProvider(onKey),
      sdkQuery,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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
    return { rt, client, clock, onKey };
  }

  const addTask = (client: DaemonClient, projectId: string, title: string) =>
    client.createTask(projectId, {
      title,
      outcome: `${title} is written`,
      acceptanceCriteria: ["it is written"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "coder",
      riskTier: 0,
    });

  async function runToEnd(client: DaemonClient, projectId: string): Promise<string> {
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId });
    const sessionId = started.session?.id ?? "";
    await eventually(
      async () =>
        !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
      "the session to end",
      async () => (await client.session(sessionId)).status,
      20_000,
    );
    return sessionId;
  }

  /** A model call of a task's run (the critic's reviews are not). */
  const workCalls = (onKey: ScriptedProvider) =>
    onKey.calls.filter((c) => !(c.tools ?? []).some((t) => t.name === "submit_review"));

  it("under the default 'Wait': the tasks wait (none on the API key), the screens say until when, and the start at the reset runs them", async () => {
    const sdkCalls: string[] = [];
    const { rt, client, clock, onKey } = await compose(claudeCode(sdkCalls, 1));
    try {
      // Settings lists the setting, at its default.
      const row = (await client.settings()).find((s) => s.key === "human.mid_session_limit");
      expect(row?.value).toBe("wait");
      expect(row?.label).toBe("When my first choice runs out mid-session");
      const project = await client.createProject({ name: "Waits", goal: "Two notes" });
      await addTask(client, project.id, "Write note A");
      await addTask(client, project.id, "Write note B");
      const sessionId = await runToEnd(client, project.id);
      const session = await client.session(sessionId);
      // 10:40 UTC is 11:40 in Zurich. One sentence, no failed task.
      expect(session.summary?.split("\n")[0]).toBe(
        "Waits until 11:40 (your subscription's limit) and starts by itself.",
      );
      const tasks = await client.tasks(project.id);
      expect(tasks.map((t) => [t.status, t.display?.label])).toEqual([
        ["ready", "Waits until 11:40, your subscription's limit"],
        ["ready", "Waits until 11:40, your subscription's limit"],
      ]);
      // 'Wait': nothing moved onto the API key.
      expect(workCalls(onKey)).toHaveLength(0);
      expect(sdkCalls).toHaveLength(1);
      const order = await client.billingOrder();
      expect(order.sources.find((s) => s.kind === "subscription")).toMatchObject({
        usable: false,
        blocked: "resting",
        restingUntil: resetAt,
      });
      // No card: a limit asks nothing of the person.
      const me = await client.me();
      expect((await client.inbox(me.id)).requests.filter((r) => r.status === "open")).toEqual([]);
      // At the reset the scheduler starts the project's session by itself.
      clock.set(Date.parse("2026-03-05T10:41:00Z"));
      await rt.scheduler.tick();
      await eventually(
        async () => (await client.tasks(project.id)).every((t) => t.status === "done"),
        "the tasks the reset's session ran",
        async () => (await client.tasks(project.id)).map((t) => t.status).join(", "),
        20_000,
      );
      expect(workCalls(onKey)).toHaveLength(0);
      const sessions = await client.sessions({ projectId: project.id });
      expect(sessions.map((s) => s.trigger).sort()).toEqual(["budget_reset", "manual"]);
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("Settings' 'Use the other one' is stored after a yes, and the stopped task goes on at once on the API key", async () => {
    const { rt, client } = await compose(claudeCode([], 99));
    try {
      // What the Settings dialog sends; moving plan-limit work onto money asks a yes first.
      const asked = await client.executeCommands({
        commands: [
          { name: "settings.set", params: { key: "mid_session_limit", value: "use_other" } },
        ],
        wordsUsed:
          "Settings: When my first choice runs out mid-session to Use the other one at once (may cost money)",
        source: "ui",
      });
      expect(asked.status, JSON.stringify(asked)).toBe("pending");
      const yes = await client.confirmCommand(asked.pendingId ?? "", { answer: "yes" });
      expect(yes.status, JSON.stringify(yes)).toBe("done");
      expect(
        (await client.settings()).find((s) => s.key === "human.mid_session_limit")?.value,
      ).toBe("use_other");
      const project = await client.createProject({ name: "Other", goal: "A note" });
      await addTask(client, project.id, "Write the note");
      const sessionId = await runToEnd(client, project.id);
      expect((await client.tasks(project.id)).map((t) => t.status)).toEqual(["done"]);
      const lines = (await client.sessionEvents(sessionId)).map((e) => e.text);
      expect(lines).toContain(
        'Your Claude subscription reached its usage limit; "Write the note" continues on your API key now.',
      );
    } finally {
      await rt.close();
    }
  }, 120_000);

  /** Claude Code refusing the sign-in (an expired token's 401) on every turn. */
  const refusedSignIn =
    (calls: string[]): NonNullable<ComposeOptions["sdkQuery"]> =>
    ({ prompt }) => {
      calls.push(prompt);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk" };
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
        };
      })();
    };

  it("a refused Claude sign-in under the default 'Wait': the task waits for a new sign-in (nothing on the API key); under 'use the other one' the card says the API key costs money (U-078)", async () => {
    const sdkCalls: string[] = [];
    const { rt, client, onKey } = await compose(refusedSignIn(sdkCalls));
    try {
      const project = await client.createProject({ name: "Sign-in", goal: "A note" });
      await addTask(client, project.id, "Write the note");
      const sessionId = await runToEnd(client, project.id);
      // Before: '"Write the note" continues on your API key now.' (money under 'Wait').
      expect((await client.session(sessionId)).summary?.split("\n")[0]).toBe(
        "Waits for a new Claude sign-in: save one in Settings.",
      );
      expect((await client.tasks(project.id)).map((t) => [t.status, t.display?.label])).toEqual([
        ["ready", "Waits for a new Claude sign-in"],
      ]);
      expect(workCalls(onKey)).toHaveLength(0);
      const me = await client.me();
      const card = (await client.inbox(me.id)).requests.find(
        (r) => r.status === "open" && r.title === "Anthropic refused your Claude sign-in",
      );
      expect(card?.body).toBe(
        "Save a new one in Settings. The work that needs it waits and starts by itself then.",
      );
      // "Use the other one", as Settings sends it (a yes): the card says where the tasks go on,
      // and what it costs, and the next session runs the task on the API key.
      const asked = await client.executeCommands({
        commands: [
          { name: "settings.set", params: { key: "mid_session_limit", value: "use_other" } },
        ],
        wordsUsed:
          "Settings: When my first choice runs out mid-session to Use the other one at once (may cost money)",
        source: "ui",
      });
      await client.confirmCommand(asked.pendingId ?? "", { answer: "yes" });
      const moved = (await client.inbox(me.id)).requests.find((r) => r.id === card?.id);
      expect(moved?.body).toBe(
        "Save a new one in Settings. Until then your tasks go on with your API key, which costs money.",
      );
      await runToEnd(client, project.id);
      expect((await client.tasks(project.id)).map((t) => t.status)).toEqual(["done"]);
      expect(workCalls(onKey).length).toBeGreaterThan(0);
    } finally {
      await rt.close();
    }
  }, 120_000);

  it("a refused API key: one card with where to save a new one, planning and tasks wait (none failed), Settings says Refused, and the key saved in the setup assistant starts both by itself", async () => {
    // As `fr daemon` composes it, with no injected provider: the routed provider over the
    // vault's key calls the Messages API stand-in, which answers a key holding "refused" with
    // 401; the bench's role-player is the model behind it once a key serves.
    const refused = ["sk-ant-api03-", "refused", "7".repeat(40)].join(""); // not-a-secret
    const good = ["sk-ant-api03-", "good", "6".repeat(40)].join(""); // not-a-secret
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-refused-"));
    const model = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    const standIn = messagesApiStandIn({
      model,
      clock,
      answerFor: keyRule({ refuse: ["refused"] }),
    });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ anthropic_api_key: refused }),
      fetchImpl: standInFetch(standIn, {
        fallback: async () => new Response("not here", { status: 404 }),
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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
    const calls = () => standIn.requests.filter((r) => r.path === "/v1/messages");
    try {
      const me = await client.me();
      // New project with a brief (the dialog's body): planning meets the refusal and waits.
      const planned = await client.createProject({
        name: "Quotes",
        goal: goalFromBrief("A page that shows a random quote."),
        brief: "A page that shows a random quote.",
        intake: true,
      });
      await eventually(
        async () => (await client.intakeStatus(planned.id)).state === "waiting",
        "the planning to wait for a new key",
        async () => JSON.stringify(await client.intakeStatus(planned.id)),
        20_000,
      );
      const plan = await client.intakeStatus(planned.id);
      expect(plan.error).toBeNull();
      expect(plan.wait).toMatchObject({
        reason: "refused",
        text: "Planning waits for a new API key: save one in Settings.",
        save: { label: "Save a new key", to: "/setup" },
      });
      expect((await client.project(planned.id)).statusLine).toEqual({
        kind: "waiting",
        text: "Planning waits for a new API key",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });
      // The Start dialog names the wait with the same link, never "add a task".
      expect((await client.startCheck(planned.id)).blocked).toEqual({
        kind: "nothing_runnable",
        sentence: "Nothing can run yet. Planning waits for a new API key: save one in Settings.",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });

      // A project with two tasks: its session meets the mark, not the API, and ends on one
      // sentence; the rows wait, none failed.
      const notes = await client.createProject({ name: "Notes", goal: "Two notes" });
      await addTask(client, notes.id, "Write note A");
      await addTask(client, notes.id, "Write note B");
      const sessionId = await runToEnd(client, notes.id);
      expect((await client.session(sessionId)).summary?.split("\n")[0]).toBe(
        "Waits for a new API key: save one in Settings.",
      );
      expect((await client.tasks(notes.id)).map((t) => [t.status, t.display?.label])).toEqual([
        ["ready", "Waits for a new API key"],
        ["ready", "Waits for a new API key"],
      ]);
      expect((await client.project(notes.id)).statusLine).toEqual({
        kind: "waiting",
        text: "Waiting for a new API key: 2 tasks",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });
      // One request reached Anthropic, and was refused.
      expect(calls().map((c) => c.status)).toEqual([401]);

      // The Inbox: exactly one card, with nothing to answer and the link to the setup assistant.
      const open = (await client.inbox(me.id)).requests.filter((r) => r.status === "open");
      expect(open.map((r) => r.title)).toEqual(["Anthropic refused your API key"]);
      expect(open[0]?.choices ?? []).toEqual([]);
      expect(open[0]?.links?.map((l) => [l.label, l.to])).toEqual([["Save a new key", "/setup"]]);
      // Settings -> Claude: which to use first.
      expect((await client.billingOrder()).sources.map((s) => [s.kind, s.blocked])).toEqual([
        ["api_key", "refused"],
      ]);

      // The setup assistant saves a new key: the mark and the card go, the tasks' session starts
      // by itself, and the plan is drafted on the next tick (a planning call would hold the
      // agent's one session while the tasks' start is made).
      const saved = await client.setupAnthropic(good);
      expect(saved.ok).toBe(true);
      expect((await client.billingOrder()).sources.map((s) => s.blocked)).toEqual([null]);
      const answered = (await client.inbox(me.id)).requests.find(
        (r) => r.title === "Anthropic refused your API key",
      );
      expect(answered?.status).not.toBe("open");
      expect(answered?.outcome).toBe("A new one is saved; the work that waited for it goes on.");
      await eventually(
        async () => (await client.tasks(notes.id)).every((t) => t.status === "done"),
        "the tasks that waited to finish",
        async () => (await client.tasks(notes.id)).map((t) => t.status).join(", "),
        30_000,
      );
      expect((await client.sessions({ projectId: notes.id })).map((s) => s.trigger).sort()).toEqual(
        ["budget_reset", "manual"],
      );
      await rt.scheduler.tick();
      await eventually(
        async () => (await client.intakeStatus(planned.id)).state === "pending",
        "the plan to be drafted after the new key",
        async () => JSON.stringify(await client.intakeStatus(planned.id)),
        30_000,
      );
      expect((await client.project(planned.id)).statusLine?.text).toBe(
        "Waiting for you: approve the plan",
      );
      // Every call after the refusal went with the new key, and none was refused.
      expect(
        calls()
          .slice(1)
          .every((c) => c.status === 200),
      ).toBe(true);
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: Merge in the app (merge-in-app, U-028)", () => {
  // The owner's decision of 2026-11-02: "you press Merge" by default, with a one-click Merge in
  // the app that merges in dependency order, merge commits only, through the safe merge step.
  // Before, no daemon route merged: the Overview's list linked each PR to GitHub. Real git on
  // the testenv fake GitHub (its REST API and git smart HTTP) behind the daemon's GitHub client.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let token = "";
  let work = "";
  const FULL = "alice/app";
  const REPO = { owner: "alice", name: "app" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fr-ui-real-merge-"));
    const clock = new SystemClock();
    host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "app",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# app\n" },
    });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, token);
    ({ rt, client } = await composeWithRolePlayer(
      {},
      {
        gitHost: new GitHubHost({ token, baseUrl: host.baseUrl, clock }),
        vault,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl: "sqlite::memory:",
        },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** A done task with its pull request on the host, as a session leaves it (`from`: what it builds on). */
  async function doneTask(
    projectId: string,
    title: string,
    file: string,
    opts: { from?: string; dependsOn?: string[]; record?: boolean } = {},
  ) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: opts.dependsOn ?? [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    const dir = join(work, `wt-${task.id}`);
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(FULL));
    const branch = `fr/${file.replace(/\W+/g, "-")}`;
    await git.createBranch(branch, opts.from ? `origin/${opts.from}` : "origin/main");
    writeFileSync(join(dir, file), `export const f = "${file}";\n`);
    await git.commitAll(`Add ${file}`);
    await git.push(branch);
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
    const pr = await github.createPullRequest(REPO, {
      title,
      body: "",
      head: branch,
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
    if (opts.record !== false)
      await rt.store.mergeRecord.pin({
        task_id: task.id,
        project_id: projectId,
        agent_id: rt.agent.id,
        pr_number: pr.number,
        pr_url: pr.htmlUrl,
        reviewed_head_sha: pr.head.sha,
        author_agent: rt.agent.id,
      });
    return { task, pr, branch };
  }

  const hostGit = async (...args: string[]) =>
    (await run(["git", "--git-dir", host.repo(FULL)?.dir ?? "", ...args])).stdout.trim();
  const forced = () => host.events().filter((e) => e.event === "push" && e.payload.forced === true);
  const checkRun = async (
    sha: string,
    status: "in_progress" | "completed",
    conclusion?: string,
  ) => {
    const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ci/test",
        head_sha: sha,
        status,
        ...(conclusion ? { conclusion } : {}),
      }),
    });
    expect(res.status).toBe(201);
  };

  it("Merge on the dependent PR of a chain is answered at once and merges both in order, each a merge commit with two parents, no force-push; GET lists none after", async () => {
    const project = await client.createProject({ name: "Chain", goal: "A page", repos: [FULL] });
    const view0 = await client.projectPullRequests(project.id);
    expect(view0.mode).toEqual({ key: "you", label: "You press Merge" });
    const a = await doneTask(project.id, "Add the page", "page.ts");
    const b = await doneTask(project.id, "Add the footer", "footer.ts", {
      from: a.branch,
      dependsOn: [a.task.id],
    });
    // The task rows say the work is accepted and not in main yet (before: "Done").
    const labels = async () =>
      (await client.tasks(project.id))
        .filter((t) => t.id === a.task.id || t.id === b.task.id)
        .map((t) => t.display?.label);
    expect(await labels()).toEqual([
      "Accepted · waiting for you to merge",
      "Accepted · waiting for you to merge",
    ]);
    const before = await client.projectPullRequests(project.id);
    const rowB = before.waiting.find((w) => w.number === b.pr.number);
    expect(rowB?.merge).toEqual({
      state: "ready",
      canMerge: true,
      sentence: null,
      first: [a.pr.number],
    });
    const answer = await client.mergePullRequest(project.id, b.pr.number);
    expect(answer).toEqual({
      state: "queued",
      sentence: `Merging #${a.pr.number} and #${b.pr.number} in order.`,
      order: [a.pr.number, b.pr.number],
    });
    const states = async () =>
      JSON.stringify(
        (await client.projectPullRequests(project.id)).waiting.map((w) => [
          w.number,
          w.merge?.state,
        ]),
      );
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(b.task.id))?.state === "merged",
      "both pull requests to be merged",
      states,
      30_000,
    );
    expect(
      (await client.projectPullRequests(project.id)).waiting.filter((w) => w.kind === "task"),
    ).toEqual([]);
    expect(await labels()).toEqual(["Merged", "Merged"]);
    expect((await client.task(b.task.id)).task.display?.label).toBe("Merged");
    const recordA = await rt.store.mergeRecord.forTask(a.task.id);
    const recordB = await rt.store.mergeRecord.forTask(b.task.id);
    expect(recordA).toMatchObject({
      state: "merged",
      method: "merge",
      approval: "person",
      approved_by: rt.human.id,
    });
    expect(recordB).toMatchObject({ state: "merged", method: "merge", approval: "person" });
    // In order: A's merge commit is the first parent of B's; each has two parents.
    const parentsOf = async (sha: string) =>
      (await hostGit("rev-list", "--parents", "-n", "1", sha)).split(" ").slice(1);
    expect(await parentsOf(recordA?.merge_sha ?? "")).toEqual([expect.any(String), a.pr.head.sha]);
    expect(await parentsOf(recordB?.merge_sha ?? "")).toEqual([recordA?.merge_sha, b.pr.head.sha]);
    expect(forced()).toEqual([]);
    // The audit rows name the person's click as the approval.
    const rows = (await rt.store.auditLog.list({ tool: "merge_pr" } as never)).filter((r) =>
      r.input_summary.includes(`the person ${rt.human.id}`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.allowed)).toBe(true);
  }, 120_000);

  it("a Merge whose checks still run is answered at once and waits on the record; the watcher's retry merges it once they pass, with no session", async () => {
    const project = await client.createProject({ name: "Checks", goal: "A page", repos: [FULL] });
    const c = await doneTask(project.id, "Add the notes", "notes.ts");
    await checkRun(c.pr.head.sha, "in_progress");
    const answer = await client.mergePullRequest(project.id, c.pr.number);
    expect(answer).toMatchObject({ state: "queued", sentence: `Merging #${c.pr.number}.` });
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(c.task.id))?.state === "waiting_checks",
      "the record to wait for its checks",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(c.task.id)),
      30_000,
    );
    const row = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.number === c.pr.number,
    );
    expect(row?.merge).toMatchObject({
      state: "waiting_checks",
      canMerge: false,
      sentence: `#${c.pr.number} merges when its checks pass.`,
    });
    expect((await client.task(c.task.id)).task.display?.label).toBe(
      "Accepted · merges when its checks pass",
    );
    await checkRun(c.pr.head.sha, "completed", "success");
    await rt.merge.retryWaiting();
    expect((await rt.store.mergeRecord.forTask(c.task.id))?.state).toBe("merged");
    expect(
      (await client.projectPullRequests(project.id)).waiting.filter((w) => w.kind === "task"),
    ).toEqual([]);
  }, 120_000);

  it("a Merge on a chain whose first PR's checks still run: the one after it says it waits its turn (no row and no task in flight), and both merge in order once the checks pass", async () => {
    // Review (2026-11-08, bench W2 and W4): the dependent said "Merging…" on the Overview and
    // "Accepted · merging" on the Tasks tab for as long as the first one's checks ran (up to a
    // day), and the Overview read the list every 1.5 s all that time.
    const project = await client.createProject({ name: "Waits", goal: "A page", repos: [FULL] });
    const a = await doneTask(project.id, "Add the menu", "menu.ts");
    const b = await doneTask(project.id, "Add the menu test", "menu-test.ts", {
      from: a.branch,
      dependsOn: [a.task.id],
    });
    await checkRun(a.pr.head.sha, "in_progress");
    const answer = await client.mergePullRequest(project.id, b.pr.number);
    expect(answer).toMatchObject({ state: "queued", order: [a.pr.number, b.pr.number] });
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(a.task.id))?.state === "waiting_checks",
      "the first record to wait for its checks",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(a.task.id)),
      30_000,
    );
    await rt.pullRequests.idle();
    const view = await client.projectPullRequests(project.id);
    const rowOf = (n: number) => view.waiting.find((w) => w.number === n)?.merge;
    expect(rowOf(a.pr.number)).toEqual({
      state: "waiting_checks",
      canMerge: false,
      sentence: `#${a.pr.number} merges when its checks pass.`,
      first: [],
    });
    expect(rowOf(b.pr.number)).toEqual({
      state: "waiting_checks",
      canMerge: false,
      sentence: `#${b.pr.number} merges after #${a.pr.number}, once #${a.pr.number}'s checks pass.`,
      first: [a.pr.number],
    });
    // The Tasks rows say the same, not "merging".
    const displayOf = async (id: string) => (await client.task(id)).task.display;
    expect((await displayOf(a.task.id))?.label).toBe("Accepted · merges when its checks pass");
    expect(await displayOf(b.task.id)).toMatchObject({
      label: `Accepted · merges after #${a.pr.number}`,
      detail: `#${b.pr.number} merges after #${a.pr.number}, once #${a.pr.number}'s checks pass.`,
    });
    await checkRun(a.pr.head.sha, "completed", "success");
    await rt.merge.retryWaiting();
    const [ra, rb] = [
      await rt.store.mergeRecord.forTask(a.task.id),
      await rt.store.mergeRecord.forTask(b.task.id),
    ];
    expect([ra?.state, rb?.state]).toEqual(["merged", "merged"]);
    expect((await displayOf(b.task.id))?.label).toBe("Merged");
    expect(
      (await client.projectPullRequests(project.id)).waiting.filter((w) => w.kind === "task"),
    ).toEqual([]);
  }, 120_000);

  it("a pull request with no record merges as it is on GitHub now, and the answer says so", async () => {
    const project = await client.createProject({ name: "Old", goal: "A page", repos: [FULL] });
    const d = await doneTask(project.id, "Add the about page", "about.ts", { record: false });
    const answer = await client.mergePullRequest(project.id, d.pr.number);
    expect(answer).toEqual({
      state: "queued",
      sentence: `Merging #${d.pr.number} as it is on GitHub now.`,
      order: [d.pr.number],
    });
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(d.task.id))?.state === "merged",
      "the pull request to be merged",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(d.task.id)),
      30_000,
    );
    expect(
      (await client.projectPullRequests(project.id)).waiting.filter((w) => w.kind === "task"),
    ).toEqual([]);
    expect(await rt.store.mergeRecord.forTask(d.task.id)).toMatchObject({
      state: "merged",
      approval: "person",
      reviewed_head_sha: d.pr.head.sha,
    });
  }, 120_000);

  it("a branch rule that needs an approving review: the row says so instead of Merge, the click is refused with the sentence, and nothing merges", async () => {
    const project = await client.createProject({ name: "Rules", goal: "A page", repos: [FULL] });
    const e = await doneTask(project.id, "Add the contact page", "contact.ts");
    host.setBranchProtection(FULL, "main", {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: false },
    });
    try {
      const sentence =
        "This repository needs an approving review before merging, and GitHub does not let you approve your own pull request: merge it on GitHub once someone else approved it.";
      const row = (await client.projectPullRequests(project.id)).waiting.find(
        (w) => w.number === e.pr.number,
      );
      expect(row?.merge).toEqual({ state: "blocked", canMerge: false, sentence, first: [] });
      expect(await client.mergePullRequest(project.id, e.pr.number)).toEqual({
        state: "refused",
        sentence,
        order: [],
      });
      expect((await rt.store.mergeRecord.forTask(e.task.id))?.state).toBe("queued");
      const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
      expect((await github.getPullRequest(REPO, e.pr.number)).merged).toBe(false);
    } finally {
      host.setBranchProtection(FULL, "main", null);
    }
  }, 120_000);

  it("Forerunner's docs pull request merges on the click, as it is on GitHub now", async () => {
    // The scaffold's docs pull request of a project on this repository (the first one opened it).
    let project = { id: "" };
    let docs:
      | Awaited<ReturnType<DaemonClient["projectPullRequests"]>>["waiting"][number]
      | undefined;
    for (const p of await client.projects()) {
      docs = (await client.projectPullRequests(p.id)).waiting.find((w) => w.kind === "docs");
      if (docs) {
        project = p;
        break;
      }
    }
    expect(docs?.merge).toEqual({ state: "ready", canMerge: true, sentence: null, first: [] });
    const answer = await client.mergePullRequest(project.id, docs?.number ?? 0);
    expect(answer).toEqual({
      state: "queued",
      sentence: `Merging #${docs?.number} as it is on GitHub now.`,
      order: [docs?.number],
    });
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
    await eventually(
      async () => (await github.getPullRequest(REPO, docs?.number ?? 0)).merged,
      "the docs pull request to be merged",
      async () => JSON.stringify((await client.projectPullRequests(project.id)).waiting),
      30_000,
    );
    // A merge commit, with the person's click in the audit row.
    const pr = await github.getPullRequest(REPO, docs?.number ?? 0);
    expect(
      (await hostGit("rev-list", "--parents", "-n", "1", pr.mergeCommitSha ?? "")).split(" "),
    ).toHaveLength(3);
  }, 120_000);

  it("the merge mode is a setting per repository project: 'Merge automatically after review' asks a yes and the GET says the mode", async () => {
    const project = await client.createProject({ name: "Auto", goal: "A page", repos: [FULL] });
    const row = (await client.settings()).find(
      (s) => s.key === "project.merge_mode" && s.scopeId === project.id,
    );
    expect(row).toMatchObject({ label: "Who merges accepted work", value: "you" });
    const asked = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: { key: "merge_mode", value: "after_review", project: project.id },
        },
      ],
      source: "ui",
    });
    // Automatic merges are a yes first, and the card says what they mean.
    expect(asked.status, JSON.stringify(asked)).toBe("pending");
    expect(JSON.stringify(asked.card)).toContain("Merges show under your GitHub name");
    const yes = await client.confirmCommand(asked.pendingId ?? "", { answer: "yes" });
    expect(yes.status, JSON.stringify(yes)).toBe("done");
    expect((await client.projectPullRequests(project.id)).mode).toEqual({
      key: "after_review",
      label: "Merge automatically after review",
    });
  }, 120_000);

  it("Merge in the app on Forerunner's docs pull request: Files lists the docs right after, with no watcher poll and no session (merge-in-app with merged-copy)", async () => {
    // A docs pull request has no task, so the merge step's onMerged, which brings the copy along
    // after a task's merge, does not fire for it. Before this wiring (the merge of wave 9), Files
    // showed docs merged with the app's Merge only at the watcher's next poll (a minute by default).
    await host.createRepo({
      owner: "alice",
      name: "inapp",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# inapp\n" },
    });
    const project = await client.createProject({
      name: "In app",
      goal: "Docs merged with the app's Merge",
      repos: ["alice/inapp"],
    });
    const paths = async () => (await client.projectFiles(project.id)).entries.map((e) => e.path);
    expect(await paths()).not.toContain("docs/overview.md");
    const docs = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.kind === "docs",
    );
    expect(docs?.merge).toMatchObject({ canMerge: true });
    const answer = await client.mergePullRequest(project.id, docs?.number ?? 0);
    expect(answer).toMatchObject({ state: "queued", order: [docs?.number] });
    await eventually(
      async () => (await paths()).includes("docs/overview.md"),
      "Files to list the docs merged with the app's Merge",
      async () => JSON.stringify(await paths()),
      15_000,
    );
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
    expect(
      (await github.getPullRequest({ owner: "alice", name: "inapp" }, docs?.number ?? 0)).merged,
    ).toBe(true);
    expect(await client.sessions({ projectId: project.id })).toEqual([]);
  }, 120_000);
});

describe("the UI client against the real daemon: this computer's copy follows every merge (merged-copy, ADR 0113)", () => {
  // The owner's decision of 2026-11-02: a repository project's copy on this computer refreshes
  // after every merge, in the app or on GitHub, so Files and Open folder show the merged work.
  // Before (bench, 2026-11-03): a pull request merged on the git host stayed out of Files until
  // a session ended, and a project made from a brief had no copy at all until then (W6-25).
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let github: GitHubHost;
  let token = "";
  let home = "";
  let criticCalls: ModelRequest[] = [];
  let specialistCalls: ModelRequest[] = [];
  const identity = { name: "Alice", email: "alice@example.test" };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-ui-real-copy-"));
    host = await FakeGitHost.start({ rootDir: join(home, "host") });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    for (const name of ["copy", "brief", "local", "taken"])
      await host.createRepo({
        owner: "alice",
        name,
        private: true,
        defaultBranch: "main",
        initialFiles: { "README.md": `# ${name}\n` },
      });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
    const vault = new MemoryVault();
    await vault.set("github_token", token);
    // The watcher's poll is driven by the case (pollOnce), never by the clock.
    ({ rt, client, criticCalls, specialistCalls } = await composeWithRolePlayer(
      {},
      {
        gitHost: github,
        vault,
        tryIt: false,
        githostWatch: { enabled: true, pollMs: 86_400_000 },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** A pull request of the person's own, opened and merged on the host (not through the app). */
  const mergeOnHost = async (name: string, branch: string, file: string, text: string) => {
    const dir = join(home, `person-${branch.replace(/\W+/g, "-")}`);
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(`alice/${name}`));
    await git.createBranch(branch, "origin/main");
    const parts = file.split("/");
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), text);
    await git.commitAll(`Add ${file}`);
    await git.push(branch);
    const pr = await github.createPullRequest(
      { owner: "alice", name },
      { title: `Add ${file}`, body: "", head: branch, base: "main" },
    );
    const merged = await github.mergePullRequest({ owner: "alice", name }, pr.number, {
      method: "merge",
    });
    expect(merged.merged).toBe(true);
    return pr;
  };
  const paths = async (projectId: string) =>
    (await client.projectFiles(projectId)).entries.map((e) => e.path);

  it("a pull request and a docs PR merged on GitHub: after one watcher poll and no session, Files and Docs show them with when the copy was updated", async () => {
    const project = await client.createProject({
      name: "Copy",
      goal: "A page whose files show once merged",
      repos: ["alice/copy"],
    });
    const before = await client.projectFiles(project.id);
    expect(before.entries.map((e) => e.path)).toContain("README.md");
    expect(before.entries.map((e) => e.path)).not.toContain("page.html");
    const firstUpdate = before.copy?.updatedAt ?? "";
    expect(firstUpdate, "the scaffold brought the copy to main").not.toBe("");

    // The person merges a pull request of their own and the scaffold's docs PR on GitHub.
    await mergeOnHost("copy", "person/page", "page.html", "<h1>Page</h1>\n");
    const scaffold = (await github.listPullRequests({ owner: "alice", name: "copy" })).find(
      (p) => p.head.ref === "fr/docs-scaffold",
    );
    expect(scaffold, "the scaffold's docs pull request").toBeDefined();
    expect(
      (
        await github.mergePullRequest({ owner: "alice", name: "copy" }, scaffold?.number ?? 0, {
          method: "merge",
        })
      ).merged,
    ).toBe(true);
    // Not yet: nothing has told this computer.
    expect(await paths(project.id)).not.toContain("page.html");

    await rt.githostWatcher?.pollOnce();
    const after = await client.projectFiles(project.id);
    expect(after.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(["README.md", "page.html", "docs/overview.md"]),
    );
    expect(after.copy?.updatedAt ?? "").not.toBe("");
    expect((after.copy?.updatedAt ?? "") >= firstUpdate).toBe(true);
    expect((await client.projectFile(project.id, "page.html")).content).toContain("<h1>Page</h1>");
    const overview = (await client.docs(project.id)).find((d) => d.path === "docs/overview.md");
    expect(overview).toMatchObject({ exists: true, note: "from this PC's copy of the repository" });
    // No session ran for it.
    expect(await client.sessions({ projectId: project.id })).toEqual([]);

    // The next poll with main where the copy is: nothing is fetched again, the copy stays.
    await rt.githostWatcher?.pollOnce();
    expect(await paths(project.id)).toContain("page.html");
  }, 120_000);

  it("a project made from a brief has its copy while its plan waits, with no watcher poll: the draft makes it (W6-25)", async () => {
    const brief = "A page that greets the visitor";
    const project = await client.createProject({
      name: "Brief copy",
      goal: goalFromBrief(brief),
      brief,
      intake: true,
      repos: ["alice/brief"],
    });
    await rt.intake.inFlight(project.id);
    const me = await client.me();
    expect(
      (await client.inbox(me.id)).requests.some(
        (r) => r.projectId === project.id && r.status === "open",
      ),
      "the plan waits for the person",
    ).toBe(true);
    // Before: no copy until a session ended, then (merged-copy) until the watcher's first poll,
    // up to a minute later; the Docs tab read README.md as not written yet meanwhile. Now the
    // draft makes it: no poll runs here (the watcher's are driven by the cases).
    const files = await client.projectFiles(project.id);
    expect(files.folder).not.toBeNull();
    expect(files.entries.map((e) => e.path)).toContain("README.md");
    expect((await client.docs(project.id)).find((d) => d.path === "README.md")).toMatchObject({
      exists: true,
      note: "from this PC's copy of the repository",
    });
  }, 120_000);

  it("Local only: listed in Files with its line, in the task's folder during its run, and never on GitHub, in the PR or in the review", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({
      name: "Local",
      goal: "A summary written beside the person's own notes",
      repos: ["alice/local"],
    });
    const folder = (await client.projectFiles(project.id)).copy?.localOnly?.folder ?? "";
    expect(folder, "the Local only folder").not.toBe("");
    writeFileSync(join(folder, "notes.txt"), "the person's own notes\n");
    const listed = await client.projectFiles(project.id);
    expect(listed.entries.map((e) => e.path)).toContain("Local only/notes.txt");
    expect(listed.copy?.localOnly?.line).toBe("Never uploaded. Agents can read and change it.");

    const task = await client.createTask(project.id, {
      title: "Write the summary in summary.md",
      outcome: "summary.md sums up the project in three lines",
      riskTier: 1,
      specialist: "coder",
    });
    const before = specialistCalls.length;
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end",
      async () => (await client.tasks(project.id)).map((t) => t.status).join(", "),
      60_000,
    );
    const row = await rt.store.task.mustGet(task.id);
    expect(row.status).toBe("done");
    // The run saw the file in its folder (its listing of the folder).
    const seenByRun = specialistCalls
      .slice(before)
      .map((c) => JSON.stringify(c.messages))
      .join("\n");
    expect(seenByRun).toContain("Local only/notes.txt");
    // Never on GitHub: the task's branch carries its own file only, and so does its PR.
    const onBranch = await run([
      "git",
      "--git-dir",
      host.repo("alice/local")?.dir ?? "",
      "ls-tree",
      "-r",
      "--name-only",
      row.branch ?? "",
    ]);
    expect(onBranch.stdout).toContain("summary.md");
    expect(onBranch.stdout).not.toContain("Local only");
    const pr = (await github.listPullRequests({ owner: "alice", name: "local" })).find(
      (p) => p.head.ref === row.branch,
    );
    expect(pr?.body ?? "").not.toContain("Local only");
    // Not evidence: the critic's diff and file list never name it.
    const review = criticCalls
      .map((c) => JSON.stringify(c.messages))
      .filter((m) => m.includes("Write the summary in summary.md"));
    expect(review.length).toBeGreaterThan(0);
    for (const m of review) expect(m).not.toContain("Local only");
    // The person's file is as it was; the task's folder keeps no copy.
    expect((await client.projectFile(project.id, "Local only/notes.txt")).content).toBe(
      "the person's own notes\n",
    );
    expect(readdirSync(join(rt.dirs.worktrees, task.id))).not.toContain("Local only");
  }, 120_000);

  it("a collaborator commits a file into Local only on GitHub: after one watcher poll the person's own file is still in Files as '(yours)', and the line says so (review of merged-copy)", async () => {
    // Before (bench W8): the watcher's refresh replaced the person's Local only/notes.txt with
    // the repository's without a word; Files said only that the repository has such a folder.
    const project = await client.createProject({
      name: "Taken",
      goal: "Notes the team starts to share",
      repos: ["alice/taken"],
    });
    const folder = (await client.projectFiles(project.id)).copy?.localOnly?.folder ?? "";
    expect(folder, "the Local only folder").not.toBe("");
    writeFileSync(join(folder, "notes.txt"), "the person's own notes\n");
    writeFileSync(join(folder, "drafts.txt"), "the person's drafts\n");
    await mergeOnHost("taken", "team/notes", "Local only/notes.txt", "the team's notes\n");
    await rt.githostWatcher?.pollOnce();
    const after = await client.projectFiles(project.id);
    expect(after.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        "Local only/notes.txt",
        "Local only/notes (yours).txt",
        "Local only/drafts.txt",
      ]),
    );
    expect((await client.projectFile(project.id, "Local only/notes (yours).txt")).content).toBe(
      "the person's own notes\n",
    );
    expect((await client.projectFile(project.id, "Local only/notes.txt")).content).toBe(
      "the team's notes\n",
    );
    expect((await client.projectFile(project.id, "Local only/drafts.txt")).content).toBe(
      "the person's drafts\n",
    );
    expect(after.copy?.localOnly).toEqual({
      folder: null,
      line: 'No Local only folder here any more: this repository now has a folder of that name. Your files in it stay on this computer; the one named like the repository\'s is now "notes (yours).txt".',
    });
  }, 120_000);
});

describe("the UI client against the real daemon: a paused task keeps its work and continues from it (budget-resume, ADR 0112 amended)", () => {
  // The owner's decision of 2026-11-02 (budgets): a pause's work is saved in code on the task's
  // own branch, one card names the limit with Continue (CHF N more), which starts the next
  // session at once, and that session's brief starts from where the run stopped. Here a session
  // on the stand-in model runs a repository project's task on a local host.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let criticCalls: ModelRequest[] = [];
  let specialistCalls: ModelRequest[] = [];
  let bare = "";
  let seedDir = "";
  const host = new MemoryGitHost("alice");
  const repo = { owner: "o", name: "resume" };
  const seedIdentity = { name: "Seed", email: "seed@example.test" };
  const gitOf = (dir: string, args: string[]) =>
    run(["git", "-C", dir, ...args], { allowFailure: true }).then((r) => r.stdout.trim());
  const hostBranches = async () =>
    (await run(["git", "--git-dir", bare, "for-each-ref", "--format=%(refname:short)"])).stdout
      .split(/\r?\n/)
      .filter(Boolean);
  const userText = (c: ModelRequest) => {
    const first = c.messages.find((m) => m.role === "user");
    return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content);
  };
  const waitIdle = async (projectId: string, why: string) =>
    eventually(
      async () =>
        (await client.sessions({ projectId })).every(
          (s) => !["running", "paused", "planned"].includes(s.status),
        ),
      why,
      async () => (await client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", "),
      60_000,
    );

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-resume-"));
    bare = join(home, "resume.git");
    seedDir = join(home, "seed");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({ cwd: seedDir, identity: seedIdentity });
    await seed.clone(bare);
    writeFileSync(join(seedDir, "README.md"), "# resume\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ ...repo, private: true, cloneUrl: bare });
    // The stand-in writes the guides one part per call until it hears the wrap-up.
    ({ rt, client, criticCalls, specialistCalls } = await composeWithRolePlayer(
      { FORERUNNER_BENCH_LONG: "Write the guide" },
      { gitHost: host, tryIt: false },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the pause is a commit on the task's branch (nothing pushed); Continue (CHF N more) starts a session at once whose brief starts where it stopped; after main moved the run goes on from the branch, is reviewed once and files no new card", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({
      name: "Resume",
      goal: "A guide for the club",
      repos: ["o/resume"],
    });
    // What New task sends with a budget of CHF 0.036 (USD 0.045): about three times the reserve
    // of two stand-in calls (budget-stop's journey).
    const task = await client.createTask(project.id, {
      title: "Write the guide in guide.md",
      outcome: "guide.md explains the club",
      acceptanceCriteria: ["guide.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 45_000,
      specialist: "coder",
      riskTier: 1,
    });
    const started = await client.startSession({ agentId, projectId: project.id });
    expect(started.session?.id, JSON.stringify(started)).toBeTruthy();
    await waitIdle(project.id, "the first session to end");
    // The row and its card name the limit; the card says what it did and left.
    const row = (await client.tasks(project.id)).find((t) => t.id === task.id);
    expect(row?.display).toMatchObject({
      label: "Paused at its budget",
      detail: "Continue or cancel in the Inbox.",
      cancelWork:
        "Its work so far is set aside unless a later task built on it; Undo brings it back.",
    });
    const me = await client.me();
    const card = (await client.inbox(me.id)).requests.find(
      (r) => r.taskId === task.id && r.status === "open",
    );
    expect(card?.title).toBe('"Write the guide in guide.md" paused at its budget of CHF 0.04');
    expect(card?.body ?? "").toMatch(
      /^Done: guide\.md has \d+ parts?; left: write the rest of guide\.md, check guide\.md against the criteria\.$/,
    );
    const labels = (card?.choices ?? []).map((c) => c.label);
    expect(labels[0]).toMatch(/^Continue \(CHF \d+\.\d\d more\)$/);
    expect(labels.slice(1)).toEqual(["Cancel task"]);
    // The work is a commit of its own on the task's branch on this computer; nothing pushed.
    const taskRow = await rt.store.task.mustGet(task.id);
    const wt = join(rt.dirs.worktrees, taskRow.id);
    expect(await gitOf(wt, ["status", "--porcelain"])).toBe("");
    expect(await gitOf(wt, ["log", "-1", "--format=%s"])).toBe(
      "Work in progress: Write the guide in guide.md (paused at its budget)",
    );
    expect(await gitOf(wt, ["log", "-1", "--format=%b"])).toContain(
      "Left to do:\n- write the rest of guide.md",
    );
    expect(await gitOf(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(taskRow.branch);
    expect(await hostBranches()).not.toContain(taskRow.branch);
    expect(
      (await host.listPullRequests(repo, { state: "all" })).filter(
        (p) => p.head.ref === taskRow.branch,
      ),
    ).toEqual([]);
    // No critic for the pause.
    expect(criticCalls.filter((c) => JSON.stringify(c.messages).includes(task.id))).toEqual([]);

    // Someone changes main meanwhile.
    const seed = new GitOps({ cwd: seedDir, identity: seedIdentity });
    writeFileSync(join(seedDir, "README.md"), "# resume\nchanged on main\n");
    await seed.commitAll("main moves on");
    await seed.push("main");

    // Continue, as the Inbox sends it: a session starts at once (no Start pressed).
    const sessionsBefore = (await client.sessions({ projectId: project.id })).length;
    const specialistBefore = specialistCalls.length;
    await client.answerRequest(card?.id ?? "", {
      version: card?.version ?? 0,
      answer: labels[0] ?? "",
    });
    await eventually(
      async () => (await client.sessions({ projectId: project.id })).length > sessionsBefore,
      "a session to start after Continue",
      async () =>
        JSON.stringify((await client.inbox(me.id)).requests.find((r) => r.id === card?.id)),
      15_000,
    );
    await waitIdle(project.id, "the continuing session to end");
    const done = await rt.store.task.mustGet(task.id);
    expect(done.status, done.reason).toBe("done");
    // Its brief started from where the run stopped: the note, the files, the to-do list.
    const resumed = specialistCalls
      .slice(specialistBefore)
      .map(userText)
      .find((t) => t.includes("Write the guide in guide.md"));
    expect(resumed).toContain("## Where the last run stopped");
    expect(resumed).toContain('Files it changed: "guide.md"');
    expect(resumed).toContain('- "write the rest of guide.md"');
    expect(resumed).not.toContain("It failed:");
    // Reviewed once (one session of critic calls), and no new card.
    const reviewed = criticCalls.filter((c) => JSON.stringify(c.messages).includes(task.id));
    expect(reviewed.length).toBeGreaterThan(0);
    expect(
      (await client.inbox(me.id)).requests.filter(
        (r) => r.taskId === task.id && r.status === "open",
      ),
    ).toEqual([]);
    // Its pull request carries the work in progress and main merged in (never rebased).
    const pr = (await host.listPullRequests(repo, { state: "open" })).find(
      (p) => p.head.ref === done.branch,
    );
    expect(pr, "the task's pull request").toBeDefined();
    const history = (await run(["git", "--git-dir", bare, "log", "--format=%s", done.branch ?? ""]))
      .stdout;
    expect(history).toContain(
      "Work in progress: Write the guide in guide.md (paused at its budget)",
    );
    expect(history).toContain("Bring in main");
    const readme = await run(["git", "--git-dir", bare, "show", `${done.branch}:README.md`]);
    expect(readme.stdout).toContain("changed on main");
  }, 150_000);

  it("with 'Push unfinished work to GitHub' on (Settings), a pause pushes its branch; Cancel names the stuck task, sets the work aside and deletes the branch there; Undo brings the work back", async () => {
    const agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({
      name: "Resume push",
      goal: "A guide and its summary",
      repos: ["o/resume"],
    });
    const row = (await client.settings()).find(
      (s) => s.key === "project.push_unfinished_work" && s.scopeId === project.id,
    );
    expect(row).toMatchObject({ label: "Push unfinished work to GitHub", value: false });
    const turnedOn = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: { key: "push_unfinished_work", value: true, project: project.id },
        },
      ],
      source: "ui",
    });
    expect(turnedOn.status).toBe("done");
    const task = await client.createTask(project.id, {
      title: "Write the guide for members",
      outcome: "members.md explains the club to members",
      acceptanceCriteria: ["members.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 45_000,
      specialist: "coder",
      riskTier: 1,
    });
    const after = await client.createTask(project.id, {
      title: "Sum up the members guide",
      outcome: "summary.md sums it up",
      acceptanceCriteria: ["summary.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [task.id],
      specialist: "coder",
      riskTier: 1,
    });
    await client.startSession({ agentId, projectId: project.id });
    await waitIdle(project.id, "the session to end");
    const paused = await rt.store.task.mustGet(task.id);
    expect(paused.status).toBe("needs_human");
    const branch = paused.branch ?? "";
    expect(await hostBranches()).toContain(branch);
    // Cancel from the Tasks tab, as the dialog sends it: the line names the stuck task and the
    // work set aside; the branch leaves the host.
    const cancelled = await client.taskAction(task.id, {
      version: paused.version,
      action: "cancel",
    });
    expect(cancelled.change?.sentence).toBe(
      `Cancelled "Write the guide for members": its work so far is set aside; Undo brings it back. Its card in the Inbox was withdrawn. "${after.title}" waits on it and is stuck now.`,
    );
    const wt = join(rt.dirs.worktrees, task.id);
    expect(await gitOf(wt, ["ls-files", "members.md"])).toBe("");
    expect(await hostBranches()).not.toContain(branch);
    // Undo: the task is paused again with its card, and its work is back as work in progress.
    const undone = await client.undoChange(cancelled.change?.changeLogId ?? "");
    expect(undone.status, JSON.stringify(undone)).toBe("done");
    expect(JSON.stringify(undone)).toContain("Its work so far is back.");
    expect((await rt.store.task.mustGet(task.id)).status).toBe("needs_human");
    expect(await gitOf(wt, ["log", "-1", "--format=%s"])).toBe(
      "Work in progress: Write the guide for members (paused at its budget)",
    );
    expect(await gitOf(wt, ["ls-files", "members.md"])).toBe("members.md");
  }, 150_000);
});

describe("the UI client against the real daemon: research searches the web on the API key ('web-search')", () => {
  // The owner's decision of 2026-11-02 (Q5): Anthropic's web search on the API key, capped per
  // task, sourced only once a page was opened. As `fr daemon --provider bench-api` composes it:
  // no injected provider, the routed provider over the vault's key calls the Messages API
  // stand-in, which plays Anthropic's server (searches, sealed results it checks come back byte
  // for byte) with the bench's role-player behind it; the pages are this computer's test server,
  // on the project's site list. Before, the researcher's tools had no search, its brief said
  // "Web search is not available on this run" and it read only the addresses the brief named.
  const key = ["sk-ant-api03-", "search", "8".repeat(40)].join(""); // not-a-secret
  let server: Server;
  let base = "";
  const hits: string[] = [];
  const PAGES: Record<string, [string, string]> = {
    "/hosts/alpha": ["Alpha Pages free tier", "Alpha Pages gives 100 GB of bandwidth a month."],
    "/hosts/beta": ["Beta Static free plan", "Beta Static allows 3 sites and 10 GB of storage."],
    "/hosts/gamma": ["Gamma Host pricing", "Gamma Host builds 300 minutes a month for free."],
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const page = PAGES[(req.url ?? "/").split("?")[0] ?? ""];
      res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(
        page
          ? `<!doctype html><html><head><title>${page[0]}</title></head><body><main><h1>${page[0]}</h1><p>${page[1]}</p></main></body></html>`
          : "not found",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("a researcher task searches, opens two of the three results, writes its notes citing only those, and the review is told which it never opened", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-search-"));
    const results = Object.entries(PAGES).map(([path, [title]]) => `${base}${path}|${title}`);
    const callLog = join(home, "model-calls.jsonl");
    const model = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0", FORERUNNER_BENCH_SEARCH_RESULTS: results.join(",") },
        new ModelCallLog({ file: callLog }),
      ),
    );
    const criticCalls: ModelRequest[] = [];
    const stream = model.stream.bind(model);
    model.stream = (req) => {
      if (detectRole(req).role === "critic")
        criticCalls.push({ ...req, messages: structuredClone(req.messages) });
      return stream(req);
    };
    const standIn = messagesApiStandIn({ model, clock: new SystemClock(), search: {} });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      // As `fr daemon --provider bench-api` composes it: the pages are on 127.0.0.1.
      webReadLoopback: true,
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock: new ShiftedClock("2026-03-05T08:00:00Z"),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ anthropic_api_key: key }),
      fetchImpl: standInFetch(standIn, {
        fallback: async () => new Response("not here", { status: 404 }),
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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
    try {
      // Settings' "What each can do here": the API key searches the web now.
      const models = await client.modelSettings();
      expect(models.credentials?.rows.find((r) => r.need === "webSearch")?.cells[0]?.words).toBe(
        "Yes",
      );
      const project = await client.createProject({ name: "Hosts", goal: "Pick a host" });
      // The pages are on this computer (the bench's loopback seam reads them); the block list
      // holds a "*." entry, which web search takes as the bare domain.
      const row = await rt.store.project.mustGet(project.id);
      await client.updateProjectSettings(project.id, {
        version: row.version,
        settings: { browser: { blockedDomains: ["*.example.org"] } },
      });
      const task = await client.createTask(project.id, {
        title: "Compare the free tiers of static site hosts",
        outcome: "research/hosts.md compares the free tiers of static site hosts, with sources",
        acceptanceCriteria: ["research/hosts.md names each host and the source of each figure"],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
        specialist: "researcher",
        riskTier: 1,
      });
      const agentId = (await client.agents())[0]?.id ?? "";
      const started = await client.startSession({ agentId, projectId: project.id });
      const sessionId = started.session?.id ?? "";
      await eventually(
        async () =>
          !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
        "the session to end",
        async () =>
          `${(await client.session(sessionId)).status}; ${(await client.tasks(project.id)).map((t) => t.status).join(", ")}`,
        30_000,
      );
      expect(standIn.refusals).toEqual([]);
      const done = await client.task(task.id);
      expect(done.task.status).toBe("done");
      // The API saw the server tool with max_uses of at most 10 and the block list in the
      // server's form, and got the search's blocks back unchanged on the next request.
      const asked = standIn.requests.filter((r) => r.webSearch);
      expect(asked.length).toBeGreaterThan(0);
      for (const r of asked) {
        expect(Number(r.webSearch?.max_uses)).toBeGreaterThan(0);
        expect(Number(r.webSearch?.max_uses)).toBeLessThanOrEqual(10);
        expect(r.webSearch?.blocked_domains).toEqual(["example.org"]);
      }
      expect(standIn.requests.some((r) => (r.serverBlocksBack ?? 0) >= 2)).toBe(true);
      expect(standIn.searches.map((s) => s.urls.length)).toEqual([3]);
      // It opened the first two results, never the third.
      expect(hits).toEqual(["GET /hosts/alpha", "GET /hosts/beta"]);
      // Its notes cite only the pages it opened.
      const file = await client.projectFile(project.id, "research/hosts.md");
      expect(file.content).toContain(`${base}/hosts/alpha`);
      expect(file.content).toContain(`${base}/hosts/beta`);
      expect(file.content).not.toContain(`${base}/hosts/gamma`);
      // The session's log: the search and the pages, one short line each.
      const lines = (await client.sessionEvents(sessionId)).map((e) => e.text);
      expect(lines).toContain("searched the web for compare the free tiers of static site hosts");
      expect(lines).toContain(`read the web page ${new URL(base).host}/hosts/alpha`);
      // Offering search leaves the run's wrap-up line where it is (review of 'web-search': ten
      // searches' worst case had moved it to CHF 0.77, a reserve of CHF 1.23).
      expect(lines).toContain(
        "This run may spend CHF 2.00: at CHF 1.60 it is told to wrap up, keeping a reserve of CHF 0.40 to finish.",
      );
      expect(lines.some((l) => l?.startsWith("Told the researcher to wrap up"))).toBe(false);
      // The run's cost holds the search's USD 0.01, and its row counts the task's searches.
      const work = (await rt.store.run.forTask(task.id)).find((r) => r.specialist === "researcher");
      expect(work?.artifacts).toContainEqual({ webSearches: 1 });
      expect(work?.cost_usd_micro ?? 0).toBeGreaterThan(10_000);
      // The review is told which search result it never opened: no source.
      const shown = criticCalls.map((c) => JSON.stringify(c.messages)).join("\n");
      expect(shown).toContain(`web search result, page not opened: ${base}/hosts/gamma`);
      expect(shown).toContain("is not sourced");
      expect(shown).toContain(`### web page ${base}/hosts/alpha`);
      // The model-call log shows the server tool, the blocks sent back and the search count.
      const logged = readFileSync(callLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const searched = logged.find(
        (l) => (l.reply as { searches?: unknown[] } | undefined)?.searches?.length,
      );
      expect(searched?.webSearch).toMatchObject({ blockedDomains: ["example.org"] });
      expect(
        (searched?.reply as { usage?: { server_tool_use?: unknown } } | undefined)?.usage
          ?.server_tool_use,
      ).toEqual({ web_search_requests: 1 });
    } finally {
      await rt.close();
    }
  }, 120_000);
});

describe("the UI client against the real daemon: Open this version and Take this work out (merged-actions, U-037)", () => {
  // The owner's decisions of 2026-11-02: "'Open this version' on a waiting PR: its files on the
  // PC to try before merging" and "'Take this work out' (revert PR naming later tasks that built
  // on it)". Before, a waiting pull request could be looked at only on GitHub, and nothing took
  // merged work out. Real git on the testenv fake GitHub behind the daemon's GitHub client.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let github: GitHubHost;
  let token = "";
  let work = "";
  const FULL = "alice/shop";
  const REPO = { owner: "alice", name: "shop" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fr-ui-real-merged-actions-"));
    const clock = new SystemClock();
    host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "shop",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# shop\n" },
    });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, token);
    ({ rt, client } = await composeWithRolePlayer(
      {},
      {
        gitHost: new GitHubHost({ token, baseUrl: host.baseUrl, clock }),
        vault,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl: "sqlite::memory:",
        },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** A done task with its pull request on the host, as a session leaves it. */
  async function doneTask(
    projectId: string,
    title: string,
    file: string,
    opts: { from?: string; dependsOn?: string[]; content?: string; second?: string } = {},
  ) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: opts.dependsOn ?? [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    const dir = join(work, `wt-${task.id}`);
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(FULL));
    const branch = `fr/${file.replace(/\W+/g, "-")}-${task.id.slice(-6).toLowerCase()}`;
    await git.createBranch(branch, opts.from ? `origin/${opts.from}` : "origin/main");
    writeFileSync(join(dir, file), opts.content ?? `export const f = "${file}";\n`);
    await git.commitAll(`Add ${file}`);
    // A second commit (another file): a squash of it differs from a rebase in git.
    if (opts.second) {
      writeFileSync(join(dir, opts.second), `export const g = "${opts.second}";\n`);
      await git.commitAll(`Add ${opts.second}`);
    }
    await git.push(branch);
    const pr = await github.createPullRequest(REPO, {
      title,
      body: "",
      head: branch,
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
    await rt.store.mergeRecord.pin({
      task_id: task.id,
      project_id: projectId,
      agent_id: rt.agent.id,
      pr_number: pr.number,
      pr_url: pr.htmlUrl,
      reviewed_head_sha: pr.head.sha,
      author_agent: rt.agent.id,
    });
    return { task, pr, branch, dir, git };
  }

  const hostGit = async (...args: string[]) =>
    (await run(["git", "--git-dir", host.repo(FULL)?.dir ?? "", ...args])).stdout.trim();

  it("Open this version on a waiting PR: its version in a folder on this computer, as merging would give it, under the copy's lock; the row says so; the folder goes once the PR is merged", async () => {
    const project = await client.createProject({ name: "Shop", goal: "A shop", repos: [FULL] });
    const a = await doneTask(project.id, "Add the cart", "cart.ts");
    // main moves after the pull request left it: the preview holds both, as a merge would.
    await host.seedCommit(REPO, { "news.md": "# News\n" }, "Add the news", "main");
    const before = await client.projectPullRequests(project.id);
    expect(before.waiting.find((w) => w.number === a.pr.number)?.preview ?? null).toBeNull();
    // The copy's lock is held (a refresh or a docs write runs): the preview waits for it.
    let release: () => void = () => undefined;
    const held = rt.docs.withCopy(
      project.id,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    let settled = false;
    const pressed = client.previewPullRequest(project.id, a.pr.number).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "the preview went ahead while the copy's lock was held").toBe(false);
    release();
    await held;
    const answer = await pressed;
    expect(answer).toEqual({
      state: "ready",
      sentence: `#${a.pr.number} as it would be merged. Changes here are not kept.`,
      folder: expect.any(String),
      number: a.pr.number,
    });
    const folder = answer.folder ?? "";
    expect(folder.startsWith(join(rt.dirs.worktrees, "docs", "previews"))).toBe(true);
    expect(readFileSync(join(folder, "cart.ts"), "utf8")).toBe('export const f = "cart.ts";\n');
    expect(readFileSync(join(folder, "news.md"), "utf8")).toBe("# News\n");
    // Not the copy, and no Local only in it.
    expect(folder).not.toBe(rt.docs.copyDir(project.id));
    expect(existsSync(join(folder, "Local only"))).toBe(false);
    // The person's own git there, set up as Git for Windows sets it up (core.autocrlf=true; here
    // in a global config), reads the copy's config, which says our line endings (R-copystuck):
    // a file they change and put back is as merging would give it, not rewritten with CRLF.
    const windowsGit = join(work, "git-for-windows.gitconfig");
    writeFileSync(windowsGit, "[core]\n\tautocrlf = true\n");
    writeFileSync(join(folder, "cart.ts"), "// tried something\n");
    await run(["git", "-C", folder, "checkout", "--", "cart.ts"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: windowsGit },
    });
    expect(readFileSync(join(folder, "cart.ts"), "utf8")).toBe('export const f = "cart.ts";\n');
    // The row carries it, read again (after a reload too).
    const after = await client.projectPullRequests(project.id);
    expect(after.waiting.find((w) => w.number === a.pr.number)?.preview).toEqual({
      folder,
      sentence: answer.sentence,
    });
    // Nothing was pushed: main and the PR's branch are as they were.
    expect(await hostGit("rev-parse", a.branch)).toBe(a.pr.head.sha);
    // A pull request that does not wait is refused with a sentence.
    expect(await client.previewPullRequest(project.id, 999)).toEqual({
      state: "refused",
      sentence: "#999 does not wait to be merged: it may be merged or closed already.",
      folder: null,
      number: 999,
    });
    // Merged in the app: the preview is removed.
    await client.mergePullRequest(project.id, a.pr.number);
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(a.task.id))?.state === "merged",
      "the pull request to be merged",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(a.task.id)),
      30_000,
    );
    await eventually(
      async () => !existsSync(folder),
      "the preview folder to be removed after the merge",
      async () => JSON.stringify(readdirSync(join(rt.dirs.worktrees, "docs", "previews"))),
      15_000,
    );
    // A pull request closed on GitHub: the Overview's next read removes its preview.
    const b = await doneTask(project.id, "Add the till", "till.ts");
    const second = await client.previewPullRequest(project.id, b.pr.number);
    expect(second.state).toBe("ready");
    expect(existsSync(join(second.folder ?? "", "till.ts"))).toBe(true);
    await github.updatePullRequest(REPO, b.pr.number, { state: "closed" });
    const closed = await client.projectPullRequests(project.id);
    expect(closed.waiting.some((w) => w.number === b.pr.number)).toBe(false);
    expect(existsSync(second.folder ?? "")).toBe(false);
  }, 120_000);
  it("Take this work out on a merged task of a chain: a pull request that reverts its merge, naming the task that built on it; main untouched; the row and the Overview say so; Merge in the app takes it out", async () => {
    const project = await client.createProject({ name: "Till", goal: "A till", repos: [FULL] });
    const a = await doneTask(project.id, "Add the basket", "basket.ts");
    const b = await doneTask(project.id, "Add the receipt", "receipt.ts", {
      from: a.branch,
      dependsOn: [a.task.id],
    });
    await client.mergePullRequest(project.id, b.pr.number);
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(b.task.id))?.state === "merged",
      "both pull requests to be merged",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(b.task.id)),
      30_000,
    );
    const row = async (id: string) => (await client.tasks(project.id)).find((t) => t.id === id);
    // Before: a merged task offered Redo only, and nothing could take its work out of main.
    expect((await row(a.task.id))?.display).toMatchObject({
      label: "Merged",
      takeOut: { state: "offered" },
    });
    const mainBefore = await hostGit("rev-parse", "main");
    const answer = await client.takeOutTask(a.task.id);
    expect(answer).toEqual({
      state: "opened",
      sentence: `Opened #${answer.number} to take "Add the basket" out: merge it to remove the work, or close it to keep the work. "Add the receipt" built on it: check it still works once #${answer.number} is merged.`,
      number: expect.any(Number),
      url: expect.stringContaining(`/pull/${answer.number}`),
      builtOn: ["Add the receipt"],
    });
    const n = answer.number ?? 0;
    // On the host: its own branch and pull request into main, naming the task built on it;
    // main itself is untouched.
    expect(await hostGit("rev-parse", "main")).toBe(mainBefore);
    const pr = await github.getPullRequest(REPO, n);
    expect(pr).toMatchObject({ title: "Take out: Add the basket", state: "open" });
    expect(pr.base.ref).toBe("main");
    expect(pr.body).toContain('Later tasks built on it: "Add the receipt".');
    expect(pr.body).toContain(`(#${a.pr.number}, merged)`);
    // The task's row says it (the merge record keeps it; the describe below starts the daemon
    // again on the same home and reads it there).
    expect((await row(a.task.id))?.display).toMatchObject({
      label: `Taken out in #${n} (waiting for you to merge)`,
      takeOut: { state: "open", number: n },
    });
    expect((await rt.store.mergeRecord.forTask(a.task.id))?.take_out_state).toBe("open");
    // A second press is refused with what is going on.
    expect((await client.takeOutTask(a.task.id)).sentence).toBe(
      `"Add the basket" is being taken out in #${n}: merge #${n} to finish it.`,
    );
    // The Overview lists it under Waiting for you to merge, with Merge.
    const listed = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.number === n,
    );
    expect(listed).toMatchObject({
      kind: "take_out",
      taskId: a.task.id,
      title: "Take out: Add the basket",
      merge: { state: "ready", canMerge: true },
    });
    // Merge in the app: as it is (it has no record of its own); the work leaves main.
    expect((await client.mergePullRequest(project.id, n)).state).toBe("queued");
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(a.task.id))?.take_out_state === "merged",
      "the take-out to be merged",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(a.task.id)),
      30_000,
    );
    expect((await row(a.task.id))?.display?.label).toBe(`Taken out in #${n}`);
    expect(await hostGit("ls-tree", "--name-only", "main")).not.toContain("basket.ts");
    expect(await hostGit("ls-tree", "--name-only", "main")).toContain("receipt.ts");
  }, 120_000);

  it("a pull request squash-merged on GitHub: Take this work out reverts the squash (main's tree after its merge equals main's before the squash); an unknown shape and a conflict are said in words", async () => {
    const project = await client.createProject({ name: "Kiosk", goal: "A kiosk", repos: [FULL] });
    // Two commits: a squash of one commit looks like a rebase in git, and is then said to be
    // "merged" (capabilities take-out.test.ts).
    const c = await doneTask(project.id, "Add the menu", "menu.ts", { second: "prices.ts" });
    const treeBefore = await hostGit("rev-parse", "main^{tree}");
    // Merged on GitHub's website by squash, as the watcher then records it.
    const squashed = await github.mergePullRequest(REPO, c.pr.number, {
      method: "squash",
      sha: c.pr.head.sha,
    });
    const record = await rt.store.mergeRecord.forTask(c.task.id);
    if (!record) throw new Error("no record");
    await rt.store.mergeRecord.move(record.id, "merged", {
      merge_sha: squashed.sha,
      method: "squash",
    });
    const answer = await client.takeOutTask(c.task.id);
    expect(answer.state).toBe("opened");
    const n = answer.number ?? 0;
    expect((await github.getPullRequest(REPO, n)).body).toContain(
      `(#${c.pr.number}, squash-merged)`,
    );
    const merged = await github.mergePullRequest(REPO, n, {});
    expect(merged.merged).toBe(true);
    expect(await hostGit("rev-parse", "main^{tree}")).toBe(treeBefore);

    // A record whose merge commit is not the pull request's work in any shape: refused.
    const d = await doneTask(project.id, "Add the hours", "hours.ts");
    await github.mergePullRequest(REPO, d.pr.number, { method: "squash", sha: d.pr.head.sha });
    const other = await host.seedCommit(REPO, { "other.md": "other\n" }, "other work", "main");
    const recordD = await rt.store.mergeRecord.forTask(d.task.id);
    if (!recordD) throw new Error("no record");
    await rt.store.mergeRecord.move(recordD.id, "merged", { merge_sha: other.sha });
    expect(await client.takeOutTask(d.task.id)).toEqual({
      state: "refused",
      sentence: `#${d.pr.number} was merged in a way Forerunner cannot undo safely; undo it on GitHub.`,
      number: null,
      url: null,
      builtOn: [],
    });

    // Later work changed the same lines: nothing is pushed, one Inbox notice says so. Its task's
    // title holds a colon, as planners' titles often do (review of merged-actions: the card was
    // titled '"Set the price' with the rest of the title in its body).
    const e = await doneTask(project.id, "Set the price: one franc", "price.ts", {
      content: "export const price = 1;\n",
    });
    const mergedE = await github.mergePullRequest(REPO, e.pr.number, { sha: e.pr.head.sha });
    const recordE = await rt.store.mergeRecord.forTask(e.task.id);
    if (!recordE) throw new Error("no record");
    await rt.store.mergeRecord.move(recordE.id, "merged", {
      merge_sha: mergedE.sha,
      method: "merge",
    });
    await host.seedCommit(REPO, { "price.ts": "export const price = 2;\n" }, "new price", "main");
    const branches = (await github.listBranches(REPO)).map((x) => x.name).sort();
    const conflict = await client.takeOutTask(e.task.id);
    const sentence =
      '"Set the price: one franc" could not be taken out by itself. Later work changed the same lines in price.ts: undo it on GitHub by hand, or ask in Chat for a task that does it.';
    expect(conflict).toEqual({ state: "conflict", sentence, number: null, url: null, builtOn: [] });
    expect((await github.listBranches(REPO)).map((x) => x.name).sort()).toEqual(branches);
    await client.takeOutTask(e.task.id);
    const inbox = await client.inbox(rt.human.id);
    const notices = inbox.requests.filter((r) => r.why === sentence && r.status === "open");
    expect(notices).toHaveLength(1);
    // The Inbox and Home read its title and body (Home: "Kiosk: <title>").
    expect(notices[0]).toMatchObject({
      projectName: "Kiosk",
      title: '"Set the price: one franc" could not be taken out',
      body: "Later work changed the same lines in price.ts: undo it on GitHub by hand, or ask in Chat for a task that does it.",
      reply: "none",
    });
    expect((notices[0]?.choices ?? []).map((c) => c.label)).toEqual(["Got it"]);
    // The notice asks nothing of a task: the project's line does not wait on it.
    expect((await client.project(project.id)).statusLine?.text ?? "").not.toMatch(
      /^Waiting for you/,
    );
  }, 120_000);
});

describe("the UI client against the real daemon: a take-out and a preview survive a restart (merged-actions, validation rule 4)", () => {
  // The review of merged-actions: the take-out's columns on the merge record (migration 0007),
  // the preview's record (preview.json) and its git worktree beside the copy were never read
  // back by a daemon started again on the same home. Real git on the testenv fake GitHub; the
  // state in a file, as on the person's computer.
  const FULL = "alice/stall";
  const REPO = { owner: "alice", name: "stall" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  it("after the daemon starts again: the row still reads 'Taken out in #N (waiting for you to merge)', the Overview lists the take-out with Merge and the waiting pull request with its folder; Merge and a merge on GitHub then finish the take-outs, and the preview goes once its pull request is merged", async () => {
    const work = mkdtempSync(join(tmpdir(), "fr-ui-real-take-out-restart-"));
    const clock = new SystemClock();
    const host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "stall",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# stall\n" },
    });
    const token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const compose = async () => {
      const vault = new MemoryVault();
      await vault.set(SECRET_NAMES.github, token);
      return composeWithRolePlayer(
        {},
        {
          env,
          dirs,
          stateUrl,
          gitHost: new GitHubHost({ token, baseUrl: host.baseUrl, clock }),
          vault,
          config: {
            version: 1,
            profile: "default",
            timezone: "UTC",
            githubApiBase: host.baseUrl,
            anthropicApiBase: "http://an.test",
            repos: [],
            credentials: { github: true, anthropic: false, anthropicSubscription: false },
            stateUrl,
          },
        },
      );
    };
    const hostGit = async (...args: string[]) =>
      (await run(["git", "--git-dir", host.repo(FULL)?.dir ?? "", ...args])).stdout.trim();

    /** A done task with its pull request on the host, as a session leaves it. */
    async function doneTask(rt: RuntimeApp, projectId: string, title: string, file: string) {
      const task = await rt.store.task.insert({
        project_id: projectId,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status: "done",
        priority: 1,
        depends_on: [],
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 0,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "critic accepted",
        author_agent: rt.agent.id,
      });
      const dir = join(work, `wt-${task.id}`);
      const git = new GitOps({ cwd: dir, identity, auth: { token } });
      await git.clone(host.cloneUrl(FULL));
      const branch = `fr/${file.replace(/\W+/g, "-")}-${task.id.slice(-6).toLowerCase()}`;
      await git.createBranch(branch, "origin/main");
      writeFileSync(join(dir, file), `export const f = "${file}";\n`);
      await git.commitAll(`Add ${file}`);
      await git.push(branch);
      const pr = await github.createPullRequest(REPO, {
        title,
        body: "",
        head: branch,
        base: "main",
      });
      await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
      await rt.store.mergeRecord.pin({
        task_id: task.id,
        project_id: projectId,
        agent_id: rt.agent.id,
        pr_number: pr.number,
        pr_url: pr.htmlUrl,
        reviewed_head_sha: pr.head.sha,
        author_agent: rt.agent.id,
      });
      return { task, pr };
    }
    /** Merge in the app, then wait for the record to say merged. */
    async function mergeInApp(
      rt: RuntimeApp,
      client: DaemonClient,
      projectId: string,
      t: Awaited<ReturnType<typeof doneTask>>,
    ) {
      expect((await client.mergePullRequest(projectId, t.pr.number)).state).toBe("queued");
      await eventually(
        async () => (await rt.store.mergeRecord.forTask(t.task.id))?.state === "merged",
        `#${t.pr.number} to be merged`,
        async () => JSON.stringify(await rt.store.mergeRecord.forTask(t.task.id)),
        30_000,
      );
    }

    let first: Awaited<ReturnType<typeof compose>> | null = await compose();
    let second: Awaited<ReturnType<typeof compose>> | null = null;
    try {
      // Before the restart: two merged tasks taken out (both wait), and one pull request waiting
      // with its version on this computer.
      const project = await first.client.createProject({
        name: "Stall",
        goal: "A market stall's page",
        repos: [FULL],
      });
      const a = await doneTask(first.rt, project.id, "Add the stall", "stall.ts");
      const b = await doneTask(first.rt, project.id, "Add the till", "till.ts");
      await mergeInApp(first.rt, first.client, project.id, a);
      await mergeInApp(first.rt, first.client, project.id, b);
      const outA = await first.client.takeOutTask(a.task.id);
      const outB = await first.client.takeOutTask(b.task.id);
      expect([outA.state, outB.state]).toEqual(["opened", "opened"]);
      const n = outA.number ?? 0;
      const m = outB.number ?? 0;
      const c = await doneTask(first.rt, project.id, "Add the sign", "sign.ts");
      const preview = await first.client.previewPullRequest(project.id, c.pr.number);
      expect(preview.state).toBe("ready");
      const folder = preview.folder ?? "";
      expect(readFileSync(join(folder, "sign.ts"), "utf8")).toBe('export const f = "sign.ts";\n');
      const mainBefore = await hostGit("rev-parse", "main");
      await first.rt.close();
      first = null;

      // The daemon starts again on the same home.
      second = await compose();
      const { client, rt } = second;
      const row = async (id: string) => (await client.tasks(project.id)).find((t) => t.id === id);
      expect((await row(a.task.id))?.display).toMatchObject({
        label: `Taken out in #${n} (waiting for you to merge)`,
        takeOut: { state: "open", number: n },
      });
      expect((await row(b.task.id))?.display).toMatchObject({
        label: `Taken out in #${m} (waiting for you to merge)`,
        takeOut: { state: "open", number: m },
      });
      const prs = await client.projectPullRequests(project.id);
      expect(prs.waiting.find((w) => w.number === n)).toMatchObject({
        kind: "take_out",
        taskId: a.task.id,
        title: "Take out: Add the stall",
        merge: { state: "ready", canMerge: true },
      });
      expect(prs.waiting.find((w) => w.number === c.pr.number)?.preview).toEqual({
        folder,
        sentence: preview.sentence,
      });
      expect(readFileSync(join(folder, "sign.ts"), "utf8")).toBe('export const f = "sign.ts";\n');
      // A second press after the restart still says what is going on; main is untouched.
      expect((await client.takeOutTask(a.task.id)).sentence).toBe(
        `"Add the stall" is being taken out in #${n}: merge #${n} to finish it.`,
      );
      expect(await hostGit("rev-parse", "main")).toBe(mainBefore);

      // #m merged on GitHub: the next read of the Overview (or the watcher's poll) settles it.
      expect((await github.mergePullRequest(REPO, m, {})).merged).toBe(true);
      await eventually(
        async () => {
          await client.projectPullRequests(project.id);
          return (await row(b.task.id))?.display?.label === `Taken out in #${m}`;
        },
        `the row to read "Taken out in #${m}" after #${m} was merged on GitHub`,
        async () => JSON.stringify((await row(b.task.id))?.display),
        30_000,
      );
      // #n merged in the app: the row says it, and the work left main.
      expect((await client.mergePullRequest(project.id, n)).state).toBe("queued");
      await eventually(
        async () => (await rt.store.mergeRecord.forTask(a.task.id))?.take_out_state === "merged",
        `#${n} to be merged`,
        async () => JSON.stringify(await rt.store.mergeRecord.forTask(a.task.id)),
        30_000,
      );
      expect((await row(a.task.id))?.display?.label).toBe(`Taken out in #${n}`);
      const files = await hostGit("ls-tree", "--name-only", "main");
      expect(files).not.toContain("stall.ts");
      expect(files).not.toContain("till.ts");
      // The previewed pull request merged in the app: its folder goes, and no row offers one.
      await mergeInApp(rt, client, project.id, c);
      await eventually(
        async () => !existsSync(folder),
        "the preview folder to be removed after its pull request was merged",
        async () => JSON.stringify(readdirSync(join(dirs.worktrees, "docs", "previews"))),
        15_000,
      );
      expect((await client.projectPullRequests(project.id)).waiting.some((w) => w.preview)).toBe(
        false,
      );
    } finally {
      await first?.rt.close();
      await second?.rt.close();
      await host.stop();
    }
  }, 180_000);
});

describe("the UI client against the real daemon: leftovers of wave 7, merge side (leftovers7-merge)", () => {
  // A session on a repository behind the memory host (bare repositories, as the bench's
  // stand-in for GitHub serves them), read through the UI's client.
  let rt: RuntimeApp;
  let client: DaemonClient;
  const host = new MemoryGitHost("alice");

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-ui-real-l7m-"));
    const bare = join(dir, "guides.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({
      cwd: join(dir, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(dir, "seed", "README.md"), "# guides\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name: "guides", private: true, cloneUrl: bare });
    ({ rt, client } = await composeWithRolePlayer({}, { gitHost: host }));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("two tasks titled 'Write the guide' created together get two pull requests, each with its own work (R-branch)", async () => {
    const project = await client.createProject({
      name: "Two guides",
      goal: "Two guides with one title",
      repos: ["o/guides"],
    });
    const create = (file: string) =>
      client.createTask(project.id, {
        title: "Write the guide",
        outcome: `${file} is written`,
        riskTier: 1,
        specialist: "coder",
      });
    const first = await create("guide.md");
    const second = await create("notes.md");
    // The cause: both ids start with the same 8 characters (their creation time).
    expect(second.id.slice(0, 8)).toBe(first.id.slice(0, 8));
    const agentId = (await client.agents())[0]?.id ?? "";
    const started = await client.startSession({ agentId, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId).not.toBe("");
    const states = async () =>
      (await client.tasks(project.id))
        .map((t) => `${t.title}=${t.status} (${t.reason}) ${t.prUrl ?? ""}`)
        .join(", ");
    await eventually(
      async () => (await client.session(sessionId)).status !== "running",
      "the session to end (at least 10 s of real time)",
      states,
      90_000,
    );
    const a = (await client.task(first.id)).task;
    const b = (await client.task(second.id)).task;
    expect([a.status, b.status], await states()).toEqual(["done", "done"]);
    expect(a.prUrl).toMatch(/^memory:\/\/o\/guides\/pull\/\d+$/);
    expect(b.prUrl).toMatch(/^memory:\/\/o\/guides\/pull\/\d+$/);
    expect(b.prUrl).not.toBe(a.prUrl);
    // The Overview lists both, each under its own task.
    const view = await client.projectPullRequests(project.id);
    const rows = view.waiting.filter((w) => w.kind === "task");
    expect(rows.map((w) => w.taskId).sort()).toEqual([first.id, second.id].sort());
    expect(new Set(rows.map((w) => w.url))).toEqual(new Set([a.prUrl, b.prUrl]));
    expect(new Set(rows.map((w) => w.branch)).size).toBe(2);
  }, 150_000);
});

describe("the UI client against the real daemon: leftovers of wave 7, merge side, on the fake GitHub (leftovers7-merge)", () => {
  // Real git on the testenv fake GitHub (its REST API and git smart HTTP) behind the daemon's
  // GitHub client, as the Merge in the app block above.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let token = "";
  let work = "";
  const FULL = "alice/l7m";
  const REPO = { owner: "alice", name: "l7m" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fr-ui-real-l7m-gh-"));
    const clock = new SystemClock();
    host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "l7m",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# l7m\n" },
    });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, token);
    ({ rt, client } = await composeWithRolePlayer(
      {},
      {
        gitHost: new GitHubHost({ token, baseUrl: host.baseUrl, clock }),
        vault,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl: "sqlite::memory:",
        },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** A done task with its pull request on the host, as a session leaves it. */
  async function doneTask(
    projectId: string,
    title: string,
    file: string,
    opts: { from?: string; dependsOn?: string[]; record?: boolean; content?: string } = {},
  ) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: opts.dependsOn ?? [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    const dir = join(work, `wt-${task.id}`);
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(FULL));
    const branch = `fr/${file.replace(/\W+/g, "-")}-${task.id.slice(-6).toLowerCase()}`;
    await git.createBranch(branch, opts.from ? `origin/${opts.from}` : "origin/main");
    writeFileSync(join(dir, file), opts.content ?? `export const f = "${file}";\n`);
    await git.commitAll(`Add ${file}`);
    await git.push(branch);
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: new SystemClock() });
    const pr = await github.createPullRequest(REPO, {
      title,
      body: "",
      head: branch,
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
    if (opts.record !== false)
      await rt.store.mergeRecord.pin({
        task_id: task.id,
        project_id: projectId,
        agent_id: rt.agent.id,
        pr_number: pr.number,
        pr_url: pr.htmlUrl,
        reviewed_head_sha: pr.head.sha,
        author_agent: rt.agent.id,
      });
    return { task, pr, branch };
  }

  const checkRun = async (
    sha: string,
    status: "in_progress" | "completed",
    conclusion?: string,
  ) => {
    const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ci/test",
        head_sha: sha,
        status,
        ...(conclusion ? { conclusion } : {}),
      }),
    });
    expect(res.status).toBe(201);
  };
  const setMode = async (projectId: string, mode: "you" | "after_review") => {
    const p = await rt.store.project.mustGet(projectId);
    await rt.store.project.patch(projectId, { settings: { ...p.settings, merge_mode: mode } });
  };

  it("'Merge automatically after review': an accepted task whose merge has not run reads the same on the Tasks tab and the Overview, and neither says it waits for you (R-queuedwords)", async () => {
    const project = await client.createProject({ name: "Auto words", goal: "x", repos: [FULL] });
    await setMode(project.id, "after_review");
    const a = await doneTask(project.id, "Add the queue page", "queue.ts");
    expect((await rt.store.mergeRecord.forTask(a.task.id))?.state).toBe("queued");
    const label = (await client.task(a.task.id)).task.display?.label;
    const row = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.number === a.pr.number,
    );
    expect(row?.merge?.state).toBe("merging");
    expect(label).toBe("Accepted · merging");
    expect(label).not.toMatch(/waiting for you/);
    expect((await client.tasks(project.id)).find((t) => t.id === a.task.id)?.display?.label).toBe(
      "Accepted · merging",
    );
    // "You press Merge" (the default): both say it waits for the click.
    await setMode(project.id, "you");
    expect((await client.task(a.task.id)).task.display?.label).toBe(
      "Accepted · waiting for you to merge",
    );
    expect(
      (await client.projectPullRequests(project.id)).waiting.find((w) => w.number === a.pr.number)
        ?.merge,
    ).toMatchObject({ state: "ready", canMerge: true });
  }, 120_000);

  it("a Merge that waited for its checks and merged later by the retry pass is one Update in GET /inbox (R-mergeretry)", async () => {
    const project = await client.createProject({ name: "Merged later", goal: "x", repos: [FULL] });
    const c = await doneTask(project.id, "Add the late notes", "late-notes.ts");
    await checkRun(c.pr.head.sha, "in_progress");
    expect((await client.mergePullRequest(project.id, c.pr.number)).state).toBe("queued");
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(c.task.id))?.state === "waiting_checks",
      "the record to wait for its checks",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(c.task.id)),
      30_000,
    );
    // W14-2 (polish-words): the Update is named by its project.
    const merged = `Merged later: merged #${c.pr.number}, "Add the late notes".`;
    // While the checks run, the retry pass says nothing.
    await rt.merge.retryWaiting();
    expect((await client.inbox(rt.human.id)).messages.map((m) => m.body)).not.toContain(merged);
    await checkRun(c.pr.head.sha, "completed", "success");
    await rt.merge.retryWaiting();
    expect((await rt.store.mergeRecord.forTask(c.task.id))?.state).toBe("merged");
    const bodies = (await client.inbox(rt.human.id)).messages.map((m) => m.body);
    expect(bodies.filter((b) => b === merged)).toHaveLength(1);
  }, 120_000);

  /** Merge on the click and wait until the record says merged. */
  const mergeNow = async (projectId: string, n: number, taskId: string) => {
    expect((await client.mergePullRequest(projectId, n)).state).toBe("queued");
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(taskId))?.state === "merged",
      `#${n} to be merged`,
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(taskId)),
      30_000,
    );
  };

  it("a pull request that builds on a task not accepted yet offers no Merge and says so; after an in-app Merge, Files lists the merged file with no watcher poll (R-testpaths)", async () => {
    const project = await client.createProject({ name: "Not yet", goal: "x", repos: [FULL] });
    const a = await doneTask(project.id, "Add the shelf", "shelf.ts");
    const b = await doneTask(project.id, "Add the shelf label", "shelf-label.ts", {
      from: a.branch,
      dependsOn: [a.task.id],
    });
    // A goes back to review (sent back): B's row cannot merge until A is accepted again.
    await rt.store.task.patch(a.task.id, { status: "in_review" });
    const rowB = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.number === b.pr.number,
    );
    expect(rowB?.merge).toMatchObject({
      state: "blocked",
      canMerge: false,
      sentence: `#${b.pr.number} builds on "Add the shelf", which is not accepted yet: it can merge once that one is.`,
    });
    // Accepted again: the chain merges in the app, and Files has both files at once.
    await rt.store.task.patch(a.task.id, { status: "done" });
    const paths = async () => (await client.projectFiles(project.id)).entries.map((e) => e.path);
    expect(await paths()).not.toContain("shelf-label.ts");
    await mergeNow(project.id, b.pr.number, b.task.id);
    await eventually(
      async () => {
        const now = await paths();
        return now.includes("shelf.ts") && now.includes("shelf-label.ts");
      },
      "Files to list the merged files with no watcher poll (at least 10 s)",
      async () => JSON.stringify(await paths()),
      15_000,
    );
  }, 120_000);

  it("Redo while the task's work is being taken out is refused in words; the take-out stays listed and the task stays as it was (R-pin)", async () => {
    const project = await client.createProject({ name: "Taking out", goal: "x", repos: [FULL] });
    const a = await doneTask(project.id, "Add the old banner", "banner.ts");
    await mergeNow(project.id, a.pr.number, a.task.id);
    const out = await client.takeOutTask(a.task.id);
    expect(out.state).toBe("opened");
    const n = out.number ?? 0;
    const shown = (await client.task(a.task.id)).task;
    expect(shown.display?.takeOut).toMatchObject({ state: "open", number: n });
    const refused = await client
      .taskAction(a.task.id, { action: "redo", version: shown.version })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toContain(
      `"Add the old banner" is being taken out in #${n}: merge or close #${n} first, then redo it.`,
    );
    const after = (await client.task(a.task.id)).task;
    expect(after.status).toBe("done");
    expect(after.display?.takeOut).toMatchObject({ state: "open", number: n });
    const rows = (await client.projectPullRequests(project.id)).waiting;
    expect(rows.find((w) => w.kind === "take_out" && w.number === n)).toBeTruthy();
    // Merged on the click, the take-out is finished: Redo is taken again.
    expect((await client.mergePullRequest(project.id, n)).state).toBe("queued");
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(a.task.id))?.take_out_state === "merged",
      `#${n} to be merged`,
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(a.task.id)),
      30_000,
    );
    const now = (await client.task(a.task.id)).task;
    const redone = await client.taskAction(a.task.id, { action: "redo", version: now.version });
    expect(redone.status).toBe("ready");
  }, 120_000);
});

// leftovers7-session (R-estimates): the plan card showed the plan's bounded guess per task while
// the Start dialog priced the same tasks with the learned estimates (`planEstimateUsdMicro`), so
// after a few tasks of a kind the two screens gave different amounts. `GET /inbox` now gives
// each plan task the figure the Start dialog will show (`planTasks[].estimateUsdMicro`), and the
// task keeps the plan's guess as its own estimate.
describe("the UI client against the real daemon: the plan card's figure is the Start dialog's (leftovers7-session)", () => {
  it("after three samples of a kind at half the guess, each plan task's figure equals what the Start dialog prices for the task it writes", async () => {
    // Each stand-in reply waits, so nothing the started session runs finishes (and teaches the
    // estimates more) before the figures are compared.
    const { rt, client } = await composeWithRolePlayer({ FORERUNNER_BENCH_DELAY_MS: "3000" });
    try {
      const brief = "A page that shows a random quote";
      const project = await client.createProject({
        name: "Learned quote",
        goal: goalFromBrief(brief),
        brief,
        intake: true,
      });
      await rt.intake.inFlight(project.id);
      const me = await client.me();
      const cardNow = async () =>
        (await client.inbox(me.id)).requests.find(
          (r) => r.projectId === project.id && r.status === "open",
        );
      const before = await cardNow();
      if (!before?.planTasks) throw new Error(`no plan card: ${JSON.stringify(before)}`);
      // Three finished tasks of each kind the plan holds, at half their estimates.
      for (const specialist of new Set(before.planTasks.map((t) => t.specialist))) {
        if (!specialist) continue;
        for (let tier = 0; tier <= 3; tier++)
          for (let i = 0; i < 3; i++)
            rt.estimates.observeTask(
              {
                id: `sample-${specialist}-${tier}-${i}`,
                specialist,
                risk_tier: tier,
                est_cost_usd_micro: 100_000,
                budget_usd_micro: 0,
              },
              { usdMicro: 50_000, wallMs: 60_000, at: new Date().toISOString() },
            );
      }
      const card = await cardNow();
      if (!card?.planTasks) throw new Error("no plan card after the samples");
      const view = intakeCardOf(card.changeCard);
      if (!view) throw new Error("the plan card did not read as one");
      const guess = new Map(view.firstSession.items.map((i) => [i.key, i.estimateUsdMicro]));
      const shown = card.planTasks.filter((t) => t.specialist !== null && guess.has(t.key ?? ""));
      expect(shown.length).toBeGreaterThan(0);
      // The card's figure is no longer the plan's own guess (before: always the guess).
      for (const t of shown)
        expect(t.estimateUsdMicro, t.title).toBeLessThan(guess.get(t.key ?? "") ?? 0);

      await client.answerRequest(card.id, { version: card.version, answer: "Approve and start" });
      const tasks = await rt.store.task.list({ project_id: project.id } as never, { limit: 50 });
      for (const t of shown) {
        const row = tasks.find((r) => r.title === t.title);
        if (!row) throw new Error(`no task "${t.title}"`);
        // The task keeps the plan's guess; the Start dialog prices it with what was learned,
        // which is what the card showed.
        expect(row.est_cost_usd_micro, t.title).toBe(guess.get(t.key ?? ""));
        expect(planEstimateUsdMicro(rt.estimates, row), t.title).toBe(t.estimateUsdMicro);
      }
      // Nothing is left running for the next case.
      for (const s of await client.sessions({ projectId: project.id }))
        if (s.status === "running") await client.stopSession(s.id).catch(() => undefined);
      await eventually(
        async () =>
          (await client.sessions({ projectId: project.id })).every((s) => s.status !== "running"),
        "the session Approve and start began to end",
        async () => (await client.sessions({ projectId: project.id })).map((s) => s.status).join(),
        30_000,
      );
    } finally {
      await rt.close();
    }
  }, 120_000);
});

/**
 * leftovers7-web (wave 14): the Start check while every ready task's credential waits
 * (R-startcred). The client's `startCheck` against the real daemon, as the Start dialog reads it.
 */
describe("leftovers7-web: the Start check names a credential wait (R-startcred)", () => {
  it("with the only key refused and two ready tasks, start-check says they wait for a new key, with where to save one", async () => {
    const refused = ["sk-ant-api03-", "refused", "8".repeat(40)].join(""); // not-a-secret
    const clock = new SimulatedClock("2026-11-08T08:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-startcred-"));
    const model = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    const standIn = messagesApiStandIn({
      model,
      clock,
      answerFor: keyRule({ refuse: ["refused"] }),
    });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ anthropic_api_key: refused }),
      fetchImpl: standInFetch(standIn, {
        fallback: async () => new Response("not here", { status: 404 }),
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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
    try {
      const notes = await client.createProject({ name: "Notes", goal: "Two notes" });
      for (const title of ["Write note A", "Write note B"])
        await client.createTask(notes.id, {
          title,
          outcome: `${title} is written`,
          acceptanceCriteria: ["it is written"],
          priority: "medium",
          status: "ready",
          dependsOn: [],
          budgetUsdMicro: 0,
          specialist: "coder",
          riskTier: 0,
        });
      // Before any session: the key is not marked yet, so the check cannot know (it says what
      // the session runs). One session meets the refusal; from then on the check says so.
      const agentId = (await client.agents())[0]?.id ?? "";
      const first = await client.startSession({ agentId, projectId: notes.id });
      const sessionId = first.session?.id ?? "";
      await eventually(
        async () =>
          !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
        "the session to end",
        async () => (await client.session(sessionId)).status,
        20_000,
      );
      const check = await client.startCheck(notes.id);
      // Before: blocked null, the dialog said 'This session runs "Write note A" ...'.
      expect(check.blocked).toEqual({
        kind: "nothing_runnable",
        sentence: "Nothing can run yet. Waits for a new API key: save one in Settings.",
        action: { kind: "link", label: "Save a new key", to: "/setup" },
      });
      // R-runsonrefused: New task's line (and the plan card's) says the wait, never "Runs on
      // your API key" for a key Anthropic refused.
      const settings = await client.modelSettings(undefined, notes.id);
      for (const name of ["coder", "researcher"]) {
        const runsOn = settings.specialists.find((s) => s.name === name)?.runsOn;
        expect(runsOn, name).toEqual({
          kind: "api_key",
          line: "Waits for a new API key: save one in Settings.",
        });
      }
      // The rows say the same, and the wait is kept, so a new key starts the work by itself.
      expect((await client.tasks(notes.id)).map((t) => t.display?.label)).toEqual([
        "Waits for a new API key",
        "Waits for a new API key",
      ]);
    } finally {
      await rt.close();
    }
  }, 120_000);
});

/**
 * leftovers7-web (wave 14): GET /inbox asks the credential chooser once per request for what does
 * not change between a plan card's tasks (R-inboxperf): before, every task of every open plan card
 * asked the vault for every source on every poll (slow on an OS keyring).
 */
describe("leftovers7-web: the Inbox reads the credentials once per request (R-inboxperf)", () => {
  it("a plan card with five tasks: GET /inbox asks the vault at most once per source", async () => {
    const key = ["sk-ant-api03-", "inboxperf", "1".repeat(40)].join(""); // not-a-secret
    const oauth = ["sk-ant-oat01-", "inboxperf", "2".repeat(40)].join(""); // not-a-secret
    let asked = 0;
    class CountingVault extends MemoryVault {
      override async has(name: string): Promise<boolean> {
        asked++;
        return super.has(name);
      }
    }
    const { rt, client } = await composeWithRolePlayer(
      {},
      { vault: new CountingVault({ anthropic_api_key: key, anthropic_oauth_token: oauth }) },
    );
    try {
      const project = await client.createProject({ name: "Five", goal: "Five pages" });
      const me = await client.me();
      const tasks = [1, 2, 3, 4, 5].map((n) => ({
        key: `p${n}`,
        title: `Build page ${n}`,
        outcome: `page${n}.html`,
        acceptanceCriteria: [],
        specialist: "coder",
      }));
      await rt.store.humanRequest.insert({
        human_id: me.id,
        project_id: project.id,
        task_id: null,
        session_id: null,
        kind: "approval",
        why: 'Intake for "Five": 5 tasks.',
        steps: [],
        options: ["approve", "reject"],
        blocking: true,
        risk: "medium",
        change_card: {
          key: `intake:${project.id}`,
          project_id: project.id,
          proposal: {
            plan: { reason: "planned", milestones: [], tasks },
            docs: {},
            firstSession: { summary: "", items: [] },
          },
        },
        status: "open",
        answer: null,
      } as never);
      const sources = (await rt.store.billingSource.list({} as never, { limit: 10 })).filter(
        (s) => s.credential_ref,
      ).length;
      asked = 0;
      const card = (await client.inbox(me.id)).requests.find((r) => r.projectId === project.id);
      // The person still sees where each task runs.
      expect(card?.planTasks).toHaveLength(5);
      expect(card?.planTasks?.every((t) => t.runsOn !== undefined)).toBe(true);
      // Before: 5 tasks x every source.
      expect(asked).toBeLessThanOrEqual(sources);
    } finally {
      await rt.close();
    }
  }, 120_000);
});

// leftovers7-merge2 (ADR 0111 amended): an open task pull request that stopped merging cleanly
// into main after another merge is said once (R-conflict): one card after the watcher's poll,
// none more later, and the Overview offers no Merge that cannot work.
describe("the UI client against the real daemon: leftovers of wave 7, merge side, part 2 (leftovers7-merge2)", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let github: GitHubHost;
  let token = "";
  let work = "";
  const FULL = "alice/l7m2";
  const REPO = { owner: "alice", name: "l7m2" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fr-ui-real-l7m2-"));
    const clock = new SystemClock();
    host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "l7m2",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# l7m2\n" },
    });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, token);
    ({ rt, client } = await composeWithRolePlayer(
      {},
      {
        gitHost: github,
        vault,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl: "sqlite::memory:",
        },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** A done task with its pull request on the host, as a session leaves it (level 2: it waits). */
  async function doneTask(projectId: string, title: string, file: string, content: string) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    const dir = join(work, `wt-${task.id}`);
    const ops = new GitOps({ cwd: dir, identity, auth: { token } });
    await ops.clone(host.cloneUrl(FULL));
    const branch = `fr/${title.toLowerCase().replace(/\W+/g, "-")}-${task.id.slice(-6).toLowerCase()}`;
    await ops.createBranch(branch, "origin/main");
    writeFileSync(join(dir, file), content);
    await ops.commitAll(title);
    await ops.push(branch);
    const pr = await github.createPullRequest(REPO, {
      title,
      body: "",
      head: branch,
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
    const pinned = await rt.store.mergeRecord.pin({
      task_id: task.id,
      project_id: projectId,
      agent_id: rt.agent.id,
      pr_number: pr.number,
      pr_url: pr.htmlUrl,
      reviewed_head_sha: pr.head.sha,
      author_agent: rt.agent.id,
    });
    await rt.store.mergeRecord.move(pinned.id, "left_to_you", {
      sentence: `#${pr.number} waits for you to merge it: press Merge on the Overview.`,
      last_outcome: "not_allowed",
    });
    return { task, pr, branch };
  }

  it("two open pull requests on one file, one merged on GitHub: one conflict card after one poll, none more at the next; the Overview no longer offers Merge on the conflicted row (R-conflict)", async () => {
    const project = await client.createProject({ name: "Two pages", goal: "x", repos: [FULL] });
    const a = await doneTask(project.id, "Write the page", "index.html", "<h1>one</h1>\n");
    const b = await doneTask(project.id, "Write the other page", "index.html", "<h1>two</h1>\n");
    const rowOf = async (n: number) =>
      (await client.projectPullRequests(project.id)).waiting.find((w) => w.number === n);
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({
      state: "left_to_you",
      canMerge: true,
    });
    await rt.githostWatcher?.pollOnce();
    const cards = async () =>
      (await client.inbox(rt.human.id)).requests.filter(
        (r) => r.taskId === b.task.id && r.status === "open",
      );
    expect(await cards()).toEqual([]);
    // The person merges the first pull request on GitHub's website.
    expect((await github.mergePullRequest(REPO, a.pr.number, { method: "merge" })).merged).toBe(
      true,
    );
    await rt.githostWatcher?.pollOnce();
    const sentence = `#${b.pr.number} conflicts with main: resolve the conflict on GitHub, or redo the task.`;
    const open = await cards();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: `"Write the other page" conflicts with main`,
      body: sentence,
    });
    expect(open[0]?.choices?.map((c) => c.label)).toEqual(["Redo", "Leave it open"]);
    // The Overview offers no Merge that cannot work, and says why on the row.
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({
      state: "blocked",
      canMerge: false,
      sentence,
    });
    // The next poll files nothing more.
    await rt.githostWatcher?.pollOnce();
    expect(await cards()).toHaveLength(1);
  }, 120_000);

  it("a copy that cannot follow a merge says so on GET /projects/:id/files, with the reason and the file; it follows again once the change is moved away (R-copystuck)", async () => {
    const project = await client.createProject({ name: "Stuck copy", goal: "x", repos: [FULL] });
    // The watcher's read of main brings this computer's copy to it.
    await rt.githostWatcher?.pollOnce();
    const first = await client.projectFiles(project.id);
    const folder = first.folder ?? "";
    expect(first.copy?.updatedAt).toBeTruthy();
    expect(first.copy?.stopped).toBeUndefined();
    // The person edits README.md in the copy; a merge on GitHub then changes README.md too.
    writeFileSync(join(folder, "README.md"), "# my own notes\n");
    await host.seedCommit(FULL, { "README.md": "# l7m2, merged\n" }, "Merge the readme", "main");
    await rt.githostWatcher?.pollOnce();
    const stuck = await client.projectFiles(project.id);
    expect(stuck.copy?.stopped).toEqual({
      reason: "changed",
      files: ["README.md"],
      line: "You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.",
    });
    expect(stuck.copy?.updatedAt).toBe(first.copy?.updatedAt);
    // Moved away (put back as it was) with the person's own git, set up as Git for Windows sets
    // it up by default (`core.autocrlf=true`, there in its system config; here in a global one,
    // so every machine runs it so): the next poll brings the copy to what is merged. Before, on
    // Windows, their git wrote the file back with CRLF, the daemon's git (`autocrlf=false`) read
    // that as still changed, and the copy never followed again (Desktop app run 42525106539).
    const windowsGit = join(work, "git-for-windows.gitconfig");
    writeFileSync(windowsGit, "[core]\n\tautocrlf = true\n");
    await run(["git", "-C", folder, "checkout", "--", "README.md"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: windowsGit },
    });
    await rt.githostWatcher?.pollOnce();
    const after = await client.projectFiles(project.id);
    expect(after.copy?.stopped).toBeUndefined();
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("# l7m2, merged\n");
  }, 120_000);

  it("a Merge that waited for its checks and was merged later by the retry pass raises one notification beside its Update (leftovers7-merge2)", async () => {
    const project = await client.createProject({ name: "Later merge", goal: "x", repos: [FULL] });
    const c = await doneTask(project.id, "Add the late page", "late.html", "<p>late</p>\n");
    const checkRun = async (status: "in_progress" | "completed", conclusion?: string) => {
      const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "ci/test",
          head_sha: c.pr.head.sha,
          status,
          ...(conclusion ? { conclusion } : {}),
        }),
      });
      expect(res.status).toBe(201);
    };
    await checkRun("in_progress");
    expect((await client.mergePullRequest(project.id, c.pr.number)).state).toBe("queued");
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(c.task.id))?.state === "waiting_checks",
      "the record to wait for its checks (at least 10 s)",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(c.task.id)),
      30_000,
    );
    const merged = () =>
      rt.notifier
        .recent({ humanId: rt.human.id, limit: 200 })
        .filter((r) => r.notification.kind === "pr_merged");
    expect(merged()).toEqual([]);
    await checkRun("completed", "success");
    await rt.merge.retryWaiting();
    expect((await rt.store.mergeRecord.forTask(c.task.id))?.state).toBe("merged");
    await eventually(
      async () => merged().length > 0,
      "the merged-later notification (at least 10 s)",
      async () => JSON.stringify(merged().map((r) => r.notification.title)),
      15_000,
    );
    expect(merged().map((r) => [r.notification.title, r.notification.body])).toEqual([
      [
        `Later merge: merged #${c.pr.number}`,
        '"Add the late page" is merged. Open the project to see it.',
      ],
    ]);
    expect(merged()[0]?.notification.link).toBe(`/projects/${project.id}`);
    // The Update in the Inbox, once.
    const bodies = (await client.inbox(rt.human.id)).messages.map((m) => m.body);
    expect(
      bodies.filter((b) => b === `Later merge: merged #${c.pr.number}, "Add the late page".`),
    ).toHaveLength(1);
    await rt.merge.retryWaiting();
    expect(merged()).toHaveLength(1);
  }, 120_000);

  it("a conflict the person resolves on GitHub with a commit of their own: the row still offers no Merge and says the pull request changed after the review, and the one card says so too (R-conflict fix-up)", async () => {
    const project = await client.createProject({
      name: "Resolved there",
      goal: "x",
      repos: [FULL],
    });
    const a = await doneTask(project.id, "Write the about page", "about.html", "<h1>one</h1>\n");
    const b = await doneTask(project.id, "Write another about page", "about.html", "<h1>2</h1>\n");
    const rowOf = async (n: number) =>
      (await client.projectPullRequests(project.id)).waiting.find((w) => w.number === n);
    const cards = async () =>
      (await client.inbox(rt.human.id)).requests.filter(
        (r) => r.taskId === b.task.id && r.status === "open",
      );
    expect((await github.mergePullRequest(REPO, a.pr.number, { method: "merge" })).merged).toBe(
      true,
    );
    await rt.githostWatcher?.pollOnce();
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({ state: "blocked", canMerge: false });
    expect(await cards()).toHaveLength(1);
    // The person resolves it on GitHub, as the notice says (main's version kept on the branch).
    await host.seedCommit(FULL, { "about.html": "<h1>one</h1>\n" }, "Resolve", b.branch);
    expect((await github.getPullRequest(REPO, b.pr.number)).mergeable).toBe(true);
    await rt.githostWatcher?.pollOnce();
    // Before (the review of leftovers7-merge2): the row offered Merge again, and pressing it was
    // refused ("changed after the review") with a second card.
    const moved = `#${b.pr.number} changed after the review: look at the new commits, then merge it yourself or redo the task.`;
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({
      state: "blocked",
      canMerge: false,
      sentence: moved,
    });
    const open = await cards();
    expect(open.map((r) => ({ title: r.title, body: r.body }))).toEqual([
      {
        title: `The critic accepted "Write another about page", but pull request #${b.pr.number} was not merged`,
        body: moved,
      },
    ]);
    expect(open[0]?.choices?.map((c) => c.label)).toEqual(["Redo", "Leave it open"]);
    expect(open[0]?.details).toEqual([
      "Look at the commits pushed after the review",
      "Merge it yourself or ask for a new review",
    ]);
    await rt.githostWatcher?.pollOnce();
    expect(await cards()).toHaveLength(1);
    expect((await github.getPullRequest(REPO, b.pr.number)).merged).toBe(false);
  }, 120_000);

  it("a conflict that goes away on main leaves the reviewed version as it was: the card closes, the row offers Merge again, and pressing it merges the pull request (R-conflict fix-up)", async () => {
    const project = await client.createProject({ name: "Gone again", goal: "x", repos: [FULL] });
    await host.seedCommit(FULL, { "title.txt": "base\n" }, "Add a title", "main");
    const a = await doneTask(project.id, "Retitle it", "title.txt", "one\n");
    const b = await doneTask(project.id, "Retitle it again", "title.txt", "two\n");
    const rowOf = async (n: number) =>
      (await client.projectPullRequests(project.id)).waiting.find((w) => w.number === n);
    const cards = async () =>
      (await client.inbox(rt.human.id)).requests.filter(
        (r) => r.taskId === b.task.id && r.status === "open",
      );
    expect((await github.mergePullRequest(REPO, a.pr.number, { method: "merge" })).merged).toBe(
      true,
    );
    await rt.githostWatcher?.pollOnce();
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({ state: "blocked", canMerge: false });
    expect(await cards()).toHaveLength(1);
    // Main's title goes back: the reviewed head merges cleanly as it is.
    await host.seedCommit(FULL, { "title.txt": "base\n" }, "Put the title back", "main");
    const pr = await github.getPullRequest(REPO, b.pr.number);
    expect([pr.mergeable, pr.head.sha]).toEqual([true, b.pr.head.sha]);
    await rt.githostWatcher?.pollOnce();
    expect(await cards()).toEqual([]);
    expect((await rowOf(b.pr.number))?.merge).toMatchObject({
      state: "left_to_you",
      canMerge: true,
      sentence: null,
    });
    // The person presses Merge on the row: it merges.
    await client.mergePullRequest(project.id, b.pr.number);
    await eventually(
      async () => (await rt.store.mergeRecord.forTask(b.task.id))?.state === "merged",
      "the pull request merged after the person's Merge (at least 10 s)",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(b.task.id)),
      30_000,
    );
    expect((await github.getPullRequest(REPO, b.pr.number)).merged).toBe(true);
  }, 120_000);
});

describe("leftovers7-tailmerge, wave 13", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let host: FakeGitHost;
  let github: GitHubHost;
  let token = "";
  let work = "";
  const FULL = "alice/l7tm";
  const REPO = { owner: "alice", name: "l7tm" };
  const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fr-ui-real-l7tm-"));
    const clock = new SystemClock();
    host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "l7tm",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# l7tm\n" },
    });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, token);
    ({ rt, client } = await composeWithRolePlayer(
      {},
      {
        gitHost: github,
        vault,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl: "sqlite::memory:",
        },
      },
    ));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /**
   * A done task with its pull request on the host and its folder where the daemon keeps task
   * folders, as a session leaves it (level 2: it waits for the person's Merge).
   */
  async function doneTask(projectId: string, title: string, file: string, content: string) {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    const dir = join(rt.dirs.worktrees, task.id);
    const ops = new GitOps({ cwd: dir, identity, auth: { token } });
    await ops.clone(host.cloneUrl(FULL));
    const branch = `fr/${title.toLowerCase().replace(/\W+/g, "-")}-${task.id.slice(-6).toLowerCase()}`;
    await ops.createBranch(branch, "origin/main");
    writeFileSync(join(dir, file), content);
    await ops.commitAll(title);
    await ops.push(branch);
    const pr = await github.createPullRequest(REPO, {
      title,
      body: "",
      head: branch,
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch });
    const pinned = await rt.store.mergeRecord.pin({
      task_id: task.id,
      project_id: projectId,
      agent_id: rt.agent.id,
      pr_number: pr.number,
      pr_url: pr.htmlUrl,
      reviewed_head_sha: pr.head.sha,
      author_agent: rt.agent.id,
    });
    await rt.store.mergeRecord.move(pinned.id, "left_to_you", {
      sentence: `#${pr.number} waits for you to merge it: press Merge on the Overview.`,
      last_outcome: "not_allowed",
    });
    return { task, pr, branch, dir };
  }

  it("Merge pressed while a rebuild is owed for a task folder holding changes nobody committed: the Overview row and the Tasks row say why it waits and what to do, never 'Merging…', and nothing merges (TM-4)", async () => {
    const project = await client.createProject({ name: "Owed rebuild", goal: "x", repos: [FULL] });
    const a = await doneTask(project.id, "Write the page", "page.html", "<h1>page</h1>\n");
    const b = await doneTask(project.id, "Write the footer", "footer.html", "<p>footer</p>\n");
    // B's branch owes a rebuild for A (A's pull request was closed, say), and B's folder holds a
    // change nobody committed, so the rebuild cannot run (R-owed, as the watcher's sweep marks it).
    expect(await rt.store.mergeRecord.oweRebuild(b.task.id, a.task.id)).toBe(true);
    writeFileSync(join(b.dir, "notes.txt"), "my notes\n");
    // The person presses Merge on B's row: the answer comes at once, the merge waits (R-lock).
    const answer = await client.mergePullRequest(project.id, b.pr.number);
    expect(answer.state).not.toBe("refused");
    // W15-05: the answer says why it waits, never "Merging #N." (live check 2, F4).
    expect(answer.sentence).toBe(
      `#${b.pr.number} waits for changes left in its task's folder: take them out or redo the task.`,
    );
    await eventually(
      async () =>
        (await rt.store.mergeRecord.forTask(b.task.id))?.last_outcome === "owed_folder_changes",
      "the merge step to say the folder's changes hold the merge (at least 10 s)",
      async () => JSON.stringify(await rt.store.mergeRecord.forTask(b.task.id)),
      30_000,
    );
    const sentence = `#${b.pr.number} waits for changes left in its task's folder: take them out or redo the task.`;
    // Before: the row read "Merging…" (state queued) with no reason, and the Tasks row
    // "Accepted · merging", for as long as the folder held the change.
    const row = (await client.projectPullRequests(project.id)).waiting.find(
      (w) => w.number === b.pr.number,
    );
    expect(row?.merge).toMatchObject({ state: "waiting_checks", canMerge: false, sentence });
    const taskRow = (await client.tasks(project.id)).find((t) => t.id === b.task.id);
    expect(taskRow?.display).toMatchObject({
      label: "Accepted · merge waits for you",
      detail: sentence,
    });
    expect((await github.getPullRequest(REPO, b.pr.number)).merged).toBe(false);
  }, 120_000);

  it("Create a repository: Preview files one card, and the No the dialog sends when it is closed leaves nothing open in the Inbox (TM-8)", async () => {
    const project = await client.createProject({ name: "No repo yet", goal: "x" });
    const cards = async () =>
      (await client.inbox(rt.human.id)).requests.filter(
        (r) => r.projectId === project.id && r.status === "open",
      );
    // Preview: exactly the call the project page's dialog makes.
    const preview = await client.executeCommands({
      commands: [{ name: "repo.create", params: { project: project.id, private: true } }],
      wordsUsed: "Create a repository (project page)",
      source: "ui",
      projectId: project.id,
    });
    expect(preview.status).toBe("pending");
    expect(await cards()).toHaveLength(1);
    // The dialog closed with × or Escape answers it No (CreateRepoDialog's finish).
    await client.confirmCommand(preview.pendingId ?? "", { answer: "no" });
    expect(await cards()).toEqual([]);
    expect((await client.project(project.id)).repos).toEqual([]);
  }, 120_000);
});

/**
 * leftovers7-tailrun (wave 13): the run-side leftovers of waves 12 and 14, through the UI's client
 * against the real daemon.
 */
describe("leftovers7-tailrun, wave 13", () => {
  it("TR-2: looking at the Start check while the only key rests records nothing; Start keeps the wait and that work starts at the reset", async () => {
    const key = ["sk-ant-api03-", "tailrun", "5".repeat(40)].join(""); // not-a-secret
    const clock = new SimulatedClock("2026-11-09T08:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-tailrun-"));
    const model = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    const standIn = messagesApiStandIn({ model, clock, answerFor: keyRule({}) });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ anthropic_api_key: key }),
      fetchImpl: standInFetch(standIn, {
        fallback: async () => new Response("not here", { status: 404 }),
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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
    const waitsOnKey = async () => {
      const src = (await rt.store.billingSource.list({} as never, { limit: 20 })).find(
        (s) => s.kind === "api_key",
      );
      const list = Array.isArray(src?.limits.waiting) ? src.limits.waiting : [];
      return (list as { projectId: string }[]).map((w) => w.projectId);
    };
    try {
      const projects = [];
      for (const name of ["Looked", "Started"]) {
        const p = await client.createProject({ name, goal: `${name} notes` });
        await client.createTask(p.id, {
          title: `Write the ${name} note`,
          outcome: "The note is written",
          acceptanceCriteria: ["it is written"],
          priority: "medium",
          status: "ready",
          dependsOn: [],
          budgetUsdMicro: 0,
          specialist: "coder",
          riskTier: 0,
        });
        projects.push(p);
      }
      const [looked, started] = projects as [(typeof projects)[0], (typeof projects)[0]];
      // The only key rests until 08:30 UTC (09:30 in Zurich): another session met its limit.
      const src = (await rt.store.billingSource.list({} as never, { limit: 20 })).find(
        (s) => s.kind === "api_key",
      );
      if (!src) throw new Error("no api_key source");
      await rt.store.billingSource.patch(src.id, {
        limits: { ...src.limits, restingUntil: "2026-11-09T08:30:00Z" },
      });
      // The Start dialog opens on both projects and closes again.
      for (const p of [looked, started]) {
        const check = await client.startCheck(p.id);
        // No wait is kept yet, so the line says what Start does, and Start stays pressable.
        expect(check.blocked).toEqual({
          kind: "nothing_runnable",
          sentence:
            "Nothing can run until 09:30 (your API key's limit). Press Start and it runs then.",
          action: null,
          startable: true,
        });
      }
      // Looking recorded nothing (before: both projects' waits were kept on the key).
      expect(await waitsOnKey()).toEqual([]);
      // Start on one of them, as the dialog sends it: its session meets the wait and keeps it.
      const agentId = (await client.agents())[0]?.id ?? "";
      const first = await client.startSession({ agentId, projectId: started.id });
      const sessionId = first.session?.id ?? "";
      await eventually(
        async () =>
          !["running", "paused", "planned"].includes((await client.session(sessionId)).status),
        "the session that met the wait to end",
        async () => (await client.session(sessionId)).status,
        20_000,
      );
      expect(await waitsOnKey()).toEqual([started.id]);
      // From then on its check says the work starts by itself (true now), with Start off.
      expect((await client.startCheck(started.id)).blocked).toEqual({
        kind: "nothing_runnable",
        sentence:
          "Nothing can run yet. Waits until 09:30 (your API key's limit) and starts by itself.",
        action: null,
      });
      // At the reset: the work Start waited for starts by itself; the project only looked at
      // does not (before: both started).
      clock.set(Date.parse("2026-11-09T08:31:00Z"));
      expect(await rt.billing.waits.wake()).toBe(1);
      const triggers = async (projectId: string) =>
        (await rt.store.session.list({ project_id: projectId } as never, { limit: 10 })).map(
          (s) => s.trigger,
        );
      await eventually(
        async () => (await triggers(started.id)).includes("budget_reset"),
        "the session started at the reset",
        async () => (await triggers(started.id)).join(", "),
        15_000,
      );
      expect((await triggers(started.id)).sort()).toEqual(["budget_reset", "manual"]);
      expect(await triggers(looked.id)).toEqual([]);
    } finally {
      await rt.kill.stop("all", "test over", { by: "you", freeze: false }).catch(() => undefined);
      await rt.close();
    }
  }, 120_000);

  it("TR-11: New task's runs-on line for words that need the owner's decision is the API key's, before Create", async () => {
    const key = ["sk-ant-api03-", "newtaskwords", "6".repeat(40)].join(""); // not-a-secret
    const oauth = ["sk-ant-oat01-", "newtaskwords", "7".repeat(40)].join(""); // not-a-secret
    const { rt, client } = await composeWithRolePlayer(
      {},
      {
        vault: new MemoryVault({
          [SECRET_NAMES.anthropic]: key,
          [SECRET_NAMES.anthropicOauth]: oauth,
        }),
      },
    );
    try {
      const project = await client.createProject({ name: "Hosting", goal: "A hosting page" });
      const coderLine = async (words?: { title?: string; outcome?: string; criteria?: string[] }) =>
        (await client.modelSettings(undefined, project.id, words)).specialists.find(
          (s) => s.name === "coder",
        )?.runsOn ?? null;
      // The specialist alone, or plain words: the subscription first, nothing to say.
      expect((await coderLine())?.line ?? null).toBeNull();
      expect(
        (await coderLine({ title: "Write the hosting page", outcome: "The page lists hosts" }))
          ?.line ?? null,
      ).toBeNull();
      // Words that need the owner's decision: only the API key can ask them while it works.
      // Before: the route took no words, so New task said nothing and the task ran on the key.
      expect(
        await coderLine({
          title: "Write the hosting page",
          outcome: "The page names the owner's choice of hosting",
        }),
      ).toEqual({
        kind: "api_key",
        line: "Runs on your API key: only it can ask you questions while it works here.",
      });
      // The criteria count too, one per line.
      expect(
        (
          await coderLine({
            title: "Write the hosting page",
            criteria: ["It is reachable", "It uses the owner's choice of host"],
          })
        )?.kind,
      ).toBe("api_key");
    } finally {
      await rt.close();
    }
  }, 120_000);
  it("TR-12: while a planning call holds the agent the Start check says so; a Start queues behind it", async () => {
    const { rt, client } = await composeWithRolePlayer({});
    try {
      const project = await client.createProject({ name: "Planned", goal: "Two notes" });
      await client.createTask(project.id, {
        title: "Write note A",
        outcome: "note A is written",
        acceptanceCriteria: ["it is written"],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
        specialist: "coder",
        riskTier: 0,
      });
      const agentId = (await client.agents())[0]?.id ?? "";
      const idle = await client.startCheck(project.id);
      expect([idle.busy, idle.planning]).toEqual([false, false]);
      // Another project's plan is being drafted (New project with a brief): it holds the agent.
      const release = rt.scheduler.hold(agentId);
      try {
        const check = await client.startCheck(project.id);
        // Before: busy false, so the dialog said "This session runs ..." as if it started now.
        expect(check.busy).toBe(true);
        expect(check.planning).toBe(true);
        expect(check.blocked).toBeNull();
        const started = await client.startSession({ agentId, projectId: project.id });
        expect(started.result).toBe("queued");
      } finally {
        release();
      }
      // The plan is drafted: the start that waited runs; nothing holds the agent any more.
      const after = await client.startCheck(project.id);
      expect(after.planning).toBe(false);
    } finally {
      await rt.kill.stop("all", "test over", { by: "you", freeze: false }).catch(() => undefined);
      await rt.close();
    }
  }, 120_000);
});

describe("polish-words, wave 13", () => {
  // The words the routes serve (design §5), read through the UI's own client against the real
  // daemon: the project's status line, the Tasks rows, the costs, the reviews, a session's end.
  let rt: RuntimeApp;
  let client: DaemonClient;
  let bench: BenchOptions;

  beforeAll(async () => {
    ({ rt, client, bench } = await composeWithRolePlayer({}));
  }, 60_000);
  afterAll(async () => {
    await rt?.close();
  });

  const seedTask = (
    projectId: string,
    title: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number }> =>
    rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} is done`,
      acceptance_criteria: ["it is done"],
      risk_tier: 1,
      status: "done",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
      ...over,
    } as never) as never;

  const card = async (
    projectId: string,
    taskId: string,
    changeCard: Record<string, unknown>,
    options: string[],
  ) => {
    const me = await client.me();
    return rt.store.humanRequest.insert({
      human_id: me.id,
      project_id: projectId,
      task_id: taskId,
      session_id: null,
      kind: "approval",
      why: "seed",
      steps: [],
      options,
      blocking: true,
      risk: "medium",
      change_card: changeCard,
      author_agent: rt.agent.id,
    } as never);
  };

  it("a finished folder project's line is 'Done: all N tasks.' with no path; Open your files opens Files (later #53, #54)", async () => {
    const project = await client.createProject({ name: "Notes", goal: "A notes page" });
    await seedTask(project.id, "Write the notes in notes.md");
    await seedTask(project.id, "Check the notes");
    const line = (await client.project(project.id)).statusLine;
    expect(line?.text).toBe("Done: all 2 tasks.");
    expect(line?.text.length).toBeLessThanOrEqual(80);
    expect(line?.text).not.toContain(project.id);
    expect(line?.action).toEqual({
      kind: "link",
      label: "Open your files",
      to: `/projects/${project.id}/files`,
    });
    // The Overview keeps the path (FolderPath reads `folder`).
    expect((await client.project(project.id)).folder).toContain(project.id);
  });

  it("a finished repository project says how many pull requests wait for the Merge and how many were taken out (C-58)", async () => {
    const project = await client.createProject({ name: "Guides", goal: "Two guides" });
    await rt.store.project.patch(project.id, { repos: ["o/guides"] } as never);
    const agentId = rt.agent.id;
    for (const [i, title] of ["Write the guide", "Write the notes"].entries()) {
      const url = `https://github.com/o/guides/pull/${i + 2}`;
      const t = await seedTask(project.id, title, { pr_url: url });
      const record = await rt.store.mergeRecord.pin({
        task_id: t.id,
        project_id: project.id,
        agent_id: agentId,
        pr_number: i + 2,
        pr_url: url,
        reviewed_head_sha: "a".repeat(40),
      } as never);
      await rt.store.mergeRecord.move(record.id, "left_to_you", {
        sentence: `#${i + 2} waits for you: press Merge on the Overview.`,
      });
    }
    // One merged and taken out again in #9 (merged-actions).
    const url = "https://github.com/o/guides/pull/1";
    const out = await seedTask(project.id, "Write the intro", { pr_url: url });
    const merged = await rt.store.mergeRecord.pin({
      task_id: out.id,
      project_id: project.id,
      agent_id: agentId,
      pr_number: 1,
      pr_url: url,
      reviewed_head_sha: "b".repeat(40),
    } as never);
    await rt.store.mergeRecord.patch(merged.id, {
      state: "merged",
      take_out_pr_number: 9,
      take_out_pr_url: "https://github.com/o/guides/pull/9",
      take_out_state: "merged",
    } as never);
    const line = (await client.project(project.id)).statusLine;
    expect(line?.text).toBe(
      "Done: all 3 tasks; 1 taken out. 2 pull requests wait for you to merge.",
    );
    expect(line?.text.length).toBeLessThanOrEqual(80);
    expect(line?.action).toEqual({
      kind: "link",
      label: "Open Overview",
      to: `/projects/${project.id}`,
    });
  });

  it("Answer opens the oldest card; two cards of different kinds are named by kind, not '2 questions' (later #55, L-13a)", async () => {
    const project = await client.createProject({ name: "Deploys", goal: "A deploy" });
    const deploy = await seedTask(project.id, "Deploy the page", {
      status: "needs_human",
      specialist: "ops-deploy",
    });
    const signoff = await card(
      project.id,
      deploy.id,
      {
        key: "critic:signoff",
        task_id: deploy.id,
        review_id: null,
        run_id: null,
        finding_ids: [],
        reason: "verdict",
        applied_at: null,
      },
      ["accept", "revise", "cancel"],
    );
    const one = (await client.project(project.id)).statusLine;
    expect(one?.text).toBe('Waiting for you: "Deploy the page"');
    expect(one?.action).toEqual({
      kind: "link",
      label: "Answer",
      to: `/inbox#card-${signoff.id}`,
    });
    const long = await seedTask(project.id, "Write the long guide", { status: "needs_human" });
    await card(project.id, long.id, { key: "task:budget_stop", task_id: long.id, source: "task" }, [
      "Continue",
      "Cancel task",
    ]);
    const two = (await client.project(project.id)).statusLine;
    expect(two?.text).toBe("Waiting for you: 1 sign-off and 1 paused task");
    expect(two?.action?.to).toBe(`/inbox#card-${signoff.id}`);
  });

  it("a task waiting on its sign-off reads 'Needs your sign-off' with its card's own choices; the card is unchanged (C-21, L-9)", async () => {
    const project = await client.createProject({ name: "Sign-offs", goal: "A deploy" });
    const deploy = await seedTask(project.id, "Deploy the page to the server", {
      status: "needs_human",
      specialist: "ops-deploy",
    });
    const request = await card(
      project.id,
      deploy.id,
      {
        key: "critic:signoff",
        task_id: deploy.id,
        review_id: null,
        run_id: null,
        finding_ids: [],
        reason: "verdict",
        applied_at: null,
      },
      ["accept", "revise", "cancel"],
    );
    const row = (await client.tasks(project.id)).find((t) => t.id === deploy.id);
    expect(row?.display).toMatchObject({
      key: "answer",
      label: "Needs your sign-off",
      detail: "Its card is in the Inbox: accept the work, send it back, or cancel it.",
      blocker: { kind: "card", requestId: request.id, cardKind: "signoff" },
    });
    expect(row?.display?.label).not.toMatch(/decision/);
    // The card itself: Accept the work, Send it back, Cancel task (unchanged).
    const me = await client.me();
    const shown = (await client.inbox(me.id)).requests.find((r) => r.id === request.id);
    expect(shown?.choices?.map((c) => c.label)).toEqual([
      "Accept the work",
      "Send it back",
      "Cancel task",
    ]);
  });

  it("an accepted info note shows no 'To fix' line (L-13e)", async () => {
    const project = await client.createProject({ name: "Notes review", goal: "A page" });
    const task = await seedTask(project.id, "Write the page");
    const review = await rt.store.review.insert({
      task_id: task.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 90,
      confidence: 0.9,
      verdict: "accept",
      evidence: [],
      summary: "Accepted: the changed file matches the brief.",
      author_agent: rt.criticAgent.id,
    } as never);
    await rt.store.finding.insert({
      review_id: review.id,
      task_id: task.id,
      severity: "info",
      description: "The page has no favicon.",
      required_action: "Resolve it and show the evidence",
      status: "open",
      fingerprint: "fp-favicon",
      author_agent: rt.criticAgent.id,
    } as never);
    await rt.store.finding.insert({
      review_id: review.id,
      task_id: task.id,
      severity: "medium",
      description: "The title is missing.",
      required_action: "Resolve it and show the evidence",
      status: "open",
      fingerprint: "fp-title",
      author_agent: rt.criticAgent.id,
    } as never);
    const view = await client.reviews(project.id);
    const findings = view.reviews.flatMap((r) => r.findings);
    expect(findings.find((f) => f.severity === "info")?.requiredAction).toBe("");
    // A finding that asks for a fix keeps it.
    expect(findings.find((f) => f.severity === "medium")?.requiredAction).toBe(
      "Resolve it and show the evidence",
    );
  });

  it("the Tasks screen names a specialist as the session log and the cards do (later #74)", () => {
    for (const id of [
      "writer-marketing",
      "migration-specialist",
      "data-analyst",
      "ops-deploy",
      "science-evaluator",
      "coder",
      "some_new-kind",
    ])
      expect(specialistName(id)).toBe(saidByName(id));
  });

  it("Costs name the specialist as the log does, and a model's accepted runs compare with its work runs (later #91)", async () => {
    const project = await client.createProject({ name: "Writer costs", goal: "A README" });
    const task = await client.createTask(project.id, {
      title: "Write the README in README.md",
      outcome: "README.md says what the project is",
      riskTier: 1,
      specialist: "writer-marketing",
    });
    const started = await client.startSession({ agentId: rt.agent.id, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    await eventually(
      async () => !["planned", "running"].includes((await client.session(sessionId)).status),
      "the session to end (at least 10 s of real time)",
      async () => `${(await client.task(task.id)).task.status}`,
      60_000,
    );
    expect((await client.task(task.id)).task.status).toBe("done");
    const costs = await client.costs({ projectId: project.id });
    const labels = costs.bySpecialist.map((s) => s.label);
    expect(labels).toContain("the writer");
    expect(labels).toContain("the critic");
    expect(labels).not.toContain("writer-marketing");
    // One work run, accepted: the critic's review and the planning call are not runs to accept.
    const model = costs.byModel.find((b) => b.accepted !== null);
    expect(model?.runs).toBe(1);
    expect(model?.accepted).toBe(1);
  }, 90_000);

  it("a session's page stops saying '1 task needs you' once the person answered its card (L-21)", async () => {
    const project = await client.createProject({ name: "Answered", goal: "A page" });
    const task = await client.createTask(project.id, {
      title: "Write the broken page in page.html",
      outcome: "page.html exists",
      riskTier: 1,
      specialist: "coder",
    });
    bench.fail = ["broken page"];
    let sessionId = "";
    try {
      const started = await client.startSession({ agentId: rt.agent.id, projectId: project.id });
      sessionId = started.session?.id ?? "";
      await eventually(
        async () => !["planned", "running"].includes((await client.session(sessionId)).status),
        "the session to end (at least 10 s of real time)",
        async () => `${(await client.task(task.id)).task.status}`,
        60_000,
      );
    } finally {
      bench.fail = [];
    }
    expect((await client.session(sessionId)).statusText).toBe("Ended: 1 task needs you");
    const me = await client.me();
    const open = (await client.inbox(me.id)).requests.find(
      (r) => r.taskId === task.id && r.status === "open",
    );
    expect(open).toBeTruthy();
    await client.answerRequest(open?.id ?? "", {
      version: open?.version ?? 0,
      answer: "Cancel task",
    });
    await eventually(
      async () => (await client.task(task.id)).task.status === "cancelled",
      "the card's Cancel task to cancel it",
    );
    const after = await client.session(sessionId);
    expect(after.statusText).not.toMatch(/needs you/);
    expect((await client.sessions({ projectId: project.id }))[0]?.statusText).not.toMatch(
      /needs you/,
    );
  }, 90_000);

  it("a pull request that conflicts reads 'Accepted · conflicts with <base>' with what to do, never 'waiting for you to merge'; the done line counts what Merge can merge (W14-5)", async () => {
    const project = await client.createProject({ name: "Conflicts", goal: "Three guides" });
    await rt.store.project.patch(project.id, { repos: ["o/conflicts"] } as never);
    // As the merge record says it (the conflict notice, `dependent-branches.ts`; the merge
    // step's own conflict uses the same `last_outcome`), with the card answered "Leave it open":
    // nothing else holds the task.
    const seedPr = async (title: string, n: number, sentence: string, lastOutcome?: string) => {
      const url = `https://github.com/o/conflicts/pull/${n}`;
      const t = await seedTask(project.id, title, { pr_url: url });
      const record = await rt.store.mergeRecord.pin({
        task_id: t.id,
        project_id: project.id,
        agent_id: rt.agent.id,
        pr_number: n,
        pr_url: url,
        reviewed_head_sha: String(n).repeat(40),
      } as never);
      await rt.store.mergeRecord.move(record.id, "left_to_you", {
        sentence,
        ...(lastOutcome ? { last_outcome: lastOutcome } : {}),
      });
      return t;
    };
    const waiting = await seedPr(
      "Write the guide",
      2,
      "#2 waits for you: press Merge on the Overview.",
    );
    const onMain = await seedPr(
      "Write the notes",
      3,
      conflictNoticeSentence(3, "main", ["README.md"]),
      "conflict",
    );
    const onTrunk = await seedPr(
      "Write the intro",
      4,
      conflictNoticeSentence(4, "trunk", []),
      "conflict",
    );
    const rows = await client.tasks(project.id);
    const display = (id: string) => rows.find((r) => r.id === id)?.display;
    expect(display(onMain.id)).toMatchObject({
      key: "done",
      label: "Accepted · conflicts with main",
      tone: "warn",
      detail:
        "#3 conflicts with main in README.md: resolve the conflict on GitHub, or redo the task.",
    });
    expect(display(onTrunk.id)).toMatchObject({
      label: "Accepted · conflicts with trunk",
      tone: "warn",
      detail: "#4 conflicts with trunk: resolve the conflict on GitHub, or redo the task.",
    });
    // The one Merge can merge says so, and its detail (the Overview's button) is not repeated.
    expect(display(waiting.id)).toMatchObject({
      label: "Accepted · waiting for you to merge",
      tone: "good",
      detail: null,
    });
    // No row names a branch (C-59).
    expect(JSON.stringify(rows.map((r) => r.display))).not.toMatch(/fr\/|branch/);
    // Home's done line counts the pull request Merge can merge; the two that conflict say so on
    // their rows and the Overview, where its button leads.
    const line = (await client.project(project.id)).statusLine;
    expect(line?.text).toBe("Done: all 3 tasks. 1 pull request waits for you to merge.");
    expect(line?.action?.to).toBe(`/projects/${project.id}`);
  });
});

describe("polish-words, wave 13: the Inbox cards through the real daemon", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    ({ rt, client } = await composeWithRolePlayer({}));
  }, 60_000);
  afterAll(async () => {
    await rt?.close();
  });

  const intakeCard = async (projectId: string, titles: string[]) => {
    const me = await client.me();
    return rt.store.humanRequest.insert({
      human_id: me.id,
      project_id: projectId,
      task_id: null,
      session_id: null,
      kind: "approval",
      why: "Intake",
      steps: [],
      options: ["approve", "change", "reject"],
      blocking: true,
      risk: "medium",
      change_card: {
        key: `intake:${projectId}`,
        docs_target: "workspace",
        applied_at: null,
        proposal: {
          plan: {
            tasks: titles.map((title, i) => ({ key: `t${i}`, title, specialist: "coder" })),
          },
          docs: { "README.md": "# Notes" },
        },
      },
      author_agent: rt.agent.id,
    } as never);
  };

  it("a one-task plan's Approve and start says 'it' and what it does while it works; on a repository, the docs pull request (L-20)", async () => {
    const me = await client.me();
    const folder = await client.createProject({ name: "One note", goal: "A note" });
    const one = await intakeCard(folder.id, ["Write the note in note.md"]);
    const card = (await client.inbox(me.id)).requests.find((r) => r.id === one.id);
    const approve = card?.choices?.find((c) => c.label === "Approve and start");
    expect(approve?.explain).toBe("Writes this task and starts working on it now.");
    expect(approve?.working).toBe("Writing the plan…");
    const repo = await client.createProject({ name: "Repo notes", goal: "Notes" });
    await rt.store.project.patch(repo.id, { repos: ["o/notes"] } as never);
    const two = await intakeCard(repo.id, ["Write the note", "Check the note"]);
    const card2 = (await client.inbox(me.id)).requests.find((r) => r.id === two.id);
    const approve2 = card2?.choices?.find((c) => c.label === "Approve and start");
    expect(approve2?.explain).toBe("Writes these 2 tasks and starts working on them now.");
    expect(approve2?.working).toBe("Writing the plan and its docs pull request…");
  });

  it("a project budget's card opens Settings at Other settings; Cancel promises nothing untrue (P7-18, P7-19)", async () => {
    const me = await client.me();
    const project = await client.createProject({ name: "Budgeted", goal: "A guide" });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Write the long guide",
      outcome: "guide.md exists",
      acceptance_criteria: ["guide.md exists"],
      risk_tier: 1,
      status: "needs_human",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "paused",
    } as never);
    const request = await rt.store.humanRequest.insert({
      human_id: me.id,
      project_id: project.id,
      task_id: task.id,
      session_id: null,
      kind: "approval",
      why: '"Write the long guide" paused at the project\'s budget.',
      steps: [],
      options: ["Cancel task"],
      blocking: true,
      risk: "medium",
      change_card: {
        key: "task:budget_stop",
        task_id: task.id,
        source: "project",
        done: null,
        left: [],
        title: '"Write the long guide" paused at the project\'s budget',
      },
      author_agent: rt.agent.id,
    } as never);
    const card = (await client.inbox(me.id)).requests.find((r) => r.id === request.id);
    expect(card?.links?.[0]).toMatchObject({
      label: "Open Settings",
      to: "/settings#other-settings",
    });
    expect(card?.choices?.[0]?.explain).toBe(
      "Drops it; its work is set aside unless a later task built on it.",
    );
  });
});

describe("polish-words, wave 13: Cancel on a ready task holding its work so far (P7-20)", () => {
  // A task paused at its budget, cancelled and reopened, is ready and holds its work in progress
  // again: its Cancel sets that work aside, and the row's title, the dialog and the drawer say
  // so. Only when the paused run left work: a run paused before it wrote anything holds none,
  // and the line would promise a set-aside that never comes (the review of polish-words, bench:
  // the CHF 0.004 guide wrote no file and its cancel set nothing aside).
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    // The stand-in writes the guides one part per call until the budget stops it.
    ({ rt, client } = await composeWithRolePlayer({ FORERUNNER_BENCH_LONG: "Write the guide" }));
  }, 60_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a reopened task whose paused run wrote its file says Cancel sets it aside; one whose run wrote nothing, and one that never ran, do not", async () => {
    const project = await client.createProject({ name: "Club guides", goal: "Guides" });
    const make = (title: string, file: string, budgetUsdMicro: number, priority: "high" | "low") =>
      client.createTask(project.id, {
        title,
        outcome: `${file} explains the club`,
        acceptanceCriteria: [`${file} exists`],
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro,
        specialist: "coder",
        riskTier: 1,
      });
    // The members guide's budget (CHF 0.004, as on the bench) stops it before it writes
    // anything; it runs first, so no task builds on the other guide's work in the folder. That
    // one has about three times the reserve of two stand-in calls (budget-resume's journey): a
    // few parts of guide.md, then the pause.
    const empty = await make(
      "Write the guide for members in members.md",
      "members.md",
      5_000,
      "high",
    );
    const wrote = await make("Write the guide in guide.md", "guide.md", 45_000, "low");
    const started = await client.startSession({ agentId: rt.agent.id, projectId: project.id });
    const sessionId = started.session?.id ?? "";
    expect(sessionId, JSON.stringify(started)).toBeTruthy();
    await eventually(
      async () =>
        !["planned", "running", "paused"].includes((await client.session(sessionId)).status),
      "the session to end (at least 10 s of real time)",
      async () =>
        (await client.tasks(project.id)).map((t) => `${t.title}=${t.display?.label}`).join(", "),
      60_000,
    );
    const folder = projectWorkspaceDir(rt.data.assets.projectsRoot, project.id);
    expect(existsSync(join(folder, "guide.md")), "the first run wrote guide.md").toBe(true);
    expect(existsSync(join(folder, "members.md")), "the second run wrote nothing").toBe(false);
    for (const t of [wrote, empty]) {
      const row = (await client.tasks(project.id)).find((r) => r.id === t.id);
      expect(row?.display?.label, `${t.title}: ${row?.reason}`).toBe("Paused at its budget");
    }
    // Cancel each from the Tasks tab, then Reopen it, as the person does.
    const back: Record<string, string> = {};
    for (const t of [wrote, empty]) {
      const paused = await rt.store.task.mustGet(t.id);
      const cancelled = await client.taskAction(t.id, {
        version: paused.version,
        action: "cancel",
      });
      expect(cancelled.status).toBe("cancelled");
      const reopened = await client.taskAction(t.id, {
        version: cancelled.version,
        action: "reopen",
      });
      expect(reopened.status).toBe("ready");
      back[t.id] = reopened.change?.sentence ?? "";
    }
    expect(back[wrote.id]).toContain("Its work so far is back.");
    expect(back[empty.id]).not.toContain("Its work so far is back.");
    // A task that never ran.
    const fresh = await client.createTask(project.id, {
      title: "Write the welcome note in welcome.md",
      outcome: "welcome.md greets new members",
      status: "ready",
      specialist: "coder",
      riskTier: 1,
    });
    const rows = await client.tasks(project.id);
    const row = (id: string) => rows.find((r) => r.id === id);
    const held = row(wrote.id);
    expect(held?.display).toMatchObject({
      key: "ready",
      label: "Ready",
      cancelWork:
        "Its work so far is set aside unless a later task built on it; Undo brings it back.",
    });
    // The row's button title, the dialog and the drawer read it from one place.
    expect(held ? actionExplain("cancel", held) : "").toBe(
      "Drops it. Its work so far is set aside unless a later task built on it; Undo brings it back.",
    );
    for (const id of [empty.id, fresh.id]) {
      const r = row(id);
      expect(r?.display?.key, r?.title).toBe("ready");
      expect(r?.display?.cancelWork, r?.title).toBeUndefined();
      expect(r ? actionExplain("cancel", r) : "", r?.title).toBe("Drops it.");
    }
  }, 120_000);
});

/**
 * polish-screens (wave 13): what the screens it changes read and send, against the real daemon.
 */
describe("polish-screens, wave 13", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-polish-screens-"));
    const clock = new SimulatedClock("2026-11-08T08:00:00Z");
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done for today." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
      sandboxDetection: NO_ENGINE,
      startServices: false,
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

  it("opening a project (the reads its page makes) writes nothing to GET /changes (later #61)", async () => {
    const a = await client.createProject({ name: "Look A", goal: "One" });
    const b = await client.createProject({ name: "Look B", goal: "Two" });
    const before = await client.changes({ limit: 200 });
    // What Home's link opens: the project page's reads. No project.switch any more.
    await client.project(b.id);
    await client.projectSummary(b.id);
    await client.tasks(b.id);
    await client.startCheck(b.id);
    await client.project(a.id);
    const after = await client.changes({ limit: 200 });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.some((c) => /Switch project/.test(c.wordsUsed))).toBe(false);
  });

  it("a fresh install's monthly cap reads CHF 150.00 through GET /settings (later #28)", async () => {
    const rows = await client.settings();
    const cap = rows.find((r) => r.key === "human.monthly_cap");
    // Before: CHF 150.40 (USD 188 read back at the day's rate), while setup said CHF 150.
    expect((cap?.value as { chfMicro?: number } | undefined)?.chfMicro).toBe(150_000_000);
    expect(cap?.risk).toBe("medium");
    expect(cap?.description).toContain("It cannot be 0");
    // CHF, never USD, in the rows this area words (the calibration's run cap, later #38); fast
    // mode's price table is quoted as the provider prices it (left as it is, see the report).
    for (const r of rows.filter((x) => !x.key.endsWith("fast_mode")))
      expect(`${r.description} ${JSON.stringify(r.value)}`).not.toMatch(/USD/);
    const calibration = rows.find((r) => r.key === "human.calibration");
    expect((calibration?.value as { budget_chf?: number } | undefined)?.budget_chf).toBe(8);
  });

  it("budget.set with 0 on a project is no budget; GET /settings and the sentence say so (later #43)", async () => {
    const p = await client.createProject({ name: "Zero budget", goal: "One page" });
    const first = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "project", amountChf: 3, project: p.id } }],
      wordsUsed: "Settings: Project budget to 3",
      source: "ui",
      confirm: "tap",
    });
    expect(first.status).toBe("done");
    const zero = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "project", amountChf: 0, project: p.id } }],
      wordsUsed: "Settings: Project budget to no budget",
      source: "ui",
      confirm: "tap",
    });
    expect(zero.status).toBe("done");
    expect(zero.sentence).toBe(
      "Set the project budget for Zero budget from CHF 3 to no budget: only the monthly cap limits its spending. Undo.",
    );
    const row = (await client.settings()).find(
      (r) => r.key === "project.budget" && r.scopeId === p.id,
    );
    expect((row?.value as { chfMicro?: number } | undefined)?.chfMicro).toBe(0);
    // The monthly cap's 0 is refused with why.
    const month = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 0 } }],
      wordsUsed: "Settings: Monthly spending cap to 0",
      source: "ui",
    });
    // The Settings field refuses it first in words (settings-money.test.tsx); chat asks which
    // value was meant with the same words (the parameters' issue).
    expect(month.status).toBe("refused");
    expect(month.code).toBe("validation");
  });

  it("a settings.set merge_mode card: its value is the label, what it means is the Inbox card's body (P7-10)", async () => {
    const p = await client.createProject({ name: "Merging", goal: "Merge words" });
    const r = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: { key: "merge_mode", value: "after_review", project: p.id },
        },
      ],
      wordsUsed: "Settings: Who merges accepted work to Merge automatically after review",
      source: "ui",
      projectId: p.id,
    });
    expect(r.status).toBe("pending");
    const card = r.card as { newValue?: string } | undefined;
    expect(card?.newValue).toBe("Merge automatically after review");
    const inbox = await client.inbox((await client.me()).id);
    const request = inbox.requests.find(
      (q) => q.projectId === p.id && q.status === "open" && q.kind === "approval",
    );
    expect(request?.title).toBe(
      "Set who merges accepted work for Merging to Merge automatically after review?",
    );
    expect(request?.body).toMatch(/^Forerunner merges each task's pull request once the critic/);
    // The site rule's change: one colon in its sentence (P7-31).
    const sites = await client.executeCommands({
      commands: [
        {
          name: "settings.set",
          params: {
            key: "web_access",
            value: { mode: "only", only: ["example.com"], never: [] },
            project: p.id,
          },
        },
      ],
      wordsUsed: "Settings: Web pages research may read to only example.com",
      source: "ui",
      projectId: p.id,
    });
    expect(sites.status).toBe("done");
    expect(sites.sentence?.split(":")).toHaveLength(2);
    expect(sites.sentence).toContain("from any public website to only example.com:");
  });

  it("GET start-check says what runs before a task left out for the budget (C-45)", async () => {
    const p = await client.createProject({ name: "Ahead", goal: "Three pages" });
    const task = async (title: string, priority: "high" | "low", budgetUsdMicro: number) =>
      client.createTask(p.id, {
        title,
        outcome: `${title} exists`,
        acceptanceCriteria: [],
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro,
        specialist: "coder",
        riskTier: 0,
      });
    await task("Home page", "high", 300_000);
    await task("About page", "low", 300_000);
    await task("Contact page", "low", 10_000);
    // The prices the check gives each task, with room for all three.
    const wide = await client.startCheck(p.id, { budgetUsdMicro: 100_000_000 });
    const price = (title: string) =>
      [...wide.runnable, ...wide.overBudget].find((t) => t.title === title)?.estimate.usdMicro ?? 0;
    const [home, about, contact] = [price("Home page"), price("About page"), price("Contact page")];
    expect(contact).toBeLessThan(about);
    // A work budget one micro-franc short of "Home" and "About": "About" does not fit after
    // "Home", and "Contact", after it in the order, still does.
    const work = home + about - 1;
    const check = await client.startCheck(p.id, { budgetUsdMicro: Math.floor(work / 0.8) });
    expect(check.runnable.map((t) => t.title)).toEqual(["Home page", "Contact page"]);
    expect(check.overBudget.map((t) => t.title)).toEqual(["About page"]);
    // What runs before it is "Home" alone, not "Home" and "Contact" (the dialog's sum before).
    expect(check.overBudget[0]?.ahead?.usdMicro).toBe(home);
    expect(check.overBudget[0]?.ahead?.chfMicro).toBeGreaterThan(0);
  });
});

describe("w15-merge, wave 15", () => {
  it("two projects on one repository with Status pull request on: the second never writes into, comments on or lists the first one's status or scaffold pull request; each Overview lists only its own; the same after the daemon starts again (W15-01)", async () => {
    // Live check 2 (forerunner-sandbox, 2026-11-09): a second project's session pushed its
    // status onto `fr/status`, into the first project's open status pull request #5, commented
    // on it, and its Overview listed #5 with Merge.
    const work = mkdtempSync(join(tmpdir(), "fr-ui-real-w15-status-"));
    const bare = join(work, "shared.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({
      cwd: join(work, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(work, "seed", "README.md"), "# shared\n");
    await seed.commitAll("seed");
    await seed.push("main");
    const host = new MemoryGitHost("alice");
    const repo = { owner: "o", name: "w15shared" };
    await host.createRepo({ ...repo, private: true, cloneUrl: bare });
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const env = { FORERUNNER_HOME: home };
    const compose = () =>
      composeWithRolePlayer(
        {},
        {
          gitHost: host,
          tryIt: false,
          env,
          dirs: appDirs({ env }),
          stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        },
      );
    const statusHead = async () =>
      (await run(["git", "--git-dir", bare, "rev-parse", "fr/status"])).stdout.trim();
    const docsRows = async (c: DaemonClient, projectId: string) =>
      (await c.projectPullRequests(projectId)).waiting
        .filter((w) => w.kind === "docs")
        .map((w) => `${w.branch} #${w.number}`);

    let { rt, client } = await compose();
    try {
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = async (name: string) => {
        const p = await client.createProject({
          name,
          goal: `${name}'s notes`,
          repos: ["o/w15shared"],
        });
        const on = await client.executeCommands({
          commands: [
            {
              name: "settings.set",
              params: { key: "status_pull_request", value: true, project: p.id },
            },
          ],
          source: "ui",
        });
        expect(on.status).toBe("done");
        return p;
      };
      const session = async (projectId: string, title: string) => {
        await client.createTask(projectId, {
          title,
          outcome: `${title} is written`,
          riskTier: 1,
          specialist: "coder",
        });
        const before = (await client.sessions({ projectId })).length;
        const started = await client.startSession({ agentId, projectId });
        expect(started.session?.id).toBeDefined();
        await eventually(
          async () => {
            const all = await client.sessions({ projectId });
            return all.length > before && all.every((s) => s.status !== "running");
          },
          `the session of ${title} to end`,
          async () =>
            (await client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", "),
          60_000,
        );
      };
      const a = await project("Shared A");
      const b = await project("Shared B");
      await session(a.id, "Write the notes in a-notes.md");
      const [prA] = await host.listPullRequests(repo, { state: "open", head: "fr/status" });
      expect(prA?.body).toContain(`<!-- forerunner:pr project=${a.id} -->`);
      const [scaffold] = await host.listPullRequests(repo, {
        state: "open",
        head: "fr/docs-scaffold",
      });
      expect(scaffold?.body).toContain(`<!-- forerunner:pr project=${a.id} -->`);
      const headA = await statusHead();
      const commentsA = (await host.listPullRequestComments(repo, prA?.number ?? 0)).length;
      const scaffoldComments = (await host.listPullRequestComments(repo, scaffold?.number ?? 0))
        .length;

      await session(b.id, "Write the notes in b-notes.md");
      // B wrote no commit onto fr/status, no comment on A's pull request and opened none.
      expect(await statusHead()).toBe(headA);
      expect((await host.listPullRequestComments(repo, prA?.number ?? 0)).length).toBe(commentsA);
      expect((await host.listPullRequestComments(repo, scaffold?.number ?? 0)).length).toBe(
        scaffoldComments,
      );
      expect(
        (await host.listPullRequests(repo, { state: "open" }))
          .filter((p) => p.head.ref.startsWith("fr/status") || p.head.ref === "fr/docs-scaffold")
          .map((p) => p.number),
      ).toEqual([scaffold?.number, prA?.number].sort((x, y) => (x ?? 0) - (y ?? 0)));
      // Each Overview lists only its own docs pull requests.
      expect((await docsRows(client, a.id)).sort()).toEqual(
        [`fr/docs-scaffold #${scaffold?.number}`, `fr/status #${prA?.number}`].sort(),
      );
      expect(await docsRows(client, b.id)).toEqual([]);
      // B's Docs tab does not say its docs wait in A's pull requests.
      for (const d of await client.docs(b.id))
        expect(d.note ?? "", d.path).not.toMatch(/waiting in pull request/);
      // B's status stayed in the app, and its Docs tab reads it there (the review of the fix:
      // "docs/status.md missing / not written yet" while the app kept it).
      const statusOfB = async () => {
        const row = (await client.docs(b.id)).find((d) => d.path === "docs/status.md");
        expect(row?.exists, row?.note ?? "no status row").toBe(true);
        const text = (await client.doc(b.id, "docs/status.md")).content;
        expect(text).toContain("Write the notes in b-notes.md");
        expect(text).not.toContain("Write the notes in a-notes.md");
      };
      await statusOfB();

      // The daemon starts again on the same home: the ownership is read from the bodies.
      await rt.close();
      ({ rt, client } = await compose());
      expect((await docsRows(client, a.id)).sort()).toEqual(
        [`fr/docs-scaffold #${scaffold?.number}`, `fr/status #${prA?.number}`].sort(),
      );
      expect(await docsRows(client, b.id)).toEqual([]);
      await statusOfB();
    } finally {
      await rt.close();
    }
  }, 240_000);
});

describe("w15-merge, wave 15: a merge that waits for its task's folder (W15-05)", () => {
  it("after one poll and before any press the row says why with the folder and offers no Merge; Merge answers that sentence and is kept; the same after the daemon starts again; once the folder is clean the next poll rebuilds and merges it", async () => {
    // Live check 2 (F4): Merge answered "Merging #23." while the merge waited on changes left in
    // the task's folder, the row offered a bare Merge before the press, and the sentence did not
    // say where the folder is.
    const work = mkdtempSync(join(tmpdir(), "fr-ui-real-w15-folder-"));
    const clock = new SystemClock();
    const host = await FakeGitHost.start({ rootDir: join(work, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: "alice@example.test" });
    await host.createRepo({
      owner: "alice",
      name: "w15folder",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# w15folder\n" },
    });
    const REPO = { owner: "alice", name: "w15folder" };
    const token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const env = { FORERUNNER_HOME: home };
    const compose = async () => {
      const vault = new MemoryVault();
      await vault.set(SECRET_NAMES.github, token);
      return composeWithRolePlayer(
        {},
        {
          env,
          dirs: appDirs({ env }),
          stateUrl: `sqlite:${join(home, "state.sqlite")}`,
          gitHost: new GitHubHost({ token, baseUrl: host.baseUrl, clock }),
          vault,
          tryIt: false,
          githostWatch: { enabled: true, pollMs: 86_400_000 },
          config: {
            version: 1,
            profile: "default",
            timezone: "UTC",
            githubApiBase: host.baseUrl,
            anthropicApiBase: "http://an.test",
            repos: [],
            credentials: { github: true, anthropic: false, anthropicSubscription: false },
            stateUrl: `sqlite:${join(home, "state.sqlite")}`,
          },
        },
      );
    };
    let { rt, client } = await compose();
    try {
      const agentId = (await client.agents())[0]?.id ?? "";
      const project = await client.createProject({
        name: "Folder wait",
        goal: "A page and its footer",
        repos: ["alice/w15folder"],
      });
      const a = await client.createTask(project.id, {
        title: "Write the page in page.html",
        outcome: "page.html holds the page",
        riskTier: 1,
        specialist: "coder",
      });
      const b = await client.createTask(project.id, {
        title: "Write the footer in footer.html",
        outcome: "footer.html holds the footer",
        riskTier: 1,
        specialist: "coder",
        dependsOn: [a.id],
      });
      const statuses = async () =>
        (await client.tasks(project.id)).map((t) => `${t.title}=${t.status}`).join(", ");
      const started = await client.startSession({ agentId, projectId: project.id });
      const sessionId = started.session?.id ?? "";
      expect(sessionId, await statuses()).not.toBe("");
      await eventually(
        async () => (await client.session(sessionId)).status !== "running",
        "the session to end (at least 60 s)",
        statuses,
        60_000,
      );
      const taskA = await rt.store.task.mustGet(a.id);
      const taskB = await rt.store.task.mustGet(b.id);
      expect(taskB.status, await statuses()).toBe("done");
      const prA = Number(/\/pull\/(\d+)/.exec(taskA.pr_url ?? "")?.[1]);
      const prB = Number(/\/pull\/(\d+)/.exec(taskB.pr_url ?? "")?.[1]);
      const folder = join(rt.dirs.worktrees, taskB.id);
      // Someone left a file in B's folder; A is squash-merged on GitHub; one poll.
      writeFileSync(join(folder, "notes.txt"), "my notes\n");
      expect((await github.mergePullRequest(REPO, prA, { method: "squash" })).merged).toBe(true);
      await rt.githostWatcher?.pollOnce();
      const sentence = `#${prB} waits for changes left in its task's folder: take them out or redo the task.`;
      const rowOf = async (c: DaemonClient) =>
        (await c.projectPullRequests(project.id)).waiting.find((w) => w.number === prB);
      // Before any press: the sentence and the folder, no Merge.
      expect(await rowOf(client)).toMatchObject({
        folder,
        merge: { canMerge: false, sentence },
      });
      const taskRow = (await client.tasks(project.id)).find((t) => t.id === b.id);
      expect(taskRow?.display).toMatchObject({
        label: "Accepted · merge waits for you",
        detail: sentence,
      });
      // The press answers why it waits, never "Merging #N."; the approval is kept.
      const answer = await client.mergePullRequest(project.id, prB);
      expect(answer.sentence).toBe(sentence);
      expect(answer.state).toBe("queued");
      await rt.pullRequests.idle();
      const kept = await rt.store.mergeRecord.forTask(b.id);
      expect(kept).toMatchObject({ approval: "person", last_outcome: "owed_folder_changes" });
      expect((await github.getPullRequest(REPO, prB)).merged).toBe(false);

      // The daemon starts again on the same home: the same row, the approval still kept.
      await rt.close();
      ({ rt, client } = await compose());
      expect(await rowOf(client)).toMatchObject({
        folder,
        merge: { canMerge: false, sentence },
      });
      expect((await rt.store.mergeRecord.forTask(b.id))?.approval).toBe("person");

      // The file taken out: the next poll rebuilds B onto main and the kept Merge goes on.
      rmSync(join(folder, "notes.txt"));
      // The rebuild runs at the next poll's sweep, the kept merge at a retry pass after it.
      for (let i = 0; i < 4 && !(await github.getPullRequest(REPO, prB)).merged; i++) {
        await rt.githostWatcher?.pollOnce();
        await rt.pullRequests.idle();
      }
      expect(
        (await github.getPullRequest(REPO, prB)).merged,
        JSON.stringify(await rt.store.mergeRecord.forTask(b.id)),
      ).toBe(true);
    } finally {
      await rt.close();
      await host.stop();
    }
  }, 240_000);
});
