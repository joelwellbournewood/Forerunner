import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, Logger, run, safeSegment } from "@forerunner/platform";
import type { MergeRecordRow, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPullRequests } from "../src/daemon/pull-requests.ts";
import { loadTaskDisplayContext, taskDisplay } from "../src/daemon/task-display.ts";
import { requestViews } from "../src/daemon/views.ts";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import { MERGE_PR_TOOL, ReviewedPrMerge } from "../src/loop/merge.ts";
import type { MergeMode } from "../src/loop/merge-mode.ts";
import { DependentBranches } from "../src/session/dependent-branches.ts";
import { GitHostWatcher } from "../src/session/githost-watcher.ts";
import { syncPrAnswers } from "../src/session/pr-answers.ts";
import type { TaskExecutor } from "../src/session/runner.ts";
import {
  closingReply,
  doneExecutor,
  grant,
  type LoopWorld,
  loopWorld,
  submitReply,
} from "./loop-helpers.ts";

/**
 * Dependent branches stay true when what they build on is merged, closed or redone (ADR 0111,
 * 'dependent-branches'), with the parts composed as the daemon composes them: the session
 * runner, the PR executor, the merge step with its record, the git host watcher whose
 * callbacks reach `DependentBranches`, and the testenv fake GitHub (its REST API and git smart
 * HTTP, squash and rebase merges as GitHub makes them). Real git.
 *
 * Before: a dependency merged by squash on GitHub left the dependent branch holding its
 * commits (nothing rebuilt it, the dependency's record stayed "waiting for you"), a dependency
 * closed or redone stayed inside the dependent branch and could reach main with it, a rebuilt
 * branch whose own change was unchanged could be merged unattended although it was reviewed on
 * top of work that is gone, and the watcher reported nothing about merged or closed PRs.
 */
const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };
const REPO = { owner: "alice", name: "app" };
const FULL = "alice/app";
const roots: string[] = [];
const hosts: FakeGitHost[] = [];
const worlds: LoopWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function chainWorld(opts: { level: 2 | 3; mode?: MergeMode }) {
  const w = await loopWorld({
    replies: [submitReply({ grade: 91 }, { times: Number.POSITIVE_INFINITY }), closingReply()],
  });
  worlds.push(w);
  const root = mkdtempSync(join(tmpdir(), "fr-dep-merge-"));
  roots.push(root);
  const host = await FakeGitHost.start({ rootDir: join(root, "host"), clock: w.clock });
  hosts.push(host);
  host.createUser({ login: "alice", name: "Alice", email: identity.email });
  const repo = await host.createRepo({
    owner: "alice",
    name: "app",
    private: true,
    defaultBranch: "main",
    initialFiles: { "README.md": "# app\n" },
  });
  const token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
  const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: w.clock });
  await w.store.project.patch(w.project, {
    repos: [FULL],
    autonomy_level: opts.level,
    ...(opts.mode ? { settings: { merge_mode: opts.mode } } : {}),
  });
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens: w.tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill: w.kill,
    clock: w.clock,
    ledger: new MemoryLedger(),
    audit,
    approvals: new AutoApprove("approved"),
  });
  const done = doneExecutor(w);
  /** What each task's run writes, by title (default: its own file under src/). */
  const writes = new Map<string, Record<string, string>>();
  const fileOf = (title: string) => `src/${title.toLowerCase().replace(/[^a-z]+/g, "-")}.ts`;
  /** Runs held open by title (`holdRun`): each resolves once the test releases it. */
  const runHolds = new Map<string, () => Promise<void>>();
  const executor = new PrTaskExecutor({
    store: w.store,
    clock: w.clock,
    host: github,
    inner: {
      execute: (ctx) => done.execute(ctx),
      withWorktree: (dir) => ({
        async execute(ctx) {
          // A run a test holds open (TM-5): its folder stays locked until the test releases it.
          await runHolds.get(ctx.task.title)?.();
          await mkdir(join(dir, "src"), { recursive: true });
          const files = writes.get(ctx.task.title) ?? {
            [fileOf(ctx.task.title)]: `export const v = "${ctx.task.title}";\n`,
          };
          for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
          return done.execute(ctx);
        },
      }),
    },
    repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
    worktreeRoot,
    token,
    identity,
  });
  // The merge step's view of GitHub, on which a test holds one call open (R-lock): the call
  // waits until the test releases it, then goes to the fake GitHub as it is.
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  const mergeHost = new Proxy(github, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const held = holds.get(String(prop));
        if (held) {
          holds.delete(String(prop));
          held.reached();
          await held.released;
        }
        return value.apply(target, args);
      };
    },
  });
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock: w.clock,
    tokens: w.tokens,
    hooks,
    audit,
    host: mergeHost,
    worktreeRoot,
    token,
    identity,
    agentIds: [w.alice],
    allowedDomains: ["127.0.0.1"],
    stopped: (agentId) => w.kill.isFrozen({ agentId }),
    checksWaitMs: 0,
  });
  // As compose.ts wires them.
  const dependents = new DependentBranches({
    store: w.store,
    clock: w.clock,
    merge,
    executor,
  });
  merge.onMerged((e) => dependents.dependencyMerged(e));
  const watcher = new GitHostWatcher({
    store: w.store,
    clock: w.clock,
    host: github,
    agentIds: [w.alice],
    humanId: w.human,
    start: async () => ({ id: "s", result: "started" }),
    retryMerges: () => merge.retryWaiting(),
    onPullRequestState: (pr, info) => dependents.pullRequestState(pr, info),
    repositoryProjects: async () => [{ projectId: w.project, repo: REPO }],
    onDefaultBranchHead: (p) => dependents.sweep(p.projectId),
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${host.baseUrl}/repos/${FULL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<unknown>;
  };
  const m = {
    w,
    host,
    github,
    merge,
    dependents,
    watcher,
    audit,
    writes,
    worktreeRoot,
    fileOf,
    /** One task through one session: the executor (branch, PR), the critic, the merge step. */
    async runTask(
      title: string,
      o: {
        dependsOn?: string[];
        afterPr?: (pr: { number: number; headSha: string }) => Promise<void>;
      } = {},
    ): Promise<TaskRow> {
      const task = await w.addTask(title, { depends_on: o.dependsOn ?? [] });
      await m.session(o);
      return w.store.task.mustGet(task.id);
    },
    /** One session over the tasks that are ready (a redo runs this way). */
    async session(
      o: { afterPr?: (pr: { number: number; headSha: string }) => Promise<void> } = {},
    ): Promise<void> {
      const ex: TaskExecutor = {
        async execute(ctx) {
          const result = await executor.execute(ctx);
          await host.settle();
          if (result.prUrl && o.afterPr) {
            const n = Number(/\/pull\/(\d+)/.exec(result.prUrl)?.[1]);
            await o.afterPr({
              number: n,
              headSha: (await github.getPullRequest(REPO, n)).head.sha,
            });
          }
          return result;
        },
      };
      await w.start(w.runner(ex, { merge: dependents.mergePort(merge) }), {
        grant: {
          allowedTools: [...grant.allowedTools, MERGE_PR_TOOL],
          allowedPaths: [worktreeRoot],
          allowedDomains: ["127.0.0.1"],
          grantedSecrets: [],
        },
      });
      await host.settle();
    },
    async prNumber(taskId: string) {
      const t = await w.store.task.mustGet(taskId);
      return Number(/\/pull\/(\d+)/.exec(t.pr_url ?? "")?.[1]);
    },
    async pr(taskId: string) {
      return github.getPullRequest(REPO, await m.prNumber(taskId));
    },
    async record(taskId: string): Promise<MergeRecordRow> {
      const r = await w.store.mergeRecord.forTask(taskId);
      if (!r) throw new Error("no merge record");
      return r;
    },
    /** The person's Merge click (the in-app Merge that 'merge-in-app' adds). */
    async mergeByPerson(taskId: string) {
      const out = await merge.mergeRecorded(await m.record(taskId), {
        kind: "person",
        humanId: w.human,
      });
      await host.settle();
      return out;
    },
    async poll() {
      const r = await watcher.pollOnce();
      await host.settle();
      return r;
    },
    async prCommits(n: number) {
      return ((await api("GET", `/pulls/${n}/commits`)) as { commit: { message: string } }[]).map(
        (c) => c.commit.message.split("\n")[0] ?? "",
      );
    },
    async prFiles(n: number) {
      return ((await api("GET", `/pulls/${n}/files`)) as { filename: string }[])
        .map((f) => f.filename)
        .sort();
    },
    async close(taskId: string) {
      await github.updatePullRequest(REPO, await m.prNumber(taskId), { state: "closed" });
    },
    async check(sha: string, status: "in_progress" | "completed", conclusion?: string) {
      await api("POST", "/check-runs", {
        name: "ci/test",
        head_sha: sha,
        status,
        ...(conclusion ? { conclusion } : {}),
      });
    },
    async hostGit(...args: string[]) {
      return (await run(["git", "--git-dir", repo.dir, ...args])).stdout.trim();
    },
    forcedPushes(branch: string) {
      return host
        .events()
        .filter(
          (e) =>
            e.event === "push" &&
            e.payload.ref === `refs/heads/${branch}` &&
            e.payload.forced === true,
        );
    },
    async cards(taskId: string) {
      const rows = await w.store.humanRequest.list({ task_id: taskId, status: "open" } as never);
      return (await requestViews(w.store, rows)).map((v) => ({ title: v.title, body: v.body }));
    },
    /**
     * Holds the next run of the task titled `title` open inside its folder (TM-5): `reached`
     * resolves once the run started (the PR executor holds the folder's lock), and the run goes
     * on only after `release`.
     */
    holdRun(title: string) {
      let reached!: () => void;
      let release!: () => void;
      const was = new Promise<void>((r) => {
        reached = r;
      });
      const released = new Promise<void>((r) => {
        release = r;
      });
      runHolds.set(title, async () => {
        runHolds.delete(title);
        reached();
        await released;
      });
      return { reached: was, release: () => release() };
    },
    /**
     * Holds the merge step's next call of `method` on GitHub open (R-lock): `reached` resolves
     * once the call is made, and nothing reaches GitHub until `release`.
     */
    hold(method: string) {
      let reached!: () => void;
      let release!: () => void;
      const was = new Promise<void>((r) => {
        reached = r;
      });
      holds.set(method, {
        reached,
        released: new Promise<void>((r) => {
          release = r;
        }),
      });
      return { reached: was, release: () => release() };
    },
  };
  return m;
}

describe("dependent branches stay true, composed (ADR 0111)", { timeout: 240_000 }, () => {
  it("(b) a chain of three with main moving before each merge, merged in order with merge commits: each task's own commit reaches main once, every PR is marked merged, nothing is rebuilt or force-pushed", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add styles", { dependsOn: [a.id] });
    const c = await m.runTask("Add footer", { dependsOn: [b.id] });
    for (const t of [a, b, c]) expect((await m.record(t.id)).state).toBe("left_to_you");
    const heads = new Map<string, string>();
    for (const t of [a, b, c]) heads.set(t.id, (await m.pr(t.id)).head.sha);
    await m.poll(); // the watcher's baseline: nothing to rebuild
    for (const [i, t] of [a, b, c].entries()) {
      await m.host.seedCommit(FULL, { [`docs/note-${i}.md`]: "notes\n" }, "main moved", "main");
      expect((await m.mergeByPerson(t.id)).status).toBe("merged");
      await m.poll();
    }
    for (const t of [a, b, c]) {
      expect(await m.pr(t.id)).toMatchObject({ merged: true, state: "closed" });
      expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
      // Its own file came to main in one commit: nothing was copied.
      expect(
        (await m.hostGit("log", "--format=%H", "main", "--", m.fileOf(t.title))).split("\n"),
      ).toHaveLength(1);
      // Its pull request still has the head it was reviewed with: no rebuild, no force-push.
      expect((await m.pr(t.id)).head.sha).toBe(heads.get(t.id));
      expect(m.forcedPushes((await m.pr(t.id)).head.ref)).toEqual([]);
    }
  });

  it("(c) the dependency squash-merged on GitHub: the watcher's report rebuilds the dependent onto main, the dependency is no longer waiting, and the dependent merges without a conflict", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    expect(await m.prCommits(prB)).toContain("Add page");
    const reviewed = await m.record(b.id);
    // The person clicks Squash and merge on GitHub's website.
    await m.github.mergePullRequest(REPO, prA, { method: "squash" });
    await m.poll();
    // The dependency's record says what GitHub did: merged, by squash.
    expect(await m.record(a.id)).toMatchObject({ state: "merged", method: "squash" });
    // The dependent's pull request now holds only its own work, on top of main.
    expect(await m.prCommits(prB)).toEqual(["Add footer"]);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    expect(m.forcedPushes((await m.pr(b.id)).head.ref)).toHaveLength(1);
    expect((await m.pr(b.id)).body).not.toContain("Builds on");
    // Its own change is the one reviewed: the record follows the new head and still waits for
    // the person (level 2), with no card.
    const moved = await m.record(b.id);
    expect(moved).toMatchObject({ state: "left_to_you", own_change_id: reviewed.own_change_id });
    expect(moved.reviewed_head_sha).toBe((await m.pr(b.id)).head.sha);
    expect(moved.reviewed_head_sha).not.toBe(reviewed.reviewed_head_sha);
    expect(await m.cards(b.id)).toEqual([]);
    // It merges without a conflict, and main has the page once (its squash) and the footer.
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    expect(
      (await m.hostGit("log", "--format=%s", "main", "--", m.fileOf("Add page"))).split("\n"),
    ).toEqual([`Add page (#${prA})`]);
    expect(await m.hostGit("ls-tree", "-r", "--name-only", "main")).toContain(
      m.fileOf("Add footer"),
    );
  });

  it("(c) a chain of three, the first squash-merged on GitHub: the second is rebuilt onto main and the third follows it (bench walk, 2026-11-03), nothing is voided and both merge in order", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const c = await m.runTask("Add notes", { dependsOn: [b.id] });
    const [prA, prB, prC] = [
      await m.prNumber(a.id),
      await m.prNumber(b.id),
      await m.prNumber(c.id),
    ];
    await m.github.mergePullRequest(REPO, prA, { method: "squash" });
    await m.poll();
    expect(await m.prCommits(prB)).toEqual(["Add footer"]);
    // C holds B's rebuilt branch and its own commit, nothing of A.
    expect(await m.prFiles(prC)).toEqual([m.fileOf("Add footer"), m.fileOf("Add notes")].sort());
    expect(await m.prCommits(prC)).not.toContain("Add page");
    expect((await m.pr(c.id)).body).toContain(`Builds on #${prB} (not merged yet)`);
    // Neither review is void: both still wait for the person with their own sentence.
    for (const t of [b, c]) {
      const r = await m.record(t.id);
      expect(r.state).toBe("left_to_you");
      expect(r.last_outcome).toBe("not_allowed");
      expect(r.reviewed_head_sha).toBe((await m.pr(t.id)).head.sha);
    }
    expect(await m.cards(c.id)).toEqual([]);
    // Merged in order, each one cleanly; main has each task's change once.
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    await m.poll();
    expect((await m.mergeByPerson(c.id)).status).toBe("merged");
    for (const t of [a, b, c])
      expect(
        (await m.hostGit("log", "--format=%H", "main", "--", m.fileOf(t.title))).split("\n"),
      ).toHaveLength(1);
  });

  it("(c) a chain of three whose middle task's folder is busy when the first is squash-merged: once the middle is free, the third's pull request holds none of the first's original commits (R-chain)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const c = await m.runTask("Add notes", { dependsOn: [b.id] });
    const [prA, prB, prC] = [
      await m.prNumber(a.id),
      await m.prNumber(b.id),
      await m.prNumber(c.id),
    ];
    await m.poll();
    // B's folder holds a change nobody committed: B cannot be rebuilt while it is there.
    const scratch = join(m.worktreeRoot, safeSegment(b.id), "scratch.txt");
    writeFileSync(scratch, "trying something\n");
    await m.github.mergePullRequest(REPO, prA, { method: "squash" });
    await m.poll();
    expect(await m.prCommits(prB)).toContain("Add page");
    // The folder is free again: the next poll rebuilds B, and C follows the rebuilt B.
    rmSync(scratch);
    await m.poll();
    expect(await m.prCommits(prB)).toEqual(["Add footer"]);
    expect(await m.prCommits(prC)).not.toContain("Add page");
    expect(await m.prFiles(prC)).toEqual([m.fileOf("Add footer"), m.fileOf("Add notes")].sort());
    expect((await m.pr(c.id)).body).toContain(`Builds on #${prB} (not merged yet)`);
    // Neither review is void, nothing is owed: both wait for the person on their new heads.
    for (const t of [b, c]) {
      const r = await m.record(t.id);
      expect(r).toMatchObject({ state: "left_to_you", rebuild_owed_for: null });
      expect(r.last_outcome).toBe("not_allowed");
      expect(r.reviewed_head_sha).toBe((await m.pr(t.id)).head.sha);
    }
    expect(await m.cards(c.id)).toEqual([]);
    // A later poll changes nothing more; the chain merges in order, cleanly, each change once.
    const heads = [(await m.pr(b.id)).head.sha, (await m.pr(c.id)).head.sha];
    await m.poll();
    expect([(await m.pr(b.id)).head.sha, (await m.pr(c.id)).head.sha]).toEqual(heads);
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    await m.poll();
    expect((await m.mergeByPerson(c.id)).status).toBe("merged");
    for (const t of [a, b, c])
      expect(
        (await m.hostGit("log", "--format=%H", "main", "--", m.fileOf(t.title))).split("\n"),
      ).toHaveLength(1);
  });

  it("(c) the dependent changes the dependency's own file (live check 1's second chain): after a squash on GitHub it is rebuilt with only its own commit and merges with no conflict", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Add page", { "src/page.ts": 'export const title = "Hello";\n' });
    const a = await m.runTask("Add page");
    m.writes.set("Change the page", {
      "src/page.ts": 'export const title = "Hello";\nexport const footer = "Bye";\n',
    });
    const b = await m.runTask("Change the page", { dependsOn: [a.id] });
    const prB = await m.prNumber(b.id);
    await m.github.mergePullRequest(REPO, await m.prNumber(a.id), { method: "squash" });
    await m.poll();
    expect(await m.prCommits(prB)).toEqual(["Change the page"]);
    expect(await m.prFiles(prB)).toEqual(["src/page.ts"]);
    expect((await m.record(b.id)).last_outcome).toBe("not_allowed");
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    expect(await m.hostGit("show", "main:src/page.ts")).toContain('footer = "Bye"');
  });

  it("(d) a dependency closed without merging: the dependent is rebuilt without it, its review is void (one sentence, one card), and a merge the gate would make unattended (Merge automatically after review) does not happen", async () => {
    const m = await chainWorld({ level: 2, mode: "after_review" });
    // A waits for the person (its checks fail), B's checks are still running when it is accepted.
    const a = await m.runTask("Add page", {
      afterPr: (pr) => m.check(pr.headSha, "completed", "failure"),
    });
    expect((await m.pr(a.id)).merged).toBe(false);
    const b = await m.runTask("Add footer", {
      dependsOn: [a.id],
      afterPr: (pr) => m.check(pr.headSha, "in_progress"),
    });
    expect(await m.record(b.id)).toMatchObject({ state: "waiting_checks" });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    // The person closes the dependency's pull request.
    await m.close(a.id);
    await m.poll();
    expect(await m.record(a.id)).toMatchObject({
      state: "left_to_you",
      sentence: `#${prA} was closed without merging.`,
    });
    // B no longer carries A's work, on the host.
    const branchB = (await m.pr(b.id)).head.ref;
    expect(await m.hostGit("ls-tree", "-r", "--name-only", branchB)).not.toContain(
      m.fileOf("Add page"),
    );
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    const sentence = `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`;
    expect(await m.record(b.id)).toMatchObject({ state: "left_to_you", sentence });
    // One card, titled by the task and the pull request it was rebuilt without.
    expect(await m.cards(b.id)).toEqual([
      { title: `"Add footer" was rebuilt without pull request #${prA}`, body: sentence },
    ]);
    // Its checks pass on the rebuilt head: still nothing merges it unattended.
    await m.check((await m.pr(b.id)).head.sha, "completed", "success");
    await m.poll();
    await m.merge.retryWaiting();
    expect((await m.pr(b.id)).merged).toBe(false);
    expect((await m.record(b.id)).state).toBe("left_to_you");
  });

  /** A closes without merging; B, built on it, is rebuilt without it: its card. */
  async function rebuiltWithout() {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prB = await m.prNumber(b.id);
    await m.close(a.id);
    await m.poll();
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const [view] = await requestViews(m.w.store, rows);
    if (!view || !rows[0]) throw new Error("no rebuild card");
    return { m, b, prB, row: rows[0], view };
  }
  const answerCard = async (
    m: Awaited<ReturnType<typeof chainWorld>>,
    row: { id: string; version: number },
    label: string,
  ) => {
    await m.w.store.humanRequest.answer(row.id, row.version, label, m.w.human);
    return syncPrAnswers({
      store: m.w.store,
      clock: m.w.clock,
      humanId: m.w.human,
      agentId: m.w.alice,
      merge: m.merge,
    });
  };

  it("the rebuild card offers Merge and Redo, never 'I merged it' while the pull request is open; Merge merges it through the merge step and the card says so (R-rebuildcard)", async () => {
    const { m, b, prB, row, view } = await rebuiltWithout();
    expect(view.choices?.map((c) => c.label)).toEqual(["Merge", "Redo"]);
    expect(view.choices?.map((c) => c.label)).not.toContain("I merged it");
    expect(view.choices?.[0]?.explain).toBe(
      `Merges #${prB} as it is now, as Merge on the Overview does.`,
    );
    const rowsBefore = m.audit.entries.filter((e) => e.tool === MERGE_PR_TOOL).length;
    const done = await answerCard(m, row, view.choices?.[0]?.label ?? "");
    expect(done.merging).toBe(1);
    expect((await m.pr(b.id)).merged).toBe(true);
    expect(await m.record(b.id)).toMatchObject({ state: "merged", approval: "person" });
    // Gated calls with the person's approval in their audit rows (the first finds the rebuilt
    // head and follows it, as the Overview's Merge does, since the task's own change is the one
    // reviewed).
    const rows = m.audit.entries.filter((e) => e.tool === MERGE_PR_TOOL).slice(rowsBefore);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.allowed && r.inputSummary.includes(`the person ${m.w.human}`))).toBe(
      true,
    );
    // The task's reason never says "merged by you" for a merge it made.
    expect((await m.w.store.task.mustGet(b.id)).reason).not.toMatch(/merged by you/);
    const answered = await m.w.store.humanRequest.mustGet(row.id);
    const [after] = await requestViews(m.w.store, [answered]);
    expect(after?.outcome).toBe(`Merged #${prB}.`);
  });

  it("the rebuild card's Redo makes the task ready again; nothing is merged (R-rebuildcard)", async () => {
    const { m, b, row, view } = await rebuiltWithout();
    const done = await answerCard(m, row, view.choices?.[1]?.label ?? "");
    expect(done.redone).toBe(1);
    expect((await m.w.store.task.mustGet(b.id)).status).toBe("ready");
    expect((await m.pr(b.id)).merged).toBe(false);
    const answered = await m.w.store.humanRequest.mustGet(row.id);
    const [after] = await requestViews(m.w.store, [answered]);
    expect(after?.outcome).toBe("Redone: the task is ready again and a session runs it.");
  });

  it("the rebuilt card's Redo also does the task again from main: one new commit of the task's own on main, not the old commit with the new one on top (fix-up of R-rebuildcard)", async () => {
    const { m, b, prB, row, view } = await rebuiltWithout();
    const redo = view.choices?.find((c) => c.label === "Redo");
    expect(redo?.explain).toBe("The task is done again from main; a session starts for it.");
    const oldHead = (await m.pr(b.id)).head.sha;
    expect((await answerCard(m, row, redo?.label ?? "")).redone).toBe(1);
    const ready = await m.w.store.task.mustGet(b.id);
    await m.w.store.task.patch(b.id, { attempt: ready.attempt + 1 });
    m.writes.set("Add footer", { [m.fileOf("Add footer")]: 'export const v = "redone";\n' });
    await m.session();
    expect((await m.w.store.task.mustGet(b.id)).status).toBe("done");
    const pr = await m.pr(b.id);
    expect(pr.number).toBe(prB);
    expect(pr.head.sha).not.toBe(oldHead);
    // Resumed, the branch would hold the rebuilt commit and the redo's on top of it.
    expect(await m.prCommits(prB)).toEqual(["Add footer"]);
    expect(await m.hostGit("rev-parse", `${pr.head.sha}^`)).toBe(
      await m.hostGit("rev-parse", "refs/heads/main"),
    );
  });

  it("the conflict rebuild card's Redo does the task again from main, as its line says: the next run starts the branch from main, the open pull request gets only the task's own work, and no second conflict card (fix-up of R-rebuildcard)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    // The dependent edits its dependency's own file: the common chain.
    m.writes.set("Fix the page", { [m.fileOf("Add page")]: 'export const v = "fixed";\n' });
    const b = await m.runTask("Fix the page", { dependsOn: [a.id] });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    await m.close(a.id);
    await m.poll();
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const [view] = await requestViews(m.w.store, rows);
    if (!view || !rows[0]) throw new Error("no rebuild card");
    expect(view.title).toBe(`"Fix the page" could not be rebuilt without pull request #${prA}`);
    const redo = view.choices?.find((c) => c.label === "Redo");
    expect(redo?.explain).toBe("The task is done again from main; a session starts for it.");
    const answered = await answerCard(m, rows[0], redo?.label ?? "");
    expect(answered.redone).toBe(1);
    // The stand-in executor names its run by the attempt: the redo is the next one.
    const ready = await m.w.store.task.mustGet(b.id);
    await m.w.store.task.patch(b.id, { attempt: ready.attempt + 1 });
    // The session the Redo starts.
    await m.session();
    const after = await m.w.store.task.mustGet(b.id);
    // Before: the run resumed the open pull request's branch, rebuilt it again, hit the same
    // conflict and stopped: needs_human, "merge conflict in src/add-page.ts", a second card.
    expect([after.status, /conflict/.test(after.reason ?? "")]).toEqual(["done", false]);
    const open = await m.cards(b.id);
    expect(
      open.filter((c) => /conflict|could not be rebuilt/i.test(`${c.title} ${c.body}`)),
    ).toEqual([]);
    // The same pull request, now with only the task's own work on main.
    expect(await m.prNumber(b.id)).toBe(prB);
    const pr = await m.pr(b.id);
    expect(pr.state).toBe("open");
    expect(await m.prCommits(prB)).toEqual(["Fix the page"]);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add page")]);
    expect(await m.hostGit("rev-parse", `${pr.head.sha}^`)).toBe(
      await m.hostGit("rev-parse", "refs/heads/main"),
    );
    // Its merge record follows the new review: nothing is merged unattended.
    expect(pr.merged).toBe(false);
    expect((await m.record(b.id)).reviewed_head_sha).toBe(pr.head.sha);
  });

  it("(d) a dependency redone: the dependent is rebuilt without it at the next poll, its review is void", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    // Redo of A (the Tasks tab's Redo).
    const done = await m.w.store.task.mustGet(a.id);
    await m.w.store.task.reopen(a.id, done.version, "ready", "Redo asked by you");
    await m.poll();
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      sentence: `#${prB} was rebuilt without #${prA}, whose task was reopened. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`,
    });
    // A later poll changes nothing more.
    const head = (await m.pr(b.id)).head.sha;
    await m.poll();
    expect((await m.pr(b.id)).head.sha).toBe(head);
  });

  it("(d) a dependency cancelled: the dependent is rebuilt without it at the next poll, its review is void", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    // Redone, then cancelled by the person before it ran again.
    const done = await m.w.store.task.mustGet(a.id);
    const ready = await m.w.store.task.reopen(a.id, done.version, "ready", "Redo asked by you");
    await m.w.store.task.transition(a.id, ready.version, "cancelled", "Cancelled by you", {
      humanId: m.w.human,
    });
    await m.poll();
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    expect((await m.record(b.id)).sentence).toBe(
      `#${prB} was rebuilt without #${prA}, whose task was cancelled. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`,
    );
  });

  it("(d) a rebuild that conflicts leaves the branch as it was and files one card naming the pull requests", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    // The dependent changes the dependency's own file.
    m.writes.set("Fix the page", { [m.fileOf("Add page")]: 'export const v = "fixed";\n' });
    const b = await m.runTask("Fix the page", { dependsOn: [a.id] });
    const prA = await m.prNumber(a.id);
    const prB = await m.prNumber(b.id);
    const head = (await m.pr(b.id)).head.sha;
    await m.close(a.id);
    await m.poll();
    expect((await m.pr(b.id)).head.sha).toBe(head);
    expect(m.forcedPushes((await m.pr(b.id)).head.ref)).toEqual([]);
    const sentence = `#${prB} could not be rebuilt without #${prA}, which was closed: both change ${m.fileOf("Add page")}. It waits for you: redo the task, or merge it on GitHub only if you want #${prA}'s changes too.`;
    expect(await m.record(b.id)).toMatchObject({ state: "left_to_you", sentence });
    const cards = await m.cards(b.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      title: `"Fix the page" could not be rebuilt without pull request #${prA}`,
      body: sentence,
    });
    // The next poll files no second card.
    await m.poll();
    expect(await m.cards(b.id)).toHaveLength(1);
  });

  it("a dependency closed while the dependent was being reviewed: the dependent is rebuilt before its merge and is not merged unattended", async () => {
    const m = await chainWorld({ level: 2, mode: "after_review" });
    const a = await m.runTask("Add page", {
      afterPr: (pr) => m.check(pr.headSha, "completed", "failure"),
    });
    const prA = await m.prNumber(a.id);
    const b = await m.runTask("Add footer", {
      dependsOn: [a.id],
      afterPr: async (pr) => {
        await m.check(pr.headSha, "completed", "success");
        // Closed after the run, while the critic reviews it.
        await m.close(a.id);
      },
    });
    const prB = await m.prNumber(b.id);
    expect((await m.pr(b.id)).merged).toBe(false);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      sentence: `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`,
    });
    await m.merge.retryWaiting();
    expect((await m.pr(b.id)).merged).toBe(false);
  });

  it("(e) a redo of a task whose pull request was squash-merged on GitHub: a new pull request from a fresh branch, and its merge record starts again (it is not reported merged)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const first = await m.pr(a.id);
    await m.github.mergePullRequest(REPO, first.number, { method: "squash" });
    await m.poll();
    expect(await m.record(a.id)).toMatchObject({ state: "merged", method: "squash" });
    const done = await m.w.store.task.mustGet(a.id);
    await m.w.store.task.reopen(a.id, done.version, "ready", "Redo asked by you");
    // The stand-in executor names its run by the attempt: the redo is the next one.
    await m.w.store.task.patch(a.id, { attempt: done.attempt + 1 });
    m.writes.set("Add page", { [m.fileOf("Add page")]: 'export const v = "redone";\n' });
    await m.session();
    const redo = await m.pr(a.id);
    expect(redo.number).not.toBe(first.number);
    expect(redo).toMatchObject({ state: "open", merged: false });
    expect(redo.head.ref).toBe(`${first.head.ref}-r2`);
    // The old branch is still on GitHub; the redo's record waits for the person, not "merged".
    expect(await m.hostGit("rev-parse", "--verify", `refs/heads/${first.head.ref}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(await m.record(a.id)).toMatchObject({
      state: "left_to_you",
      pr_number: redo.number,
      merge_sha: null,
      method: null,
    });
    const left = m.w.events.filter((e) => e.type === "pr.merged" || e.type === "pr.left_open");
    expect(left.at(-1)?.type).toBe("pr.left_open");
  });

  it("a merge the dependency's PR got inside the dependent's merge commit marks its record merged (merge-record's leftover)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    // GitHub marks A's pull request merged: its commits reached main with B's.
    expect(await m.pr(a.id)).toMatchObject({ merged: true });
    expect((await m.record(a.id)).state).toBe("left_to_you");
    await m.poll();
    expect(await m.record(a.id)).toMatchObject({ state: "merged", method: "merge" });
  });

  /** `p`, or a failure that says what never happened (a real-time wait: never on CI's speed). */
  const within = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${what} within 20 s`)), 20_000),
      ),
    ]);
  const withoutA = (prB: number, prA: number) =>
    `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`;

  it("a dependency closed while the person's Merge brings main into the dependent: the rebuild waits for the merge step's git, and the head that still holds the closed work is never merged (R-lock)", async () => {
    const m = await chainWorld({ level: 2 });
    // The branch must be up to date with main: Merge brings main in first, in B's folder.
    m.host.setBranchRules(FULL, "main", [
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: true, required_status_checks: [] },
      },
    ]);
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const [prA, prB] = [await m.prNumber(a.id), await m.prNumber(b.id)];
    await m.poll();
    await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
    const headB = (await m.pr(b.id)).head.sha;
    // The person presses Merge on B; the merge step is bringing main into B's folder (it reads
    // the checks on the head before it merges main in) when the person closes A on GitHub.
    const held = m.hold("listCheckRuns");
    const merging = m.mergeByPerson(b.id);
    await within(held.reached, "the merge step did not start bringing main in");
    await m.close(a.id);
    await m.poll();
    // The watcher's rebuild did not touch B's folder or branch while the merge step works there:
    // it is owed, and B's merge cannot go ahead before it ran.
    expect((await m.pr(b.id)).head.sha).toBe(headB);
    expect((await m.record(b.id)).rebuild_owed_for).toBe(a.id);
    held.release();
    const out = await within(merging, "the merge did not end");
    expect(out.status).not.toBe("merged");
    expect((await m.pr(b.id)).merged).toBe(false);
    // The next poll runs the owed rebuild: B holds only its own work, its review is void, one card.
    await m.poll();
    expect((await m.pr(b.id)).merged).toBe(false);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      sentence: withoutA(prB, prA),
      rebuild_owed_for: null,
    });
    expect(await m.cards(b.id)).toEqual([
      { title: `"Add footer" was rebuilt without pull request #${prA}`, body: withoutA(prB, prA) },
    ]);
    // Nothing merges it later by itself.
    await m.merge.retryWaiting();
    await m.poll();
    expect((await m.pr(b.id)).merged).toBe(false);
  });

  it("a dependency closed while the merge call is held open on GitHub: the rebuild pushes first, GitHub refuses the old head, and the record keeps the rebuild's word (R-lock)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const [prA, prB] = [await m.prNumber(a.id), await m.prNumber(b.id)];
    await m.poll();
    const held = m.hold("mergePullRequest");
    const merging = m.mergeByPerson(b.id);
    await within(held.reached, "the merge step did not call GitHub's merge");
    await m.close(a.id);
    await m.poll();
    held.release();
    const out = await within(merging, "the merge did not end");
    expect(out.status).not.toBe("merged");
    expect((await m.pr(b.id)).merged).toBe(false);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    // GitHub's refusal of the old head does not replace what the rebuild said.
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      sentence: withoutA(prB, prA),
    });
    expect(await m.cards(b.id)).toHaveLength(1);
  });

  it("an open pull request that conflicts with main once another merges: one card after one poll, none more at the next, Merge no longer offered; once the person resolves it on GitHub, their commit is not the reviewed version, so the row still offers no Merge and the one card says it changed after the review (R-conflict)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Write the page", { "index.html": "<h1>one</h1>\n" });
    m.writes.set("Write the other page", { "index.html": "<h1>two</h1>\n" });
    const a = await m.runTask("Write the page");
    const b = await m.runTask("Write the other page");
    const prB = await m.prNumber(b.id);
    await m.poll();
    expect(await m.cards(b.id)).toEqual([]);
    // The person merges the first; the second now changes the same lines as main.
    expect((await m.mergeByPerson(a.id)).status).toBe("merged");
    expect((await m.pr(b.id)).mergeable).toBe(false);
    await m.poll();
    const sentence = `#${prB} conflicts with main in index.html: resolve the conflict on GitHub, or redo the task.`;
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "conflict",
      sentence,
    });
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const views = await requestViews(m.w.store, rows);
    expect(views.map((v) => ({ title: v.title, body: v.body }))).toEqual([
      { title: `"Write the other page" conflicts with main`, body: sentence },
    ]);
    expect(views[0]?.choices?.map((c) => c.label)).toEqual(["Redo", "Leave it open"]);
    // The next poll files nothing more.
    await m.poll();
    expect(await m.cards(b.id)).toHaveLength(1);
    // The person resolves it on GitHub, as the notice says (main's version kept on the branch):
    // a commit after the review. Before (the review of leftovers7-merge2): the record went back
    // to no sentence and Merge was offered again, and the person's Merge was then refused ("#N
    // changed after the review") with a second card.
    const reviewed = (await m.record(b.id)).reviewed_head_sha;
    await m.host.seedCommit(
      FULL,
      { "index.html": "<h1>one</h1>\n" },
      "Resolve",
      (await m.pr(b.id)).head.ref,
    );
    const resolved = await m.pr(b.id);
    expect([resolved.mergeable, resolved.head.sha === reviewed]).toEqual([true, false]);
    await m.poll();
    const moved = `#${prB} changed after the review: look at the new commits, then merge it yourself or send it back.`;
    // The head-moved word the merge step itself gives (no Merge on the Overview: `NO_CLICK`).
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "head_moved",
      sentence: moved,
      reviewed_head_sha: reviewed,
    });
    // Still one card, saying so, with what the person can do now.
    const open = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const later = await requestViews(m.w.store, open);
    expect(later.map((v) => ({ title: v.title, body: v.body }))).toEqual([
      {
        title: `The critic accepted "Write the other page", but pull request #${prB} was not merged`,
        body: moved,
      },
    ]);
    expect(later[0]?.choices?.map((c) => c.label)).toEqual(["Redo", "Leave it open"]);
    // Its Details say what to do now, not how to resolve a conflict that is gone.
    expect(later[0]?.details).toEqual([
      "Look at the commits pushed after the review",
      "Merge it yourself or ask for a new review",
    ]);
    // Nothing more at the next poll, and nothing merged.
    await m.poll();
    expect(await m.cards(b.id)).toHaveLength(1);
    expect((await m.record(b.id)).last_outcome).toBe("head_moved");
    expect((await m.pr(b.id)).merged).toBe(false);
  });

  it("a conflict that goes away on main (the conflicting change taken out again) leaves the reviewed version as it was: the card closes, Merge is offered again, and the person's Merge merges it (R-conflict fix-up)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Retitle the app", { "README.md": "# one\n" });
    m.writes.set("Retitle the app again", { "README.md": "# two\n" });
    const a = await m.runTask("Retitle the app");
    const b = await m.runTask("Retitle the app again");
    const prB = await m.prNumber(b.id);
    expect((await m.mergeByPerson(a.id)).status).toBe("merged");
    await m.poll();
    expect(await m.record(b.id)).toMatchObject({
      last_outcome: "conflict",
      sentence: `#${prB} conflicts with main in README.md: resolve the conflict on GitHub, or redo the task.`,
    });
    expect(await m.cards(b.id)).toHaveLength(1);
    // Someone puts main's title back: the reviewed head merges cleanly as it is.
    const reviewed = (await m.record(b.id)).reviewed_head_sha;
    await m.host.seedCommit(FULL, { "README.md": "# app\n" }, "Put the title back", "main");
    const pr = await m.pr(b.id);
    expect([pr.mergeable, pr.head.sha]).toEqual([true, reviewed]);
    await m.poll();
    expect(await m.cards(b.id)).toEqual([]);
    // It says again what it said before the notice (TM-7, leftovers7-tailmerge: before, an
    // empty sentence, which lost words such as a rebuild's warning); the row offers Merge with
    // no sentence, as it did then.
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "not_allowed",
      sentence: `#${prB} waits for you to merge it: press Merge on the Overview.`,
      reviewed_head_sha: reviewed,
    });
    const overview = await new ProjectPullRequests({ store: m.w.store, host: m.github }).view(
      await m.w.store.project.mustGet(m.w.project),
    );
    expect(overview.waiting.find((w) => w.number === prB)?.merge).toMatchObject({
      state: "left_to_you",
      canMerge: true,
      sentence: null,
    });
    // The Merge the row offers again works.
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    expect((await m.pr(b.id)).merged).toBe(true);
    expect(await m.hostGit("show", "main:README.md")).toBe("# two");
  });

  it("the conflict notice's Redo does the task again from main, as its line says: the session it starts ends with the same pull request merging cleanly, no second card, and the person's Merge merges it (R-conflict fix-up)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Write the page", { "index.html": "<h1>one</h1>\n" });
    m.writes.set("Write the other page", { "index.html": "<h1>two</h1>\n" });
    const a = await m.runTask("Write the page");
    const b = await m.runTask("Write the other page");
    const prB = await m.prNumber(b.id);
    expect((await m.mergeByPerson(a.id)).status).toBe("merged");
    await m.poll();
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const [view] = await requestViews(m.w.store, rows);
    if (!view || !rows[0]) throw new Error("no conflict card");
    expect(view.title).toBe(`"Write the other page" conflicts with main`);
    // The answer the Inbox sends: the card's own option.
    const redo = view.choices?.find((c) => c.label === "Redo");
    expect(redo?.explain).toBe("The task is done again from main; a session starts for it.");
    expect((await answerCard(m, rows[0], redo?.label ?? "")).redone).toBe(1);
    // The stand-in executor names its run by the attempt: the redo is the next one.
    const ready = await m.w.store.task.mustGet(b.id);
    expect(ready.status).toBe("ready");
    await m.w.store.task.patch(b.id, { attempt: ready.attempt + 1 });
    // The session the Redo starts.
    await m.session();
    const after = await m.w.store.task.mustGet(b.id);
    // Before: the run resumed the open pull request's branch, its rebase onto main conflicted in
    // index.html, and the task stopped with a second card in git words ("Rebase of fr/... onto
    // main conflicts in ...", I resolved it / Drop the branch / Cancel the task).
    expect([after.status, /conflict/i.test(after.reason ?? "")]).toEqual(["done", false]);
    expect(
      (await m.cards(b.id)).filter((c) => /conflict|rebase/i.test(`${c.title} ${c.body}`)),
    ).toEqual([]);
    // The same pull request, with only the task's own work on main, merging cleanly.
    expect(await m.prNumber(b.id)).toBe(prB);
    const pr = await m.pr(b.id);
    expect([pr.state, pr.merged, pr.mergeable]).toEqual(["open", false, true]);
    expect(await m.prCommits(prB)).toEqual(["Write the other page"]);
    expect(await m.hostGit("rev-parse", `${pr.head.sha}^`)).toBe(
      await m.hostGit("rev-parse", "refs/heads/main"),
    );
    // Its record follows the new review and waits for the person's Merge, as any accept does in
    // "You press Merge"; the poll says nothing more.
    await m.poll();
    expect(await m.cards(b.id)).toEqual([]);
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "not_allowed",
      sentence: `#${prB} waits for you to merge it: press Merge on the Overview.`,
      reviewed_head_sha: pr.head.sha,
    });
    expect((await m.mergeByPerson(b.id)).status).toBe("merged");
    expect(await m.hostGit("show", "main:index.html")).toBe("<h1>two</h1>");
  });

  it("two unmerged dependencies that conflict: the dependent waits with one Inbox card naming both pull requests (W6-22)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Write the page", { "index.html": "<h1>one</h1>\n" });
    m.writes.set("Write the other page", { "index.html": "<h1>two</h1>\n" });
    const a = await m.runTask("Write the page");
    const b = await m.runTask("Write the other page");
    const c = await m.runTask("Check both pages", { dependsOn: [a.id, b.id] });
    expect(c.status).toBe("needs_human");
    const [prA, prB] = [await m.prNumber(a.id), await m.prNumber(b.id)];
    const cards = await m.cards(c.id);
    expect(cards).toHaveLength(1);
    expect(`${cards[0]?.title} ${cards[0]?.body}`).toContain(
      `"Write the other page" (pull request #${prB}) and "Write the page" (pull request #${prA}) both change index.html`,
    );
  });
});

/**
 * Leftovers of waves 12 and 14, merge side (leftovers7-tailmerge, wave 13), composed as above:
 * the runner, the PR executor, the critic, the merge step, the watcher and the fake GitHub.
 */
describe("leftovers7-tailmerge, wave 13", { timeout: 240_000 }, () => {
  type ChainWorld = Awaited<ReturnType<typeof chainWorld>>;
  /** The person's answer, as the Inbox sends it (one of the card's options), then applied. */
  const answer = async (m: ChainWorld, row: { id: string; version: number }, label: string) => {
    await m.w.store.humanRequest.answer(row.id, row.version, label, m.w.human);
    return syncPrAnswers({
      store: m.w.store,
      clock: m.w.clock,
      humanId: m.w.human,
      agentId: m.w.alice,
      merge: m.merge,
    });
  };
  /** What the Overview lists (GET /projects/:id/pull-requests) and what the Tasks row says. */
  const screens = async (m: ChainWorld, taskId: string) => {
    const project = await m.w.store.project.mustGet(m.w.project);
    const view = await new ProjectPullRequests({ store: m.w.store, host: m.github }).view(project);
    const tasks = await m.w.store.task.list({ project_id: m.w.project } as never);
    const ctx = await loadTaskDisplayContext(m.w.store, tasks, null);
    const task = await m.w.store.task.mustGet(taskId);
    return { waiting: view.waiting, row: taskDisplay(task, ctx) };
  };
  /** A runs and its pull request merges; B, on the same lines, then conflicts with main. */
  async function conflictingPair() {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Write the page", { "index.html": "<h1>one</h1>\n" });
    m.writes.set("Write the other page", { "index.html": "<h1>two</h1>\n" });
    const a = await m.runTask("Write the page");
    const b = await m.runTask("Write the other page");
    const prB = await m.prNumber(b.id);
    expect((await m.mergeByPerson(a.id)).status).toBe("merged");
    return { m, a, b, prB };
  }
  /** B's next attempt (the stand-in names its run by the attempt), whose run changes nothing. */
  const redoChangingNothing = async (m: ChainWorld, taskId: string) => {
    const ready = await m.w.store.task.mustGet(taskId);
    expect(ready.status).toBe("ready");
    await m.w.store.task.patch(taskId, { attempt: ready.attempt + 1 });
    // Main already says what the task says: done again from main, it changes nothing.
    m.writes.set(ready.title, { "index.html": "<h1>one</h1>\n" });
    await m.session();
    return m.w.store.task.mustGet(taskId);
  };

  it("the conflict notice's Redo whose run changes nothing: no empty pull request is left open and offered for Merge; the task fails in one sentence and the Overview lists nothing for it (TM-1)", async () => {
    const { m, b, prB } = await conflictingPair();
    await m.poll();
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const [view] = await requestViews(m.w.store, rows);
    if (!view || !rows[0]) throw new Error("no conflict card");
    const redo = view.choices?.find((c) => c.label === "Redo");
    expect((await answer(m, rows[0], redo?.label ?? "")).redone).toBe(1);
    const after = await redoChangingNothing(m, b.id);
    // Before: the run committed nothing, main's head was force-pushed to the open pull request,
    // the task was accepted and the empty pull request waited for the person's Merge.
    const sentence = `Redone from main, it changed nothing, so #${prB} was closed.`;
    expect([after.status, after.reason]).toEqual(["failed", sentence]);
    const pr = await m.pr(b.id);
    expect([pr.state, pr.merged]).toEqual(["closed", false]);
    expect(await m.hostGit("rev-parse", `refs/heads/${pr.head.ref}`)).not.toBe(
      await m.hostGit("rev-parse", "refs/heads/main"),
    );
    await m.poll();
    const { waiting, row } = await screens(m, b.id);
    expect(waiting.map((w) => w.number)).not.toContain(prB);
    expect(row.label).toBe(`Failed: ${sentence}`);
    // Its record offers nothing more: the pull request was closed.
    expect(await m.record(b.id)).toMatchObject({ state: "left_to_you", last_outcome: "closed" });
  });

  for (const mainMoves of [true, false]) {
    it(`a done task redone while its merge waits for its checks${mainMoves ? ", main moved" : ", main where it was"}: the watcher's poll still delivers a comment while the redo runs, and the old head is not merged (TM-5)`, async () => {
      const m = await chainWorld({ level: 2, mode: "after_review" });
      const a = await m.runTask("Add page", {
        afterPr: (pr) => m.check(pr.headSha, "in_progress"),
      });
      expect(await m.record(a.id)).toMatchObject({ state: "waiting_checks" });
      const pr = await m.pr(a.id);
      // Someone else comments on pull requests: a person the watcher hears.
      m.host.createUser({ login: "bob", name: "Bob", email: "bob@example.test" });
      m.host.addCollaborator(FULL, "bob");
      const bob = m.host.createToken({ owner: "bob", kind: "classic", scopes: ["repo"] }).token;
      await m.poll();
      // The person presses Redo on the done task, and its session's run starts (held open: it
      // keeps the task's folder, as a real run does for minutes).
      const done = await m.w.store.task.mustGet(a.id);
      await m.w.store.task.reopen(a.id, done.version, "ready", "Redo asked by you");
      await m.w.store.task.patch(a.id, { attempt: done.attempt + 1 });
      const held = m.holdRun("Add page");
      const session = m.session();
      try {
        await held.reached;
        // Meanwhile the old head's checks pass, main may move on (someone else's merge), and
        // Bob comments on the pull request.
        await m.check(pr.head.sha, "completed", "success");
        if (mainMoves)
          await m.host.seedCommit(FULL, { "other.txt": "other\n" }, "Someone's change", "main");
        const res = await fetch(`${m.host.baseUrl}/repos/${FULL}/issues/${pr.number}/comments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bob}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: "Please also add a footer." }),
        });
        expect(res.status).toBe(201);
        // Before: the retry pass, which the poll awaits, took the waiting record. With main
        // moved, the gate's look at it waited for the folder's lock until the redo's run ended:
        // no event, no copy refresh, no conflict notice for that long. With main where it was,
        // the pass merged the old head while the task was being done again.
        const polled = m.watcher.pollOnce();
        const outcome = await Promise.race([
          polled.then((r) => ({ done: true as const, r })),
          new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 15_000)),
        ]);
        expect(
          outcome.done,
          "the watcher's poll did not end within 15 s while the redo's run held the task's folder",
        ).toBe(true);
        const events = outcome.done ? outcome.r.events : [];
        expect(events.map((e) => (e.kind === "comment" ? e.comment.body : e.kind))).toContain(
          "Please also add a footer.",
        );
        // The old head is never merged while the task is being done again.
        expect((await m.pr(a.id)).merged).toBe(false);
        expect((await m.record(a.id)).state).toBe("waiting_checks");
      } finally {
        held.release();
        await session;
      }
    });
  }

  it("Merge pressed while a rebuild is owed because the task's folder holds changes nobody committed: the Overview row and the Tasks row say why it waits and what to do, never 'Merging…'; the warning is logged once (TM-4)", async () => {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const prB = await m.prNumber(b.id);
    // Someone left a change in B's folder (a conflict card's steps, a look by hand).
    const left = join(m.worktreeRoot, safeSegment(b.id), "notes.txt");
    writeFileSync(left, "my notes\n");
    const warned: string[] = [];
    const off = Logger.addSink((r) => {
      if (r.msg.includes("its worktree has uncommitted changes")) warned.push(r.msg);
    });
    try {
      await m.close(a.id);
      await m.poll();
      expect((await m.record(b.id)).rebuild_owed_for).toBe(a.id);
      // The person presses Merge on B's row: the merge waits for the rebuild (R-lock).
      const project = await m.w.store.project.mustGet(m.w.project);
      const prs = new ProjectPullRequests({ store: m.w.store, host: m.github, merge: m.merge });
      await prs.merge(project, prB, m.w.human);
      await prs.idle();
      expect((await m.pr(b.id)).merged).toBe(false);
      const sentence = `#${prB} waits for changes left in its task's folder: take them out or redo the task.`;
      // Before: the row read "Merging…" (state queued) and the Tasks row "Accepted · merging",
      // with no reason, until the folder was cleaned.
      const { waiting, row } = await screens(m, b.id);
      expect(waiting.find((w) => w.number === prB)?.merge).toMatchObject({
        state: "waiting_checks",
        canMerge: false,
        sentence,
      });
      expect(row).toMatchObject({ label: "Accepted · merge waits for you", detail: sentence });
      // More polls and retries: the merge still waits, and the warning was logged once.
      await m.poll();
      await m.poll();
      expect((await m.pr(b.id)).merged).toBe(false);
      expect(warned).toHaveLength(1);
      // The change put away: the next poll rebuilds B, and the wait's words are gone.
      rmSync(left);
      await m.poll();
      const after = await m.record(b.id);
      expect(after.rebuild_owed_for).toBeNull();
      expect(after.last_outcome).not.toBe("owed_folder_changes");
      const again = await screens(m, b.id);
      expect(again.row.detail ?? "").not.toContain("waits for the changes left");
      expect(again.waiting.find((w) => w.number === prB)?.merge?.sentence ?? "").not.toContain(
        "waits for the changes left",
      );
    } finally {
      off();
    }
  });

  it("a record rebuilt without its dependency that then conflicts with main, and the conflict goes away on main: the row and the card say again what they said before the notice, with the Merge they offered (TM-7)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Retitle the app", { "README.md": "# footer\n" });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Retitle the app", { dependsOn: [a.id] });
    const [prA, prB] = [await m.prNumber(a.id), await m.prNumber(b.id)];
    // A is closed: B is rebuilt without it, and waits for the person with its warning.
    await m.close(a.id);
    await m.poll();
    const warning = `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`;
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "rebuilt_without",
      sentence: warning,
    });
    const rowOf = async () => (await screens(m, b.id)).waiting.find((w) => w.number === prB);
    expect((await rowOf())?.merge).toMatchObject({ canMerge: true, sentence: warning });
    const head = (await m.pr(b.id)).head.sha;
    // Someone changes the same line on main: the notice.
    await m.host.seedCommit(FULL, { "README.md": "# other\n" }, "Retitle on main", "main");
    await m.poll();
    expect((await m.record(b.id)).last_outcome).toBe("conflict");
    expect((await rowOf())?.merge).toMatchObject({ state: "blocked", canMerge: false });
    // The change on main is taken back: B's head is the one the row offered Merge for.
    await m.host.seedCommit(FULL, { "README.md": "# app\n" }, "Put the title back", "main");
    expect([(await m.pr(b.id)).mergeable, (await m.pr(b.id)).head.sha]).toEqual([true, head]);
    await m.poll();
    // Before: the record went to "changed after the review" (its reviewed head is the one
    // before the rebuild), or with an empty sentence, and the warning was gone.
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "rebuilt_without",
      sentence: warning,
    });
    expect((await rowOf())?.merge).toMatchObject({
      state: "left_to_you",
      canMerge: true,
      sentence: warning,
    });
    // The one card says it again too, with what it offered.
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const views = await requestViews(m.w.store, rows);
    expect(views.map((v) => ({ title: v.title, body: v.body }))).toEqual([
      { title: `"Retitle the app" was rebuilt without pull request #${prA}`, body: warning },
    ]);
    expect(views[0]?.choices?.map((c) => c.label)).toEqual(["Merge", "Redo"]);
    // Nothing more at the next poll.
    await m.poll();
    expect((await m.record(b.id)).last_outcome).toBe("rebuilt_without");
  });

  it("'Drop the branch and retry from scratch' whose run changes nothing: the same, one sentence and a closed pull request (TM-1)", async () => {
    const { m, b, prB } = await conflictingPair();
    // The Tasks tab's Redo: the run resumes the open pull request's branch, and its rebase onto
    // main conflicts: the person's conflict card.
    const done = await m.w.store.task.mustGet(b.id);
    await m.w.store.task.reopen(b.id, done.version, "ready", "Redo asked by you");
    await m.w.store.task.patch(b.id, { attempt: done.attempt + 1 });
    await m.session();
    expect((await m.w.store.task.mustGet(b.id)).status).toBe("needs_human");
    const rows = await m.w.store.humanRequest.list({ task_id: b.id, status: "open" } as never);
    const [view] = await requestViews(m.w.store, rows);
    const drop = view?.choices?.find((c) => c.label === "Drop the branch and retry from scratch");
    if (!rows[0] || !drop) throw new Error("no rebase conflict card");
    expect((await answer(m, rows[0], drop.label)).dropped).toBe(1);
    const after = await redoChangingNothing(m, b.id);
    const sentence = `Redone from main, it changed nothing, so #${prB} was closed.`;
    expect([after.status, after.reason]).toEqual(["failed", sentence]);
    expect((await m.pr(b.id)).state).toBe("closed");
    await m.poll();
    const { waiting, row } = await screens(m, b.id);
    expect(waiting.map((w) => w.number)).not.toContain(prB);
    expect(row.label).toBe(`Failed: ${sentence}`);
  });

  it("the Tasks tab's Redo of a done task whose change main already has: no empty pull request is offered for Merge; the task fails in one sentence and its pull request is closed (TM-1's sibling, fix-up)", async () => {
    const m = await chainWorld({ level: 2 });
    m.writes.set("Write the page", { "index.html": "<h1>one</h1>\n" });
    const a = await m.runTask("Write the page");
    expect(a.status).toBe("done");
    const pr = await m.pr(a.id);
    // Someone else makes the same change on main; the pull request still merges cleanly.
    await m.host.seedCommit(FULL, { "index.html": "<h1>one</h1>\n" }, "The same page", "main");
    // The person presses Redo on the Tasks tab, and the next session runs it: it resumes the
    // open pull request's branch and writes the same page again.
    const done = await m.w.store.task.mustGet(a.id);
    await m.w.store.task.reopen(a.id, done.version, "ready", "Redo asked by you");
    await m.w.store.task.patch(a.id, { attempt: done.attempt + 1 });
    await m.session();
    // Before: the rebase onto main dropped the commit main already had, main's head was
    // force-pushed to the pull request (no file left in it), the critic accepted it and the
    // Overview offered Merge on the empty pull request (bench, review of wave 13, step 29).
    const after = await m.w.store.task.mustGet(a.id);
    const sentence = `#${pr.number} no longer changes anything on main, so it was closed.`;
    expect([after.status, after.reason]).toEqual(["failed", sentence]);
    const closed = await m.pr(a.id);
    expect([closed.state, closed.merged]).toEqual(["closed", false]);
    expect(closed.head.sha).toBe(pr.head.sha);
    expect(await m.hostGit("rev-parse", `refs/heads/${pr.head.ref}`)).not.toBe(
      await m.hostGit("rev-parse", "refs/heads/main"),
    );
    expect(m.forcedPushes(pr.head.ref)).toEqual([]);
    await m.poll();
    const { waiting, row } = await screens(m, a.id);
    expect(waiting.map((w) => w.number)).not.toContain(pr.number);
    expect(row.label).toBe(`Failed: ${sentence}`);
  });

  /**
   * TM-4's wait, as the person meets it: A <- B, a file left in B's folder, A closed (B owes a
   * rebuild), the person's Merge on B. The row's sentence offers only ways out the code keeps
   * (the review of wave 13: "commit them" was offered, and the rebuild then reset the branch to
   * GitHub's, so the person's commit was on no branch and the file gone from the folder).
   */
  async function mergeWaitingForFolder() {
    const m = await chainWorld({ level: 2 });
    const a = await m.runTask("Add page");
    const b = await m.runTask("Add footer", { dependsOn: [a.id] });
    const [prA, prB] = [await m.prNumber(a.id), await m.prNumber(b.id)];
    const folder = join(m.worktreeRoot, safeSegment(b.id));
    writeFileSync(join(folder, "notes.txt"), "my notes\n");
    await m.close(a.id);
    await m.poll();
    const project = await m.w.store.project.mustGet(m.w.project);
    const prs = new ProjectPullRequests({ store: m.w.store, host: m.github, merge: m.merge });
    await prs.merge(project, prB, m.w.human);
    await prs.idle();
    const sentence = `#${prB} waits for changes left in its task's folder: take them out or redo the task.`;
    const { waiting, row } = await screens(m, b.id);
    expect(waiting.find((w) => w.number === prB)?.merge).toMatchObject({
      canMerge: false,
      sentence,
    });
    expect(row).toMatchObject({ label: "Accepted · merge waits for you", detail: sentence });
    return { m, a, b, prA, prB, folder };
  }

  it("the folder's wait, way out 'take them out': the person moves the file out of the folder; the next check rebuilds the branch, the file is where the person put it, and the row says what came of the rebuild with its Merge (TM-4, review fix-up)", async () => {
    const { m, b, prA, prB, folder } = await mergeWaitingForFolder();
    const kept = join(mkdtempSync(join(tmpdir(), "fr-mine-")), "notes.txt");
    roots.push(join(kept, ".."));
    renameSync(join(folder, "notes.txt"), kept);
    await m.poll();
    // The person's file is theirs, as they left it, and never went to GitHub.
    expect(readFileSync(kept, "utf8")).toBe("my notes\n");
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    // B was rebuilt without A: it waits for the person again, with the rebuild's warning and
    // Merge (before, the user guide said "your Merge goes on"; nothing merges it unasked).
    const warning = `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it, then merge it or redo the task.`;
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      last_outcome: "rebuilt_without",
      rebuild_owed_for: null,
      sentence: warning,
    });
    const { waiting } = await screens(m, b.id);
    expect(waiting.find((w) => w.number === prB)?.merge).toMatchObject({
      canMerge: true,
      sentence: warning,
    });
    expect((await m.pr(b.id)).merged).toBe(false);
  });

  it("the folder's wait, way out 'redo the task': the redo does the task again without the folder's changes, the critic reviews it, and the row waits for the person's Merge again; nothing merges unasked (TM-4, review fix-up)", async () => {
    const { m, b, prB, folder } = await mergeWaitingForFolder();
    const done = await m.w.store.task.mustGet(b.id);
    await m.w.store.task.reopen(b.id, done.version, "ready", "Redo asked by you");
    await m.w.store.task.patch(b.id, { attempt: done.attempt + 1 });
    await m.session();
    await m.poll();
    expect((await m.w.store.task.mustGet(b.id)).status).toBe("done");
    // The redo set the folder's changes aside: the folder is clean and the pull request holds
    // only the task's own file, rebuilt without the closed dependency.
    expect(existsSync(join(folder, "notes.txt"))).toBe(false);
    expect(await m.prFiles(prB)).toEqual([m.fileOf("Add footer")]);
    // The person's earlier Merge is not carried over to the redone work: it waits for them.
    expect(await m.record(b.id)).toMatchObject({
      state: "left_to_you",
      rebuild_owed_for: null,
      sentence: `#${prB} waits for you to merge it: press Merge on the Overview.`,
    });
    const { waiting, row } = await screens(m, b.id);
    expect(waiting.find((w) => w.number === prB)?.merge).toMatchObject({ canMerge: true });
    expect(row.label).toBe("Accepted · waiting for you to merge");
    expect((await m.pr(b.id)).merged).toBe(false);
  });
});
