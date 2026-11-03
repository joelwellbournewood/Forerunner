import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, GitOps } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * merge-in-app across a restart: the project's merge mode and a Merge the person pressed in the
 * app are on disk. The click approved every record of the chain before its answer; when the
 * first one's checks still run and the app closes, the next start's retry merges both, in
 * order, once the checks pass, with no session and no second click.
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

describe("the merge mode and a Merge pressed in the app survive a restart (merge-in-app)", {
  timeout: 180_000,
}, () => {
  it("the mode is read after the restart, and the chain's queued merges finish in order once the checks pass", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-merge-app-restart-"));
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
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
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

    // ---- the first daemon: two done tasks, the second building on the first --------------
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
    const done = async (title: string, file: string, from: string, dependsOn: string[]) => {
      const task = await rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status: "done",
        priority: 1,
        depends_on: dependsOn,
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
      const branch = `fr/${file.replace(/\W+/g, "-")}`;
      await git.createBranch(branch, from);
      writeFileSync(join(wt, file), `export const f = "${file}";\n`);
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
        project_id: project.id,
        agent_id: rt.agent.id,
        pr_number: pr.number,
        pr_url: pr.htmlUrl,
        reviewed_head_sha: pr.head.sha,
      });
      return { task, pr, branch };
    };
    const a = await done("Add the page", "page.ts", "origin/main", []);
    const b = await done("Add the footer", "footer.ts", `origin/${a.branch}`, [a.task.id]);
    await check(a.pr.head.sha, "in_progress");
    const answer = await rt.pullRequests.merge(
      await rt.store.project.mustGet(project.id),
      b.pr.number,
      rt.human.id,
    );
    expect(answer).toEqual({
      state: "queued",
      sentence: `Merging #${a.pr.number} and #${b.pr.number} in order.`,
      order: [a.pr.number, b.pr.number],
    });
    await rt.pullRequests.idle();
    expect(await rt.store.mergeRecord.forTask(a.task.id)).toMatchObject({
      state: "waiting_checks",
      approval: "person",
    });
    expect(await rt.store.mergeRecord.forTask(b.task.id)).toMatchObject({
      state: "queued",
      approval: "person",
      approved_by: rt.human.id,
    });
    // The person switches the project to the automatic mode, then the app closes.
    await rt.store.project.patch(project.id, {
      settings: { members: [rt.agent.id], merge_mode: "after_review" },
    });
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);
    await check(a.pr.head.sha, "completed", "success");

    // ---- the next start, on the same home ---------------------------------------------------
    const rt2 = await compose();
    apps.push(rt2);
    const view = await rt2.pullRequests.view(await rt2.store.project.mustGet(project.id));
    expect(view.mode).toEqual({ key: "after_review", label: "Merge automatically after review" });
    await rt2.merge.retryWaiting();
    const [ra, rb] = [
      await rt2.store.mergeRecord.forTask(a.task.id),
      await rt2.store.mergeRecord.forTask(b.task.id),
    ];
    expect([ra?.state, rb?.state]).toEqual(["merged", "merged"]);
    expect([ra?.approval, rb?.approval]).toEqual(["person", "person"]);
    expect((await github.getPullRequest(REPO, b.pr.number)).merged).toBe(true);
    // In order: the footer's merge commit sits on the page's.
    const footerMerge = await github.getPullRequest(REPO, b.pr.number);
    expect(footerMerge.mergeCommitSha).toBe(rb?.merge_sha);
  });
});
