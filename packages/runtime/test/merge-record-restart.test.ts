import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, GitOps } from "@forerunner/capabilities";
import { appDirs, join, run, SimulatedClock } from "@forerunner/platform";
import type { SessionRow } from "@forerunner/state";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { MERGE_PR_TOOL } from "../src/loop/merge.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * ADR 0111 across a restart: a merge whose checks still run when the session's wait ends is
 * kept on disk (the merge record), and after the daemon is composed again on the same home it
 * merges once the host's checks turn green, with no session, on its own narrow token, through
 * the hooks with one audit row. A merge a dead daemon left in the middle (`merging`) is settled
 * at the start by what the host says. Before: the outcome lived in the session's memory and the
 * task's reason text; nothing retried it.
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

describe("a waiting merge survives a restart (ADR 0111)", { timeout: 180_000 }, () => {
  it("the record is on disk; at the next start a merge left in the middle is settled, and the retry merges the waiting one once its checks pass", async () => {
    const clock = new SimulatedClock("2026-11-02T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-merge-restart-"));
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
    // No wait inside the session: the merge is left to the retry at once.
    const env = { FORERUNNER_HOME: home, FORERUNNER_MERGE_CHECKS_WAIT_MS: "0" };
    const dirs = appDirs({ env });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, ghToken);
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const compose = (recoverSessions: boolean) =>
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
        startServices: false,
        recoverSessions,
      });
    const check = async (sha: string, status: "in_progress" | "completed", conclusion?: string) => {
      const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
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

    // ---- the first daemon: a task accepted at level 3 whose checks still run ----------------
    const rt = await compose(false);
    apps.push(rt);
    const project = await rt.store.project.insert({
      name: "App",
      goal: "Ship the app",
      repos: [FULL],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 3,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    const taskOf = (title: string) =>
      rt.store.task.insert({
        project_id: project.id,
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
    const openPr = async (taskId: string, branch: string, file: string) => {
      const wt = join(dirs.worktrees, taskId);
      const git = new GitOps({ cwd: wt, identity, auth: { token: ghToken } });
      await git.clone(host.cloneUrl(FULL));
      await git.createBranch(branch, "origin/main");
      writeFileSync(join(wt, file), `export const f = "${file}";\n`);
      await git.commitAll(file);
      await git.push(branch);
      const pr = await github.createPullRequest(REPO, {
        title: file,
        body: "",
        head: branch,
        base: "main",
      });
      await rt.store.task.patch(taskId, { pr_url: pr.htmlUrl });
      return pr;
    };
    const waitingTask = await taskOf("Add feature");
    const prWaiting = await openPr(waitingTask.id, "fr/feature", "feature.ts");
    await check(prWaiting.head.sha, "in_progress");
    const grant = await rt.sessionGrant(project.id);
    const sessionToken = rt.tokens.issue({
      runId: "run-session",
      sessionId: "s-merge",
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
      autonomy: 3,
      planApproved: false,
      expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
    });
    const outcome = await rt.merge.mergeReviewed({
      task: await rt.store.task.mustGet(waitingTask.id),
      session: { id: "s-merge" } as SessionRow,
      token: sessionToken,
      budget: new SessionBudget({
        sessionId: "s-merge",
        budgetUsdMicro: 1_000_000,
        stepCap: 10,
        deadlineMs: clock.now() + 3_600_000,
        reserveShare: 0.1,
      }),
      signal: new AbortController().signal,
      agentId: rt.agent.id,
    });
    expect(outcome).toMatchObject({ status: "checks_pending" });
    expect(await rt.store.mergeRecord.forTask(waitingTask.id)).toMatchObject({
      state: "waiting_checks",
      reviewed_head_sha: prWaiting.head.sha,
    });
    // A second task whose merge the daemon died in the middle of: the host merged it.
    const crashedTask = await taskOf("Add footer");
    const prCrashed = await openPr(crashedTask.id, "fr/footer", "footer.ts");
    const pinned = await rt.store.mergeRecord.pin({
      task_id: crashedTask.id,
      project_id: project.id,
      agent_id: rt.agent.id,
      pr_number: prCrashed.number,
      pr_url: prCrashed.htmlUrl,
      reviewed_head_sha: prCrashed.head.sha,
    });
    expect(await rt.store.mergeRecord.claim(pinned)).toMatchObject({ state: "merging" });
    const hostMerge = await github.mergePullRequest(REPO, prCrashed.number, {
      sha: prCrashed.head.sha,
    });
    expect(hostMerge.merged).toBe(true);
    // The app closes (or the PC sleeps) while the first one's checks run.
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);
    await check(prWaiting.head.sha, "completed", "success");

    // ---- the next start, on the same home ---------------------------------------------------
    const rt2 = await compose(true);
    apps.push(rt2);
    expect(await rt2.store.mergeRecord.forTask(crashedTask.id)).toMatchObject({
      state: "merged",
      merge_sha: hostMerge.sha,
    });
    expect((await rt2.store.mergeRecord.forTask(waitingTask.id))?.state).toBe("waiting_checks");
    await rt2.merge.retryWaiting();
    const merged = await github.getPullRequest(REPO, prWaiting.number);
    expect(merged).toMatchObject({ merged: true, state: "closed" });
    const record = await rt2.store.mergeRecord.forTask(waitingTask.id);
    expect(record).toMatchObject({ state: "merged", method: "merge", approval: "mode" });
    const parents = (
      await run([
        "git",
        "--git-dir",
        host.repo(FULL)?.dir ?? "",
        "rev-list",
        "--parents",
        "-n",
        "1",
        record?.merge_sha ?? "",
      ])
    ).stdout
      .trim()
      .split(" ")
      .slice(1);
    expect(parents).toEqual([expect.any(String), prWaiting.head.sha]);
    // One audit row for the retry's call, on a token of its own: not the session's.
    const rows = (await rt2.store.auditLog.list({ tool: MERGE_PR_TOOL } as never)).filter(
      (r) => r.session_id !== "s-merge",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allowed: true, agent_id: rt2.agent.id });
    expect(rows[0]?.session_id).toMatch(/^merge-/);
  });
});
