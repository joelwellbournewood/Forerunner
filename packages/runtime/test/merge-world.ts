import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, PrTaskExecutor } from "@forerunner/capabilities";
import {
  type Clock,
  ForerunnerError,
  join,
  Logger,
  type LogRecord,
  run,
} from "@forerunner/platform";
import type { MergeRecordRow, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterEach } from "vitest";
import { requestViews } from "../src/daemon/views.ts";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import type { CapabilityClaims } from "../src/enforcement/token.ts";
import { MERGE_PR_TOOL, ReviewedPrMerge } from "../src/loop/merge.ts";
import type { MergeMode } from "../src/loop/merge-mode.ts";
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
 * The merge record's test world (ADR 0111, merge-in-app): real git against the fake git host
 * (its REST API and git smart HTTP), the session runner, the enforcement hooks and the merge
 * step, with one project on the host repository `alice/app`. Shared by merge-record.test.ts
 * and merge-in-app.test.ts.
 */
export const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };
export const REPO = { owner: "alice", name: "app" };
export const FULL = "alice/app";
const roots: string[] = [];
const hosts: FakeGitHost[] = [];
const worlds: LoopWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

export interface RecordWorld {
  w: LoopWorld;
  host: FakeGitHost;
  github: GitHubHost;
  audit: MemoryAudit;
  merge: ReviewedPrMerge;
  token: string;
  worktreeRoot: string;
  /** The claims of every token the merge step asked the hooks with, in order. */
  calls: CapabilityClaims[];
  /** One task through one session: the executor (branch, PR), the critic, the merge step. */
  runTask(
    title: string,
    opts?: {
      dependsOn?: string[];
      afterPr?: (pr: { number: number; headSha: string; branch: string }) => Promise<void>;
    },
  ): Promise<TaskRow>;
  pr(taskId: string): ReturnType<GitHubHost["getPullRequest"]>;
  record(taskId: string): Promise<MergeRecordRow>;
  check(
    sha: string,
    name: string,
    status: "in_progress" | "completed",
    conclusion?: string,
  ): Promise<void>;
  /** `git --git-dir <bare>` on the host's repository. */
  hostGit(...args: string[]): Promise<string>;
  setLevel(level: 2 | 3 | 4): Promise<void>;
  /** The project's merge mode (merge-in-app: what frees an unattended merge). */
  setMode(mode: MergeMode): Promise<void>;
  /** The merge step's GitHub stops answering (every call throws a retryable error) or answers again. */
  setHostDown(down: boolean): void;
}

export async function recordWorld(opts: {
  level: 2 | 3 | 4;
  /** The project's merge mode (merge-in-app); unset: the default, "you". */
  mode?: MergeMode;
  checksWaitMs?: number;
}): Promise<RecordWorld> {
  const w = await loopWorld({
    replies: [submitReply({ grade: 91 }, { times: Number.POSITIVE_INFINITY }), closingReply()],
  });
  worlds.push(w);
  const root = mkdtempSync(join(tmpdir(), "fr-merge-record-"));
  roots.push(root);
  const host = await FakeGitHost.start({ rootDir: join(root, "host"), clock: w.clock });
  hosts.push(host);
  host.createUser({ login: "alice", name: "Alice", email: identity.email });
  const repo = await host.createRepo({
    owner: "alice",
    name: "app",
    private: true,
    defaultBranch: "main",
    initialFiles: { "README.md": "# app\n", "src/index.ts": "export const app = 1;\n" },
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
  const prExecutor = new PrTaskExecutor({
    store: w.store,
    clock: w.clock,
    host: github,
    inner: {
      execute: (ctx) => done.execute(ctx),
      withWorktree: (dir) => ({
        async execute(ctx) {
          await mkdir(join(dir, "src"), { recursive: true });
          const name = ctx.task.title.toLowerCase().replace(/[^a-z]+/g, "-");
          writeFileSync(join(dir, "src", `${name}.ts`), `export const v = "${name}";\n`);
          return done.execute(ctx);
        },
      }),
    },
    repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
    worktreeRoot,
    token,
    identity,
  });
  const calls: CapabilityClaims[] = [];
  const clock: Clock = w.clock;
  // The merge step's view of GitHub, which a test can take down (it does not answer).
  let hostDown = false;
  const mergeHost = new Proxy(github, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (hostDown)
          throw new ForerunnerError("timeout", "GitHub did not answer", { retryable: true });
        return value.apply(target, args);
      };
    },
  });
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock,
    tokens: w.tokens,
    hooks: {
      beforeToolCall: (ctx, tool, input) => {
        calls.push(ctx.token.claims);
        return hooks.beforeToolCall(ctx, tool, input);
      },
      afterToolCall: (ctx, tool, input, result) => hooks.afterToolCall(ctx, tool, input, result),
    },
    audit,
    host: mergeHost,
    worktreeRoot,
    token,
    identity,
    agentIds: [w.alice],
    allowedDomains: ["127.0.0.1"],
    stopped: (agentId) => w.kill.isFrozen({ agentId }),
    checksWaitMs: opts.checksWaitMs ?? 0,
  });
  const m: RecordWorld = {
    w,
    host,
    github,
    audit,
    merge,
    token,
    worktreeRoot,
    calls,
    async runTask(title, o = {}) {
      const task = await w.addTask(title, { depends_on: o.dependsOn ?? [] });
      const executor: TaskExecutor = {
        async execute(ctx) {
          const result = await prExecutor.execute(ctx);
          if (result.prUrl && result.branch && o.afterPr) {
            const n = Number(/\/pull\/(\d+)/.exec(result.prUrl)?.[1]);
            const pr = await github.getPullRequest(REPO, n);
            await o.afterPr({ number: pr.number, headSha: pr.head.sha, branch: result.branch });
          }
          return result;
        },
      };
      await w.start(w.runner(executor, { merge }), {
        grant: {
          allowedTools: [...grant.allowedTools, MERGE_PR_TOOL],
          allowedPaths: [worktreeRoot],
          allowedDomains: ["127.0.0.1"],
          grantedSecrets: [],
        },
      });
      return w.store.task.mustGet(task.id);
    },
    async pr(taskId) {
      const t = await w.store.task.mustGet(taskId);
      const n = Number(/\/pull\/(\d+)/.exec(t.pr_url ?? "")?.[1]);
      if (!n) throw new Error(`no pull request for ${t.title}`);
      return github.getPullRequest(REPO, n);
    },
    async record(taskId) {
      const r = await w.store.mergeRecord.forTask(taskId);
      if (!r) throw new Error("no merge record");
      return r;
    },
    async check(sha, name, status, conclusion) {
      const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          head_sha: sha,
          status,
          ...(conclusion ? { conclusion } : {}),
        }),
      });
      if (res.status !== 201) throw new Error(`check run: ${res.status} ${await res.text()}`);
    },
    async hostGit(...args) {
      return (await run(["git", "--git-dir", repo.dir, ...args])).stdout.trim();
    },
    async setLevel(level) {
      await w.store.project.patch(w.project, { autonomy_level: level });
    },
    async setMode(mode) {
      const p = await w.store.project.mustGet(w.project);
      await w.store.project.patch(w.project, { settings: { ...p.settings, merge_mode: mode } });
    },
    setHostDown(down) {
      hostDown = down;
    },
  };
  return m;
}

export const forcedPushes = (host: FakeGitHost, branch: string) =>
  host
    .events()
    .filter(
      (e) =>
        e.event === "push" && e.payload.ref === `refs/heads/${branch}` && e.payload.forced === true,
    );

export const mergeRows = (audit: MemoryAudit) =>
  audit.entries.filter((e) => e.tool === MERGE_PR_TOOL);

/** The task's cards as the Inbox shows them (`requestViews`, what GET /requests answers). */
export async function inboxCards(m: RecordWorld, taskId: string) {
  const rows = await m.w.store.humanRequest.list({ task_id: taskId } as never);
  return (await requestViews(m.w.store, rows)).map((v) => ({
    title: v.title,
    body: v.body,
    choices: (v.choices ?? []).map((c) => [c.label, c.explain]),
  }));
}

/** The daemon log's "merge record" lines while `fn` runs. */
export async function mergeLogLines(
  fn: () => Promise<unknown>,
): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const off = Logger.addSink((rec: LogRecord) => {
    if (rec.scope === "merge" && rec.msg === "merge record") lines.push(rec.data ?? {});
  });
  try {
    await fn();
  } finally {
    off();
  }
  return lines;
}

/** The left-open card's two answers, each with what it does (design §3.8). */
export const LEFT_OPEN_CHOICES = [
  ["I merged it", "Closes this card and notes on the task that you merged it."],
  ["Leave it open", "Closes this card; the pull request stays open on GitHub."],
];
