import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { BillingSource } from "@forerunner/billing";
import { MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, run } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { type QueryLike, SdkAgentDriver } from "../src/agent/sdk.ts";
import { fileTools } from "../src/daemon/tools.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { GitDiffPort } from "../src/loop/critic.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
import type { TaskBillingPick } from "../src/session/billing.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { flatPricing, harness, issue, ScriptedProvider } from "./helpers.ts";

/**
 * U-037: in a project without a repository, specialists could do no file work. The PR
 * executor ran the inner executor with no folder: on the loop driver (an API key) the run
 * token's paths were empty and every read and write was refused; on the Agent SDK driver (a
 * subscription) the run worked in an empty folder of its own that nothing read afterwards.
 * Now such a task runs in the project's workspace folder (`<data>/projects/<id>/workspace`,
 * where the intake writes its docs), allowed to read and write there, and the critic gets the
 * change set: the workspace is a local git repository whose diff is this run's work.
 */
const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["read_file", "write_file", "list_dir"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 6,
  timeoutMs: 60_000,
};
const sdkCoder: SpecialistSpec = { ...coder, allowedTools: ["cc:Read", "cc:Write"] };

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function world(driver: "loop" | "sdk") {
  const h = harness();
  const root = mkdtempSync(join(tmpdir(), "fr-u037 "));
  roots.push(root);
  const projectsRoot = join(root, "data", "projects");
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "Notes", repos: [] })).id;
  const workspace = projectWorkspaceDir(projectsRoot, project);
  // What the intake wrote when the project was set up.
  mkdirSync(join(workspace, "docs"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Notes\n\nA notes app.\n", "utf8");
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const task = await store.task.insert({
    project_id: project,
    title: "Write the setup guide",
    outcome: "docs/setup.md explains the setup",
    status: "in_progress",
    risk_tier: 1,
    budget_usd_micro: 1_000_000,
  });
  // The loop specialist reads the README and writes the guide, as a model would.
  const provider = new ScriptedProvider(
    [
      { tools: [{ name: "read_file", input: { path: "README.md" } }] },
      {
        tools: [
          {
            name: "write_file",
            input: { path: "docs/setup.md", content: "# Setup\n\nRun the app.\n" },
          },
        ],
      },
      { text: "Wrote docs/setup.md from the README." },
    ],
    h.clock,
  );
  let sdkCwd: string | null = null;
  const q: QueryLike = (params) => {
    sdkCwd = (params.options as { cwd?: string }).cwd ?? null;
    // The subprocess writes where it runs, as Claude Code's Write tool does.
    if (sdkCwd) writeFileSync(join(sdkCwd, "notes.md"), "notes\n", "utf8");
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-1" };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Wrote notes.md.",
        total_cost_usd: 0.01,
      };
    })();
  };
  const subscription: BillingSource = {
    id: "sub-1",
    kind: "subscription",
    humanId: human,
    label: "subscription",
    credentialRef: "oauth_ref",
    enabled: true,
    priority: 1,
    limits: {},
  };
  const makeLoop = (worktree?: string) =>
    new LoopTaskExecutor({
      store,
      clock: h.clock,
      tokens: h.tokens,
      driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      provider,
      pricing: flatPricing,
      tools: fileTools(),
      billingSourceId: "bs",
      ...(driver === "sdk"
        ? {
            billing: {
              pick: async (): Promise<TaskBillingPick> => ({
                source: subscription,
                driver: "sdk",
                reason: "test pick",
                skipped: [],
                plan: { share: 0.1, monthUsdMicro: 0, allowanceUsdMicro: null, cap: 0.9 },
              }),
            },
            sdk: {
              driver: new SdkAgentDriver({
                hooks: h.hooks,
                kill: h.kill,
                clock: h.clock,
                queryImpl: q,
              }),
              credential: async () => ({ kind: "oauth_token" as const, value: "oauth-test-value" }),
              workRoot: join(root, "worktrees", "sdk-runs"),
              pricing: () => flatPricing,
            },
          }
        : {}),
      specialists: (n, d) => (n === "coder" ? (d === "sdk" ? sdkCoder : coder) : undefined),
      ...(worktree ? { worktreeFor: async () => worktree } : {}),
    });
  const exec = new PrTaskExecutor({
    store,
    clock: h.clock,
    host: new MemoryGitHost("alice"),
    inner: { execute: (ctx) => makeLoop().execute(ctx), withWorktree: (dir) => makeLoop(dir) },
    repoFor: async () => null,
    workspaceFor: async (t) => projectWorkspaceDir(projectsRoot, t.project_id),
    worktreeRoot: join(root, "worktrees"),
    identity: { name: "Alice (Forerunner)", email: "alice@example.test" },
  });
  const result = await exec.execute({
    task,
    session,
    // The session grant as the daemon issues it: the worktrees root and the workspace (U-037).
    token: issue(h, {
      agentId: agent,
      ownerHumanId: human,
      projectId: project,
      sessionId: session.id,
      allowedTools: ["read_file", "write_file", "list_dir", "cc:Read", "cc:Write"],
      allowedPaths: [join(root, "worktrees"), workspace],
      budgetUsdMicro: 5_000_000,
    }),
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
    signal: new AbortController().signal,
  });
  const runs = await store.run.forTask(task.id);
  const claims = h.tokens.claimsForRun(runs[0]?.id ?? "");
  return { h, store, task, workspace, result, provider, claims, sdkCwd: () => sdkCwd };
}

describe("a project without a repository works in its workspace folder (U-037)", () => {
  it("API key (loop driver): the specialist reads and writes in the workspace; the critic gets the change", async () => {
    const w = await world("loop");
    expect(w.result.outcome).toBe("done");
    // What the person finds in the project's folder.
    expect(readFileSync(join(w.workspace, "docs", "setup.md"), "utf8")).toContain("Run the app.");
    // Nothing was refused: the README was read (its text reached the model as data).
    expect(JSON.stringify(w.provider.calls[1]?.messages)).toContain("A notes app.");
    expect(w.claims?.allowedPaths).toEqual([w.workspace]);
    // The change set: the result names the file, and the critic's diff of the worktree it is
    // given (the workspace) is this run's work, not the intake's docs from before.
    expect(w.result.worktree).toBe(w.workspace);
    expect(w.result.changedFiles).toEqual(["docs/setup.md"]);
    const diff = await new GitDiffPort(run).diffFor(w.task, w.result.worktree);
    expect(diff?.changedFiles).toEqual(["docs/setup.md"]);
    expect(diff?.diff).toContain("+Run the app.");
    expect(diff?.diff).not.toContain("A notes app.");
  });

  it("subscription (Agent SDK driver): the run's working folder is the workspace, not an empty one", async () => {
    const w = await world("sdk");
    expect(w.result.outcome).toBe("done");
    expect(w.sdkCwd()).toBe(w.workspace);
    expect(w.claims?.allowedPaths).toEqual([w.workspace]);
    expect(existsSync(join(w.workspace, "notes.md"))).toBe(true);
    expect(w.result.changedFiles).toEqual(["notes.md"]);
  });

  it("a second task's change set is its own: the first task's work is the baseline", async () => {
    const w = await world("loop");
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.h.clock,
      host: new MemoryGitHost("alice"),
      inner: {
        execute: async () => ({ outcome: "done", summary: "x", costUsdMicro: 0 }),
        withWorktree: (dir) => ({
          execute: async () => {
            writeFileSync(join(dir, "CHANGELOG.md"), "# Changes\n", "utf8");
            return { outcome: "done", summary: "x", costUsdMicro: 0 };
          },
        }),
      },
      repoFor: async () => null,
      workspaceFor: async () => w.workspace,
      worktreeRoot: join(w.workspace, "..", "wt"),
    });
    const second = await exec.execute({
      task: w.task,
      session: {} as never,
      token: {} as never,
      budget: {} as never,
      item: { taskId: w.task.id, title: w.task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    expect(second.changedFiles).toEqual(["CHANGELOG.md"]);
    const log = await run(["git", "log", "--format=%s"], { cwd: w.workspace });
    expect(log.stdout).toContain(`Workspace before "${w.task.title}"`);
  });
});
