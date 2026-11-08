import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import { appDirs, join, run, SimulatedClock } from "@forerunner/platform";
import type { SessionRow, TaskRow } from "@forerunner/state";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { syncPrAnswers } from "../src/session/pr-answers.ts";
import type { TaskExecutor } from "../src/session/runner.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * A rebuild card's Redo across a restart (ADR 0111 amended by the review's fix-up of
 * R-rebuildcard), in the composed daemon on one home: the Redo is answered, the app closes
 * before the session runs, and the next start's run of the task still does it again from main
 * (the answered card's `redo_from_base`, persisted on the card), so the conflict the rebuild
 * card was about is not met again. Before: the Redo only reopened the task, and the next run
 * resumed the open pull request's branch, rebuilt it again and stopped at the same conflict.
 */
const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };
const REPO = { owner: "alice", name: "app" };
const FULL = "alice/app";
const roots: string[] = [];
const hosts: FakeGitHost[] = [];
const apps: RuntimeApp[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe("a rebuild card's Redo across a restart (R-rebuildcard fix-up)", {
  timeout: 240_000,
}, () => {
  it("Redo on the conflict card, then the app closes: the next start's run does the task again from main, with no second conflict card", async () => {
    const clock = new SimulatedClock("2026-11-08T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-redo-restart-"));
    roots.push(home);
    const host = await FakeGitHost.start({ rootDir: join(home, "host"), clock });
    hosts.push(host);
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    const repo = await host.createRepo({
      owner: "alice",
      name: "app",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# app\n" },
    });
    const ghToken = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const github = new GitHubHost({ token: ghToken, baseUrl: host.baseUrl, clock });
    // The poll is driven by the test (pollOnce), not by the clock.
    const env = { FORERUNNER_HOME: home, FORERUNNER_GITHOST_POLL_MS: "86400000" };
    const dirs = appDirs({ env });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, ghToken);
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const compose = () =>
      composeRuntime({
        env,
        dirs,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: false, anthropic: false, anthropicSubscription: false },
          stateUrl,
        },
        clock,
        stateUrl,
        vault,
        provider: new FakeProvider({ replies: [], clock, latency: "none" }),
        registryDir: join(process.cwd(), "evals", "registry"),
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "0.1.0-test",
        recoverSessions: false,
      });
    /** The daemon's PR executor over its own worktrees, with a stand-in that writes one file. */
    const writer = (
      file: string,
      content: string,
    ): TaskExecutor & { withWorktree: (d: string) => TaskExecutor } => ({
      execute: async () => ({ outcome: "failed", summary: "no worktree", costUsdMicro: 0 }),
      withWorktree: (dir) => ({
        execute: async () => {
          writeFileSync(join(dir, file), content);
          return { outcome: "done", summary: `Wrote ${file}.`, costUsdMicro: 1 };
        },
      }),
    });
    /** One run of a task by the PR executor, as the session's executor runs it. */
    const runTask = async (rt: RuntimeApp, task: TaskRow, inner: TaskExecutor) => {
      const session = await rt.store.session.insert({
        agent_id: rt.agent.id,
        project_id: task.project_id,
        trigger: "manual",
        status: "running",
        runner: "pc",
      });
      const grant = await rt.sessionGrant(task.project_id);
      const token = rt.tokens.issue({
        runId: `run-${task.id}-${task.attempt}`,
        sessionId: session.id,
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        projectId: task.project_id,
        allowedTools: grant.allowedTools,
        allowedPaths: grant.allowedPaths,
        allowedDomains: grant.allowedDomains,
        grantedSecrets: grant.grantedSecrets,
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy: 2,
        planApproved: false,
        expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
      });
      const budget = new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro: 1_000_000,
        stepCap: 10,
        deadlineMs: clock.now() + 3_600_000,
        reserveShare: 0.1,
      });
      const res = await new PrTaskExecutor({
        store: rt.store,
        clock,
        host: github,
        inner,
        repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
        worktreeRoot: dirs.worktrees,
        token: ghToken,
        identity,
      }).execute({
        task,
        session: session as SessionRow,
        token,
        budget,
        item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      });
      await host.settle();
      return { res, session, token, budget };
    };
    /** A task run to review, accepted, and left to the person by the merge step (level 2). */
    const accepted = async (
      rt: RuntimeApp,
      projectId: string,
      title: string,
      file: string,
      dependsOn: string[] = [],
    ) => {
      let task: TaskRow = await rt.store.task.insert({
        project_id: projectId,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status: "in_progress",
        priority: 1,
        depends_on: dependsOn,
        budget_usd_micro: 1_000_000,
        author_agent: rt.agent.id,
        owner_agent_id: rt.agent.id,
      });
      const { res, session, token, budget } = await runTask(rt, task, writer(file, `${title}\n`));
      expect(res.outcome).toBe("in_review");
      task = await rt.store.task.patch(task.id, { pr_url: res.prUrl, branch: res.branch });
      task = await rt.store.task.transition(task.id, task.version, "in_review", "review", {
        agentId: rt.agent.id,
      });
      task = await rt.store.task.transition(task.id, task.version, "done", "critic accepted", {
        agentId: rt.agent.id,
      });
      const outcome = await rt.merge.mergeReviewed({
        task,
        session: session as SessionRow,
        token,
        budget,
        signal: new AbortController().signal,
        agentId: rt.agent.id,
      });
      expect(outcome?.status).toBe("not_allowed");
      return task;
    };
    const conflictCards = async (rt: RuntimeApp, taskId: string) =>
      (await rt.store.humanRequest.list({ task_id: taskId, status: "open" } as never)).filter((r) =>
        r.options.includes("Drop the branch and retry from scratch"),
      );

    // ---- the first daemon: A writes page.html; B, built on it, rewrites page.html -----------
    const rt = await compose();
    apps.push(rt);
    const project = await rt.store.project.insert({
      name: "App",
      goal: "Ship the app",
      repos: [FULL],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    const a = await accepted(rt, project.id, "Add page", "page.html");
    const b = await accepted(rt, project.id, "Fix the page", "page.html", [a.id]);
    const prA = Number(/\/pull\/(\d+)/.exec(a.pr_url ?? "")?.[1]);
    const prB = Number(/\/pull\/(\d+)/.exec(b.pr_url ?? "")?.[1]);
    // A is closed on GitHub: B cannot be rebuilt without it (both change page.html).
    await github.updatePullRequest(REPO, prA, { state: "closed" });
    await rt.githostWatcher?.pollOnce();
    await host.settle();
    const card = (
      await rt.store.humanRequest.list({ task_id: b.id, status: "open" } as never)
    ).find((r) => r.options.includes("Redo"));
    if (!card) throw new Error("no rebuild card");
    expect(card.options).toEqual(["Redo", "Leave it open"]);
    // The person's Redo, applied as the daemon's answer route applies it; the app then closes
    // before any session runs the task.
    await rt.store.humanRequest.answer(card.id, card.version, "Redo", rt.human.id);
    const applied = await syncPrAnswers({
      store: rt.store,
      clock,
      humanId: rt.human.id,
      agentId: rt.agent.id,
    });
    expect(applied.redone).toBe(1);
    expect((await rt.store.task.mustGet(b.id)).status).toBe("ready");
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);

    // ---- the next start, on the same home: the task's run ------------------------------------
    const rt2 = await compose();
    apps.push(rt2);
    let task = await rt2.store.task.mustGet(b.id);
    task = await rt2.store.task.patch(b.id, { attempt: task.attempt + 1 });
    const { res } = await runTask(rt2, task, writer("page.html", "Fix the page, again\n"));
    // Before: needs_human, "merge conflict in page.html", and a second conflict card.
    expect([res.outcome, res.summary.includes("conflict")]).toEqual(["in_review", false]);
    expect(await conflictCards(rt2, b.id)).toEqual([]);
    expect(res.prUrl).toBe(b.pr_url);
    const pr = await github.getPullRequest(REPO, prB);
    expect(pr.state).toBe("open");
    const git = async (...args: string[]) =>
      (await run(["git", "--git-dir", repo.dir, ...args])).stdout.trim();
    // Only the task's own commit, on main.
    expect(await git("rev-parse", `${pr.head.sha}^`)).toBe(
      await git("rev-parse", "refs/heads/main"),
    );
    expect(await git("log", "--format=%s", `refs/heads/main..${pr.head.sha}`)).toBe("Fix the page");
  });
});
