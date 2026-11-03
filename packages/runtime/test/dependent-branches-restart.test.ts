import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { SessionRow, TaskRow } from "@forerunner/state";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import type { TaskExecutor } from "../src/session/runner.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * Dependent branches across a restart (ADR 0111, 'dependent-branches'), in the composed
 * daemon: what a dependent branch holds is kept in its worktree (the marker and one ref per
 * dependency) and the merge records in the state store, so a dependency squash-merged on
 * GitHub while the app was closed is seen by the git host watcher's first poll of the next
 * start: the dependency's record is marked merged (by squash), the dependent is rebuilt onto
 * main with only its own commits, and its record follows the new head. Before: the watcher read
 * nothing of a PR that was not open, and nothing rebuilt the dependent.
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

describe("dependent branches across a restart (ADR 0111)", { timeout: 240_000 }, () => {
  it("a dependency squash-merged while the app was closed: the next start's first poll marks it merged and rebuilds the dependent onto main", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-dep-restart-"));
    roots.push(home);
    const host = await FakeGitHost.start({ rootDir: join(home, "host"), clock });
    hosts.push(host);
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
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

    // ---- the first daemon: A, then B built on A; both wait for the person (level 2) --------
    const rt = await compose();
    apps.push(rt);
    expect(rt.githostWatcher).not.toBeNull();
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
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: project.id,
      trigger: "manual",
      status: "running",
      runner: "pc",
    });
    const budget = () =>
      new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro: 1_000_000,
        stepCap: 10,
        deadlineMs: clock.now() + 3_600_000,
        reserveShare: 0.1,
      });
    const grant = await rt.sessionGrant(project.id);
    const token = rt.tokens.issue({
      runId: "run-session",
      sessionId: session.id,
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId: project.id,
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
    // The daemon's PR executor flow over its own worktrees, with a stand-in for the model.
    const writer = (
      file: string,
    ): TaskExecutor & { withWorktree: (d: string) => TaskExecutor } => ({
      execute: async () => ({ outcome: "failed", summary: "no worktree", costUsdMicro: 0 }),
      withWorktree: (dir) => ({
        execute: async () => {
          writeFileSync(join(dir, file), `${file}\n`);
          return { outcome: "done", summary: `Wrote ${file}.`, costUsdMicro: 1 };
        },
      }),
    });
    const accepted = async (title: string, file: string, dependsOn: string[] = []) => {
      let task: TaskRow = await rt.store.task.insert({
        project_id: project.id,
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
      const res = await new PrTaskExecutor({
        store: rt.store,
        clock,
        host: github,
        inner: writer(file),
        repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
        worktreeRoot: dirs.worktrees,
        token: ghToken,
        identity,
      }).execute({
        task,
        session: session as SessionRow,
        token,
        budget: budget(),
        item: { taskId: task.id, title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      });
      expect(res.outcome).toBe("in_review");
      await host.settle();
      task = await rt.store.task.patch(task.id, { pr_url: res.prUrl, branch: res.branch });
      task = await rt.store.task.transition(task.id, task.version, "in_review", "review", {
        agentId: rt.agent.id,
      });
      task = await rt.store.task.transition(task.id, task.version, "done", "critic accepted", {
        agentId: rt.agent.id,
      });
      // The merge step pins the reviewed commit; level 2 leaves it to the person.
      const outcome = await rt.merge.mergeReviewed({
        task,
        session: session as SessionRow,
        token,
        budget: budget(),
        signal: new AbortController().signal,
        agentId: rt.agent.id,
      });
      expect(outcome?.status).toBe("not_allowed");
      return task;
    };
    const a = await accepted("Add page", "page.html");
    const b = await accepted("Add footer", "footer.html", [a.id]);
    const prA = Number(/\/pull\/(\d+)/.exec(a.pr_url ?? "")?.[1]);
    const prB = Number(/\/pull\/(\d+)/.exec(b.pr_url ?? "")?.[1]);
    const reviewed = await rt.store.mergeRecord.forTask(b.id);
    await rt.githostWatcher?.pollOnce();
    // The app closes; the person squash-merges A on GitHub's website meanwhile.
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);
    await github.mergePullRequest(REPO, prA, { method: "squash" });

    // ---- the next start, on the same home ----------------------------------------------------
    const rt2 = await compose();
    apps.push(rt2);
    await rt2.githostWatcher?.pollOnce();
    await host.settle();
    expect(await rt2.store.mergeRecord.forTask(a.id)).toMatchObject({
      state: "merged",
      method: "squash",
    });
    const pr = await github.getPullRequest(REPO, prB);
    const files = (await (
      await fetch(`${host.baseUrl}/repos/${FULL}/pulls/${prB}/files`, {
        headers: { Authorization: `Bearer ${ghToken}` },
      })
    ).json()) as { filename: string }[];
    expect(files.map((f) => f.filename)).toEqual(["footer.html"]);
    expect(pr.body).not.toContain("Builds on");
    const record = await rt2.store.mergeRecord.forTask(b.id);
    expect(record).toMatchObject({
      state: "left_to_you",
      reviewed_head_sha: pr.head.sha,
      own_change_id: reviewed?.own_change_id,
    });
    // The person's Merge merges it without a conflict.
    if (!record) throw new Error("no record");
    const merged = await rt2.merge.mergeRecorded(record, {
      kind: "person",
      humanId: rt2.human.id,
    });
    expect(merged.status).toBe("merged");
  });
});
