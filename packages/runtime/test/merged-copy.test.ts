import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, GitOps } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { SessionRow } from "@forerunner/state";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectFilesView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * merged-copy (ADR 0113, the owner's decision of 2026-11-02), in the composed daemon: a merge
 * the app makes (a session's at level 3, a retry's, Merge in the app: all go through
 * `ReviewedPrMerge.onMerged`) brings this computer's copy of the repository to main at once, so
 * `GET /projects/:id/files` lists the merged file with no session ending and no watcher poll;
 * and what the copy holds (its record, its Local only folder) is read again after a restart.
 * Before: the copy moved only when a session ended.
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

/** A composed daemon's home with a fake GitHub that has `alice/app` (main: README.md). */
async function setup() {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-merged-copy-"));
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
  const env = { FORERUNNER_HOME: home, FORERUNNER_MERGE_CHECKS_WAIT_MS: "0" };
  const dirs = appDirs({ env });
  const vault = new MemoryVault();
  await vault.set(SECRET_NAMES.github, ghToken);
  const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
  /** The daemon composed on this home (again after a close: a restart). */
  const compose = async (): Promise<RuntimeApp> => {
    const rt = await composeRuntime({
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
      recoverSessions: false,
    });
    apps.push(rt);
    return rt;
  };
  /** `GET /projects/:id/files`, as the Files tab reads it. */
  const files = async (rt: RuntimeApp, projectId: string): Promise<ProjectFilesView> => {
    const { app, token } = createDaemonApp(rt);
    const res = await app.request(`/projects/${projectId}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ProjectFilesView;
  };
  /** A repository project on `alice/app` at the autonomy level given. */
  const projectAt = (rt: RuntimeApp, autonomy: number) =>
    rt.store.project.insert({
      name: "App",
      goal: "Ship the app",
      repos: [FULL],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: autonomy,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
  /** A task accepted by the critic, its PR open with its reviewed commit in its worktree. */
  const acceptedTask = async (rt: RuntimeApp, projectId: string) => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Add feature",
      outcome: "feature.ts exports the feature",
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
    const wt = join(dirs.worktrees, task.id);
    const git = new GitOps({ cwd: wt, identity, auth: { token: ghToken } });
    await git.clone(host.cloneUrl(FULL));
    await git.createBranch("fr/feature", "origin/main");
    writeFileSync(join(wt, "feature.ts"), 'export const feature = "on";\n');
    await git.commitAll("feature");
    await git.push("fr/feature");
    const pr = await github.createPullRequest(REPO, {
      title: "Add feature",
      body: "",
      head: "fr/feature",
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl, branch: "fr/feature" });
    return { task, pr, head: await git.headSha() };
  };
  return { clock, github, compose, files, projectAt, acceptedTask };
}

describe("this computer's copy follows a merge the app makes (merged-copy)", {
  timeout: 180_000,
}, () => {
  it("a reviewed PR merged by the session: Files lists its file at once and says when the copy was updated; after a restart it still does, with Local only", async () => {
    const { clock, github, compose, files, projectAt, acceptedTask } = await setup();
    const rt = await compose();
    const project = await projectAt(rt, 3);
    // The copy as the scaffold or an earlier refresh left it: main with the README only.
    await rt.docs.refreshCopy(project);
    const before = await files(rt, project.id);
    expect(before.entries.map((e) => e.path)).toEqual(["Local only", "README.md"]);
    const firstUpdate = before.copy?.updatedAt;
    expect(firstUpdate).toBe("2026-11-03T09:00:00.000Z");
    expect(before.copy?.localOnly).toEqual({
      folder: join(rt.docs.copyDir(project.id), "Local only"),
      line: "Never uploaded. Agents can read and change it.",
    });

    const { task, pr } = await acceptedTask(rt, project.id);
    clock.advance(5 * 60_000);
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
      task: await rt.store.task.mustGet(task.id),
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
    expect(outcome).toMatchObject({ status: "merged" });
    expect((await github.getPullRequest(REPO, pr.number)).merged).toBe(true);
    // At once: the copy holds the merged file and says when it was brought there.
    const after = await files(rt, project.id);
    expect(after.entries.map((e) => e.path)).toEqual(["feature.ts", "Local only", "README.md"]);
    expect(after.copy?.updatedAt).toBe("2026-11-03T09:05:00.000Z");

    // The person keeps a file in Local only; the app closes and starts again on the same home.
    writeFileSync(join(rt.docs.copyDir(project.id), "Local only", "notes.txt"), "mine\n");
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);
    const rt2 = await compose();
    const again = await files(rt2, project.id);
    expect(again.entries.map((e) => e.path)).toEqual([
      "feature.ts",
      "Local only",
      "Local only/notes.txt",
      "README.md",
    ]);
    expect(again.copy).toEqual(after.copy);
    expect(rt2.docs.localOnlyFolder(project)).toBe(
      join(rt2.docs.copyDir(project.id), "Local only"),
    );
  });

  it("the person's Merge (the gated entry Merge in the app takes, at autonomy 0): Files lists the merged file at once, and the person's Local only file stays", async () => {
    const { clock, github, compose, files, projectAt, acceptedTask } = await setup();
    const rt = await compose();
    // Autonomy 0: nothing merges unattended; only the person's click does.
    const project = await projectAt(rt, 0);
    await rt.docs.refreshCopy(project);
    writeFileSync(join(rt.docs.copyDir(project.id), "Local only", "notes.txt"), "mine\n");
    const { task, pr, head } = await acceptedTask(rt, project.id);
    clock.advance(7 * 60_000);
    const record = await rt.store.mergeRecord.pin({
      task_id: task.id,
      project_id: project.id,
      agent_id: rt.agent.id,
      pr_number: pr.number,
      pr_url: pr.htmlUrl,
      reviewed_head_sha: head,
      author_agent: rt.agent.id,
    });
    const outcome = await rt.merge.mergeRecorded(record, {
      kind: "person",
      humanId: rt.human.id,
    });
    expect(outcome).toMatchObject({ status: "merged" });
    expect((await github.getPullRequest(REPO, pr.number)).merged).toBe(true);
    // No session ended and no watcher poll ran: the merge itself brought the copy to main.
    const after = await files(rt, project.id);
    expect(after.entries.map((e) => e.path)).toEqual([
      "feature.ts",
      "Local only",
      "Local only/notes.txt",
      "README.md",
    ]);
    expect(after.copy?.updatedAt).toBe("2026-11-03T09:07:00.000Z");
  });
});
