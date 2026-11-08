import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GitHubHost, GitOps, gitAuthFor } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock, safeSegment } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
import { REPO_PROPOSAL_OPTIONS, repoNameFor } from "../src/loop/repo-create.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-037 (with the owner's addition): a project without a repository works in its workspace
 * folder, and its agent can create a GitHub repository for it. Here the whole daemon is
 * composed with the person's GitHub token on the fake git host (REST and git smart HTTP):
 *
 * - the session grant carries the workspace folder;
 * - a session that plans code work proposes a repository in the Inbox, and nothing is created
 *   until the person answers with the card's own option; "Not now" is not asked again;
 * - "Create the repository" creates it (private, named after the project), pushes the
 *   workspace as the first commit and links it; the next run clones it into a worktree;
 * - the project page's button (the command with the card confirmed by a tap) and the Chat
 *   phrase reach the same command.
 */
const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));

describe("a repository for a project without one (U-037)", () => {
  let rt: RuntimeApp;
  let host: FakeGitHost;
  let github: GitHubHost;
  let ghToken = "";
  let root: string;
  let worktrees: string;
  let req: (path: string, init?: RequestInit) => Promise<Response>;
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  /**
   * The cases that create, push and clone a repository through the fake host's real
   * http-backend: about 1 s here, several times that on Windows CI and under load (one failed in
   * a full `pnpm check`), so not the 20 s default.
   */
  const REPO_WORK_MS = 120_000;

  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-u037-repo "));
    host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: "alice@example.test" });
    const token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    ghToken = token;
    github = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    const env = { FORERUNNER_HOME: join(root, "home") };
    const dirs = appDirs({ env });
    worktrees = dirs.worktrees;
    rt = await composeRuntime({
      env,
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ [SECRET_NAMES.github]: token }),
      provider: new ScriptedProvider([{ text: "Nothing to change." }], clock),
      gitHost: github,
      registryDir: REGISTRY,
      identity: { humanName: "Alice", timezone: "Europe/Zurich", agentName: "Ada" },
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
    rmSync(root, { recursive: true, force: true });
  });

  /** A project without a repository, at Assisted (level 1), with one ready coder task. */
  async function projectWithCodeWork(name: string) {
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name, goal: `${name}: a small notes app` }),
    });
    expect(res.status).toBe(201);
    const id = String((await json(res)).id);
    await rt.store.project.patch(id, { autonomy_level: 1 });
    const task = await rt.store.task.insert({
      project_id: id,
      title: "Add the notes list",
      outcome: "The app lists notes",
      status: "ready",
      priority: 5,
      risk_tier: 1,
      specialist: "coder",
    });
    // A file the person or an earlier run left in the project's folder.
    writeFileSync(
      join(projectWorkspaceDir(rt.data.assets.projectsRoot, id), "notes.md"),
      "# Notes\n",
      "utf8",
    );
    return { id, task };
  }

  /** One session: it plans, and at level 1 files the plan for approval and runs nothing. */
  async function session(projectId: string) {
    return rt.runner.start({
      agentId: rt.agent.id,
      projectId,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant: await rt.sessionGrant(projectId),
    });
  }

  async function proposalCard(projectId: string) {
    const inbox = await json(await req("/inbox"));
    const requests = inbox.requests as Array<{
      id: string;
      projectId: string | null;
      options: string[];
      why: string;
      steps: string[];
      version: number;
      status: string;
    }>;
    return requests.find(
      (r) => r.projectId === projectId && r.why.startsWith("Create a repository for "),
    );
  }

  async function answer(card: { id: string; version: number }, option: string) {
    const res = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: option }),
    });
    expect(res.status).toBe(200);
  }

  const hostHas = async (full: string) =>
    (await github.listRepos()).some((r) => r.fullName === full);

  it("the session grant carries the project's workspace folder", async () => {
    const { id } = await projectWithCodeWork("Grant Check");
    const grant = await rt.sessionGrant(id);
    expect(grant?.allowedPaths).toContain(projectWorkspaceDir(rt.data.assets.projectsRoot, id));
  });

  it("code work on a project without a repository puts a card in the Inbox; nothing is created without a yes, and Not now is not asked again", async () => {
    const { id } = await projectWithCodeWork("Field Journal");
    await session(id);
    const card = await proposalCard(id);
    expect(card).toBeDefined();
    if (!card) return;
    // The card says the name, the account and that it is private; its buttons are plain words.
    expect(card.options).toEqual([...REPO_PROPOSAL_OPTIONS]);
    expect(card.steps).toEqual(
      expect.arrayContaining([
        "Repository: alice/field-journal",
        "Under: your GitHub account alice",
        "Visibility: private",
      ]),
    );
    expect(await hostHas("alice/field-journal")).toBe(false);
    // The person clicks "Not now" (the card's own second option).
    await answer(card, card.options[1] as string);
    expect(await hostHas("alice/field-journal")).toBe(false);
    expect((await rt.store.project.mustGet(id)).repos).toEqual([]);
    // A later session with code work asks nothing more.
    await session(id);
    const again = await proposalCard(id);
    expect(again?.status === "open" ? again : undefined).toBeUndefined();
  });

  it(
    "Create the repository: private, the workspace as the first commit, linked; the next run clones it",
    async () => {
      const { id, task } = await projectWithCodeWork("Garden Planner");
      await session(id);
      const card = await proposalCard(id);
      if (!card) throw new Error("no proposal card");
      await answer(card, card.options[0] as string);
      // The answer's sync created it before the route answered; if not, say what the card and
      // the project say now (it failed once under load with nothing said of what it saw).
      const repo = await github
        .getRepo({ owner: "alice", name: "garden-planner" })
        .catch(async (e: unknown) => {
          throw new Error(
            `no repository after "${card.options[0]}": ${e instanceof Error ? e.message : String(e)}; the card now: ${JSON.stringify(await proposalCard(id))}; the project's repos: ${JSON.stringify((await rt.store.project.mustGet(id)).repos)}`,
          );
        });
      expect(repo.private).toBe(true);
      expect((await rt.store.project.mustGet(id)).repos).toEqual(["alice/garden-planner"]);
      // One commit on main holding the workspace: the scaffolded docs and the person's file.
      const check = new GitOps({
        cwd: join(root, "check-garden"),
        auth: gitAuthFor(ghToken, repo.cloneUrl),
      });
      await check.clone(repo.cloneUrl);
      const commits = await check.log(10);
      expect(commits.map((c) => c.subject)).toEqual([
        "Start Garden Planner from its Forerunner workspace",
      ]);
      expect(readFileSync(join(root, "check-garden", "notes.md"), "utf8")).toBe("# Notes\n");
      expect(existsSync(join(root, "check-garden", "README.md"))).toBe(true);
      expect(existsSync(join(root, "check-garden", ".git", "refs", "heads", "main"))).toBe(true);
      // The change log names it as the person's change, confirmed in the Inbox.
      const changes = await rt.store.changeLog.list({ project_id: id } as never);
      expect(changes.map((c) => c.sentence).join("\n")).toContain(
        "Created the private GitHub repository alice/garden-planner",
      );
      // The next run of the project's task works in a clone of it.
      const session2 = await rt.store.session.insert({
        agent_id: rt.agent.id,
        project_id: id,
        trigger: "manual",
        status: "running",
        runner: "pc",
      });
      const grant = await rt.sessionGrant(id);
      const token = rt.tokens.issue({
        runId: "run-session",
        sessionId: session2.id,
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        projectId: id,
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
      await rt.executor.execute({
        task: await rt.store.task.mustGet(task.id),
        session: session2,
        token,
        budget: new SessionBudget({
          sessionId: session2.id,
          budgetUsdMicro: 1_000_000,
          stepCap: 20,
          deadlineMs: clock.now() + 60_000,
          reserveShare: 0,
        }),
        item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      });
      await rt.store.session.patch(session2.id, { status: "completed", ended_at: clock.nowIso() });
      const clone = join(worktrees, safeSegment(task.id));
      expect(existsSync(join(clone, ".git"))).toBe(true);
      expect(readFileSync(join(clone, "notes.md"), "utf8")).toBe("# Notes\n");
    },
    REPO_WORK_MS,
  );

  it(
    "the project page's button: the card says what is created, and a tap creates it",
    async () => {
      const { id } = await projectWithCodeWork("Recipe Box");
      const res = await req("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commands: [{ name: "repo.create", params: { project: id, private: true } }],
          source: "ui",
          projectId: id,
          wordsUsed: "Create a repository (project page)",
        }),
      });
      const pending = await json(res);
      expect(pending.status).toBe("pending");
      const cardJson = pending.card as Record<string, unknown>;
      expect(cardJson.newValue).toBe("alice/recipe-box (private, under your GitHub account alice)");
      expect(await hostHas("alice/recipe-box")).toBe(false);
      const confirmed = await json(
        await req(`/commands/${String(pending.pendingId)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "tap" }),
        }),
      );
      expect(confirmed.status).toBe("done");
      expect(await hostHas("alice/recipe-box")).toBe(true);
      expect((await rt.store.project.mustGet(id)).repos).toEqual(["alice/recipe-box"]);
      // A second one for the same project is refused with the reason: it has one now.
      const again = await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "repo.create", params: { project: id } }],
            source: "ui",
          }),
        }),
      );
      expect(again.status).toBe("refused");
      expect(String(again.reason)).toContain("already has a repository (alice/recipe-box)");
    },
    REPO_WORK_MS,
  );

  it(
    "at Autopilot (level 4) the agent asks too: one card, nothing created until Create the repository (the owner's decision of 2026-11-02)",
    async () => {
      const { id } = await projectWithCodeWork("Bird Counter");
      await rt.store.project.patch(id, { autonomy_level: 4 });
      await session(id);
      // Before: at level 4 the agent ran repo.create itself and the repository existed now.
      expect(await hostHas("alice/bird-counter")).toBe(false);
      expect((await rt.store.project.mustGet(id)).repos).toEqual([]);
      const card = await proposalCard(id);
      if (!card) throw new Error("no proposal card at Autopilot");
      expect(card.options).toEqual([...REPO_PROPOSAL_OPTIONS]);
      // Design \u00a75: the card says what and why in two sentences, without the old list of what
      // GitHub would not have.
      expect(card.why).toBe(
        'Create a repository for "Bird Counter"? Code work is planned for it, and it has none: its tasks run in the project\'s folder on this computer.',
      );
      expect(card.why).not.toContain("no branch, pull request or review on GitHub");
      // The person's yes creates it, as below Autopilot.
      await answer(card, card.options[0] as string);
      expect(await hostHas("alice/bird-counter")).toBe(true);
      expect((await rt.store.project.mustGet(id)).repos).toEqual(["alice/bird-counter"]);
    },
    REPO_WORK_MS,
  );

  it(
    "the chat agent's repo.create at Autopilot files a card and creates nothing until the person's yes",
    async () => {
      const { id } = await projectWithCodeWork("Kite Log");
      await rt.store.project.patch(id, { autonomy_level: 4 });
      const chat = await rt.store.session.insert({
        agent_id: rt.agent.id,
        project_id: id,
        trigger: "manual",
        plan: {},
        budget_cap_usd_micro: 0,
        step_cap: 1,
        spent_usd_micro: 0,
        steps: 0,
        started_at: clock.nowIso(),
        status: "completed",
        summary: "conversation",
        handoff: {},
        runner: "pc",
      });
      // The conversation agent's command tools run as the agent (commands.ts `tools`).
      const results: Array<{ status: string }> = [];
      const tools = rt.commands.tools(
        {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          activeProjectId: id,
          sessionId: chat.id,
          source: "text",
          wordsUsed: "make a repository for this",
        },
        (r) => results.push(r as { status: string }),
      );
      const create = tools.find((t) => t.name === "repo_create");
      if (!create) throw new Error("repo_create tool missing");
      const out = await create.execute(
        { project: id, private: true },
        {
          runId: "turn-1",
          sessionId: chat.id,
          agentId: rt.agent.id,
          humanId: rt.human.id,
          projectId: id,
          allowedPaths: [],
          signal: new AbortController().signal,
        },
      );
      // Before: 'low' risk for the agent at Autopilot, so it was created at once with no card.
      expect(results.map((r) => r.status)).toEqual(["pending"]);
      expect(String(out.content)).toMatch(/Needs confirmation/);
      expect(await hostHas("alice/kite-log")).toBe(false);
      expect((await rt.store.project.mustGet(id)).repos).toEqual([]);
    },
    REPO_WORK_MS,
  );

  it("Home's line does not count the repository offer as a question: a finished project reads Done (C-60)", async () => {
    const { id, task } = await projectWithCodeWork("Pond Notes");
    await session(id);
    const offer = await proposalCard(id);
    if (!offer) throw new Error("no proposal card");
    // The work is finished: the task is done and the session's plan is no longer asked about;
    // only the offer is open.
    await rt.store.task.patch(task.id, { status: "done", reason: "accepted" });
    for (const r of await rt.store.humanRequest.list({ status: "open", project_id: id } as never))
      if (r.id !== offer.id) await rt.store.humanRequest.patch(r.id, { status: "answered" });
    const card = await json(await req(`/projects/${id}`));
    const line = card.statusLine as { text: string };
    // Before: "Waiting for you: 1 question" for a project with nothing left to do.
    expect(line.text).not.toMatch(/^Waiting for you/);
    expect(line.text).toMatch(/^Done/);
    // The offer is still in the Inbox for the person to answer when they like.
    expect((await proposalCard(id))?.status).toBe("open");
  });

  it("a typed answer that is neither option is refused with the options; the card stays (U-034)", async () => {
    const { id } = await projectWithCodeWork("Seed Bank");
    await session(id);
    const card = await proposalCard(id);
    if (!card) throw new Error("no proposal card");
    const res = await req(`/requests/${card.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: "maybe next week" }),
    });
    expect(res.status).toBe(400);
    expect(String((await json(res)).message)).toContain(
      "Choose one of: Create the repository, Not now.",
    );
    expect((await proposalCard(id))?.status).toBe("open");
    expect(await hostHas("alice/seed-bank")).toBe(false);
  });

  it("Chat: 'create a repository for X' is the same command", async () => {
    const { id } = await projectWithCodeWork("Trail Log");
    const parsed = await json(
      await req("/commands/parse", {
        method: "POST",
        body: JSON.stringify({ text: "create a repository for Trail Log" }),
      }),
    );
    expect(parsed.commands).toEqual([
      { name: "repo.create", params: { private: true, project: id } },
    ]);
  });

  it("names a repository after its project", () => {
    expect(repoNameFor("Garden Planner", "0abc")).toBe("garden-planner");
    expect(repoNameFor("Zürich Café: v2!", "0abc")).toBe("zurich-cafe-v2");
    expect(repoNameFor("???", "0123456789")).toBe("project-01234567");
  });
});
