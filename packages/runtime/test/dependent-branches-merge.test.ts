import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, run } from "@forerunner/platform";
import type { MergeRecordRow, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
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
import { DependentBranches } from "../src/session/dependent-branches.ts";
import { GitHostWatcher } from "../src/session/githost-watcher.ts";
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

async function chainWorld(opts: { level: 2 | 3 }) {
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
  await w.store.project.patch(w.project, { repos: [FULL], autonomy_level: opts.level });
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
  const executor = new PrTaskExecutor({
    store: w.store,
    clock: w.clock,
    host: github,
    inner: {
      execute: (ctx) => done.execute(ctx),
      withWorktree: (dir) => ({
        async execute(ctx) {
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
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock: w.clock,
    tokens: w.tokens,
    hooks,
    audit,
    host: github,
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

  it("(d) a dependency closed without merging: the dependent is rebuilt without it, its review is void (one sentence, one card), and a merge the gate would make unattended at level 3 does not happen", async () => {
    const m = await chainWorld({ level: 3 });
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
    const sentence = `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it before you merge it, or send it back.`;
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
      sentence: `#${prB} was rebuilt without #${prA}, which is being redone. It was reviewed with #${prA}'s changes, so it waits for you: look at it before you merge it, or send it back.`,
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
      `#${prB} was rebuilt without #${prA}, whose task was cancelled. It was reviewed with #${prA}'s changes, so it waits for you: look at it before you merge it, or send it back.`,
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
    const m = await chainWorld({ level: 3 });
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
      sentence: `#${prB} was rebuilt without #${prA}, which was closed. It was reviewed with #${prA}'s changes, so it waits for you: look at it before you merge it, or send it back.`,
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
