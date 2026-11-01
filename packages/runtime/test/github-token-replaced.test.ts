import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GitOps, gitAuthFor } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock, safeSegment } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-082 (the owner, testing U-037): a GitHub token replaced in the setup assistant was used
 * by the GitHub API at once (U-049) but not by git. Creating a repository made it under the new
 * token's account; the push of the project's folder still carried the token read when the
 * service started, and GitHub refused it ("Permission to joelwellbournewood/joels-test.git
 * denied to Afanc", the old token's owner). Here the daemon is composed as an install is (its
 * own GitHub client, no host injected) with one account's token, the token is replaced through
 * the setup route, and every git step that follows must use the new one: the repository's
 * first push, and the next task's clone of it.
 */
const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));

describe("a GitHub token replaced in the app is used by git at once (U-082)", () => {
  let rt: RuntimeApp;
  let host: FakeGitHost;
  let root: string;
  let worktrees: string;
  let newToken = "";
  /** The project the first case links to joel/joels-test. */
  let projectId = "";
  let req: (path: string, init?: RequestInit) => Promise<Response>;
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-u082-token "));
    host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
    host.createUser({ login: "afanc", name: "Afanc", email: "afanc@example.test" });
    host.createUser({ login: "joel", name: "Joel", email: "joel@example.test" });
    const oldToken = host.createToken({ owner: "afanc", kind: "classic", scopes: ["repo"] }).token;
    newToken = host.createToken({ owner: "joel", kind: "classic", scopes: ["repo"] }).token;
    // The setup route checks a token against GitHub at this address, as the install's own does.
    const env = { FORERUNNER_HOME: join(root, "home"), FORERUNNER_GITHUB_API: host.baseUrl };
    const dirs = appDirs({ env });
    worktrees = dirs.worktrees;
    rt = await composeRuntime({
      env,
      dirs,
      config: {
        version: 1,
        profile: "default",
        timezone: "Europe/Zurich",
        githubApiBase: host.baseUrl,
        anthropicApiBase: "http://an.test",
        repos: [],
        credentials: { github: true, anthropic: false, anthropicSubscription: false },
        stateUrl: "sqlite::memory:",
      },
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ [SECRET_NAMES.github]: oldToken }),
      provider: new ScriptedProvider([{ text: "Nothing to change." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "Joel", timezone: "Europe/Zurich", agentName: "Ada" },
      appVersion: "1.0.0",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
    const { app, token: bearer } = createDaemonApp(rt);
    req = (path, init = {}) =>
      Promise.resolve(
        app.request(path, {
          ...init,
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
        }),
      );
  }, 120_000);

  afterAll(async () => {
    await rt?.close();
    await host?.stop();
  });

  /** One run of a project's task, as a session's executor runs it. */
  async function runTask(projectId: string, taskId: string) {
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      status: "running",
      runner: "pc",
    });
    const grant = await rt.sessionGrant(projectId);
    const runToken = rt.tokens.issue({
      runId: `run-${taskId}`,
      sessionId: session.id,
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId,
      allowedTools: grant?.allowedTools ?? [],
      allowedPaths: grant?.allowedPaths ?? [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 2,
      planApproved: true,
      expiresAt: new Date(clock.now() + 60_000).toISOString(),
    });
    const task = await rt.store.task.mustGet(taskId);
    const result = await rt.executor.execute({
      task,
      session,
      token: runToken,
      budget: new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro: 1_000_000,
        stepCap: 20,
        deadlineMs: clock.now() + 60_000,
        reserveShare: 0,
      }),
      item: { taskId, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    await rt.store.session.patch(session.id, { status: "completed", ended_at: clock.nowIso() });
    return result;
  }

  it("the repository's first push and the next task's clone use the new token", async () => {
    // The person replaces the token in the setup assistant's GitHub step.
    const saved = await req("/setup/github", {
      method: "POST",
      body: JSON.stringify({ token: newToken }),
    });
    expect(saved.status).toBe(200);
    expect(await rt.vault.get(SECRET_NAMES.github)).toBe(newToken);

    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Joels Test", goal: "Joels Test: a small notes app" }),
    });
    expect(created.status).toBe(201);
    const id = String((await json(created)).id);
    projectId = id;
    writeFileSync(
      join(projectWorkspaceDir(rt.data.assets.projectsRoot, id), "notes.md"),
      "# Notes\n",
      "utf8",
    );
    const task = await rt.store.task.insert({
      project_id: id,
      title: "Add the notes list",
      outcome: "The app lists notes",
      status: "ready",
      priority: 5,
      risk_tier: 1,
      specialist: "coder",
    });

    // The project page's Create a repository: the card, then the tap.
    const pending = await json(
      await req("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commands: [{ name: "repo.create", params: { project: id, private: true } }],
          source: "ui",
          projectId: id,
          wordsUsed: "Create a repository (project page)",
        }),
      }),
    );
    expect(pending.status).toBe("pending");
    const confirmed = await json(
      await req(`/commands/${String(pending.pendingId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ answer: "tap" }),
      }),
    );
    // What the person read: "created on GitHub, but pushing the project's folder to it failed".
    expect(JSON.stringify(confirmed)).not.toContain("pushing the project's folder to it failed");
    expect(confirmed.status).toBe("done");
    expect((await rt.store.project.mustGet(id)).repos).toEqual(["joel/joels-test"]);
    const check = new GitOps({
      cwd: join(root, "check"),
      auth: gitAuthFor(newToken, host.cloneUrl("joel/joels-test")),
    });
    await check.clone(host.cloneUrl("joel/joels-test"));
    expect(readFileSync(join(root, "check", "notes.md"), "utf8")).toBe("# Notes\n");

    // The next run of the project's task clones the private repository with the new token.
    await runTask(id, task.id);
    const clone = join(worktrees, safeSegment(task.id));
    expect(existsSync(join(clone, ".git"))).toBe(true);
    expect(readFileSync(join(clone, "notes.md"), "utf8")).toBe("# Notes\n");
  }, 120_000);
  it("a task runs while another branch's pull request is open (U-083)", async () => {
    // The owner's session: the project's docs pull request was open, and every task failed at
    // once with "git checkout -B fr/… failed: 'origin/fr/…' is not a commit", having taken that
    // pull request for its own.
    await host.seedCommit("joel/joels-test", { "docs/status.md": "status\n" }, "docs", "fr/docs");
    const docsPr = await fetch(`${host.baseUrl}/repos/joel/joels-test/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${newToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Project status",
        body: "docs",
        head: "fr/docs",
        base: "main",
      }),
    });
    expect(docsPr.status).toBe(201);
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Create the static site scaffold",
      outcome: "The site has an index page",
      status: "ready",
      priority: 5,
      risk_tier: 1,
      specialist: "coder",
    });
    const result = await runTask(projectId, task.id);
    expect(JSON.stringify(result)).not.toContain("is not a commit");
    // The worktree is on the task's own new branch, started from main.
    const branch = (await rt.store.task.mustGet(task.id)).branch as string;
    expect(branch).toMatch(/^fr\//);
    const git = new GitOps({ cwd: join(worktrees, safeSegment(task.id)) });
    expect(await git.currentBranch()).toBe(branch);
  }, 120_000);
});
