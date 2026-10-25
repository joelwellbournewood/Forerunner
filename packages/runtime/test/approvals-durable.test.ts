import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../src/agent/tools.ts";
import { approvalKeyFor, EnforcementHooks, type RunContext } from "../src/enforcement/hooks.ts";
import { approvalKey, StateApprovals } from "../src/wiring/state-ports.ts";
import {
  budget,
  deleteRepoTool,
  flatPricing,
  type Harness,
  harness,
  ScriptedProvider,
} from "./helpers.ts";

/**
 * Durable approvals through `StateApprovals` over the real store (the daemon's and the cloud
 * runner's approval port), spec S.6 and J.8 / J.10 (security review follow-up of 2026-10-21):
 *
 * - an answered "yes" to an always-human action (delete, purchase, credential, permission,
 *   capability grant) admits exactly one call: the resume path re-makes the paused call once,
 *   in the same run or in a later run of the session, and every further identical call files
 *   a new request and waits;
 * - the row's key is the SHA-256 of the raw canonical input, so two inputs that are cut alike
 *   for display never share a row;
 * - a "yes" to any other class holds for the run and for the session, a "no" denies for the
 *   session, and a withdrawn or expired row no longer holds the key.
 */

/** Approval needed at level 2, free at level 3: not an always-human class. */
const mergeTool: ToolSpec<{ pr: number }> = {
  name: "merge_pr",
  description: "merge a reviewed pull request",
  schema: z.object({ pr: z.number().int() }),
  actionClass: "merge_pr",
  risk: "medium",
  async execute(input) {
    return { content: `merged #${input.pr}` };
  },
};

type Rows = Awaited<ReturnType<StateStore["humanRequest"]["list"]>>;

interface World {
  h: Harness;
  store: StateStore;
  hooks: EnforcementHooks;
  human: string;
  agent: string;
  project: string;
  session: string;
  /**
   * A run context of this session (or of `over.sessionId`, for the task `over.taskId`);
   * `ctx.approvals` starts empty, as the drivers make it.
   */
  ctx: (
    runId: string,
    over?: {
      allowedTools?: string[];
      autonomy?: 0 | 1 | 2 | 3 | 4;
      sessionId?: string;
      taskId?: string;
    },
  ) => RunContext;
  /** A ready task of the project. */
  task: (title: string) => Promise<string>;
  /** Another session of the agent on the project, `planned` like the first. */
  newSession: () => Promise<string>;
  /** The session ended (`stopped`), as a session whose run paused on the call does. */
  end: (sessionId: string) => Promise<void>;
  openRows: () => Promise<Rows>;
  allRows: () => Promise<Rows>;
  /** Answer the one open request as the human, then let a second pass. */
  answer: (answer: string) => Promise<void>;
}

async function world(): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const hooks = new EnforcementHooks({ ...h.deps, approvals: new StateApprovals(store) });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "l",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "P",
      goal: "g",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 1,
      autonomy_level: 4,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const newSession = async () =>
    (
      await store.session.insert({
        agent_id: agent,
        project_id: project,
        trigger: "manual",
        plan: {},
        budget_cap_usd_micro: 1,
        step_cap: 10,
        spent_usd_micro: 0,
        steps: 0,
        status: "planned",
        summary: "",
        handoff: {},
        runner: "pc",
      })
    ).id;
  const session = await newSession();
  const task = async (title: string) =>
    (
      await store.task.insert({
        project_id: project,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 0,
        status: "ready",
        budget_usd_micro: 1_000_000,
        reason: "seed",
        author_agent: agent,
      })
    ).id;
  const end = async (sessionId: string) => {
    const row = await store.session.mustGet(sessionId);
    await store.session.setStatus(row.id, row.version, "stopped");
    await h.clock.advance(1_000);
  };
  const ctx: World["ctx"] = (runId, over = {}) => ({
    token: h.tokens.issue({
      runId,
      sessionId: over.sessionId ?? session,
      agentId: agent,
      ownerHumanId: human,
      projectId: project,
      ...(over.taskId ? { taskId: over.taskId } : {}),
      allowedTools: over.allowedTools ?? ["delete_repo"],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: over.autonomy ?? 4,
      planApproved: true,
      expiresAt: new Date(h.clock.now() + 3_600_000).toISOString(),
    }),
    budget: budget(session, 5_000_000, h.clock),
    signal: new AbortController().signal,
    runDeadlineMs: h.clock.now() + 600_000,
    phase: "work",
    model: "fake-haiku",
    provider: "fake",
    billingSourceId: "bs",
    approvals: new Set(),
  });
  const openRows = () => store.humanRequest.open({ humanId: human });
  const allRows = () =>
    store.humanRequest.list(
      { kind: "approval" },
      { orderBy: [{ column: "created_at" }, { column: "id" }] },
    );
  const answer = async (a: string) => {
    const [row] = await openRows();
    if (!row) throw new Error("no open request to answer");
    await store.humanRequest.answer(row.id, row.version, a, human);
    await h.clock.advance(1_000);
  };
  return {
    h,
    store,
    hooks,
    human,
    agent,
    project,
    session,
    ctx,
    task,
    newSession,
    end,
    openRows,
    allRows,
    answer,
  };
}

interface Card {
  key?: string;
  input?: { repo?: string };
  consumedAt?: string;
  consumedByRun?: string;
}

function cardOf(row: { change_card: unknown } | undefined): Card {
  return (row?.change_card ?? {}) as Card;
}

describe("durable always-human approvals (StateApprovals over the real store)", () => {
  it("an identical delete_repo in the same run asks again after the first execution", async () => {
    const w = await world();
    try {
      const ctx = w.ctx("r1");
      const input = { repo: "org/repo" };
      // 1. The first call pauses on a HumanRequest.
      const first = await w.hooks.beforeToolCall(ctx, deleteRepoTool, input);
      expect(first.allowed).toBe(false);
      expect(await w.openRows()).toHaveLength(1);
      await w.answer("yes");
      // 2. The resume re-makes the paused call once: allowed.
      const resumed = await w.hooks.beforeToolCall(ctx, deleteRepoTool, input);
      expect(resumed.allowed).toBe(true);
      await w.hooks.afterToolCall(ctx, deleteRepoTool, input, { content: "deleted" });
      // 3. The same delete again, same run: it asks (pending, a new open request).
      const again = await w.hooks.beforeToolCall(ctx, deleteRepoTool, input);
      const openAfter = await w.openRows();
      expect({ allowed: again.allowed, openRequests: openAfter.length }).toEqual({
        allowed: false,
        openRequests: 1,
      });
      const rows = await w.allRows();
      expect(rows.map((r) => r.status)).toEqual(["answered", "open"]);
      expect(rows[1]?.id).not.toBe(rows[0]?.id);
    } finally {
      await w.store.close();
    }
  });

  it("the resume path re-makes the paused call once in a later run of the session; the spent row is marked and never admits a second call", async () => {
    const w = await world();
    try {
      const input = { repo: "org/repo" };
      // Run 1 pauses; the human answers from the inbox.
      expect((await w.hooks.beforeToolCall(w.ctx("r1"), deleteRepoTool, input)).allowed).toBe(
        false,
      );
      await w.answer("yes");
      // Run 2 (the daemon's or the cloud runner's resume: a fresh run context, an empty
      // `ctx.approvals`) re-makes the call: admitted once.
      const run2 = w.ctx("r2");
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(true);
      await w.hooks.afterToolCall(run2, deleteRepoTool, input, { content: "deleted" });
      const [spent] = await w.allRows();
      expect(spent?.status).toBe("answered");
      expect(cardOf(spent)).toMatchObject({
        consumedAt: w.h.clock.nowIso(),
        consumedByRun: "r2",
      });
      // The envelope moved with the consumption: the version bumped past the answer's.
      expect(spent?.version).toBe(3);
      // The same call again in run 2, and in a run 3 after it: one new request, no duplicates.
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(false);
      expect((await w.hooks.beforeToolCall(w.ctx("r3"), deleteRepoTool, input)).allowed).toBe(
        false,
      );
      expect(await w.openRows()).toHaveLength(1);
      expect(await w.allRows()).toHaveLength(2);
      // The second answer admits exactly one more call.
      await w.answer("yes");
      const run4 = w.ctx("r4");
      expect((await w.hooks.beforeToolCall(run4, deleteRepoTool, input)).allowed).toBe(true);
      await w.hooks.afterToolCall(run4, deleteRepoTool, input, { content: "deleted" });
      expect((await w.hooks.beforeToolCall(run4, deleteRepoTool, input)).allowed).toBe(false);
      expect(await w.openRows()).toHaveLength(1);
      // Two answers, two executions on the audit log, each on the run that took the answer.
      const allowed = w.h.audit.entries.filter((e) => e.tool === "delete_repo" && e.allowed);
      expect(allowed.map((e) => e.runId)).toEqual(["r2", "r4"]);
      const [, second] = await w.allRows();
      expect(cardOf(second)).toMatchObject({ consumedByRun: "r4" });
    } finally {
      await w.store.close();
    }
  });

  // The loop hands a tool the hooks' approval key and display copy of the input, so a tool
  // that asks a human itself (the Cloudflare deployer) matches the hooks' row and never shows
  // the input it executes with (resolved secret values) on its own card.
  it("through the loop driver: the tool gets the hooks' approval key and display input in its context", async () => {
    const w = await world();
    try {
      const seen: Array<{ approvalKey?: string; approvalInput?: unknown }> = [];
      const capture: ToolSpec<{ pr: number }> = {
        ...mergeTool,
        async execute(input, ctx) {
          seen.push({ approvalKey: ctx.approvalKey, approvalInput: ctx.approvalInput });
          return { content: `merged #${input.pr}` };
        },
      };
      const driver = new LoopAgentDriver({ hooks: w.hooks, kill: w.h.kill, clock: w.h.clock });
      const result = await driver.run({
        token: w.ctx("r1", { allowedTools: ["merge_pr"] }).token,
        budget: budget(w.session, 5_000_000, w.h.clock),
        provider: new ScriptedProvider(
          [{ tools: [{ name: "merge_pr", input: { pr: 7 } }] }, { text: "done" }],
          w.h.clock,
        ),
        model: "fake-haiku",
        billingSourceId: "bs",
        system: "s",
        messages: [{ role: "user", content: "merge it" }],
        tools: new ToolRegistry().register(capture),
        pricing: flatPricing,
        timeoutMs: 60_000,
      });
      expect(result.outcome).toBe("completed");
      expect(seen).toEqual([
        { approvalKey: approvalKeyFor("merge_pr", { pr: 7 }), approvalInput: { pr: 7 } },
      ]);
    } finally {
      await w.store.close();
    }
  });

  it("through the loop driver: a run ends needs_human, the next run executes the delete once and a third identical delete pauses again", async () => {
    const w = await world();
    try {
      const tools = new ToolRegistry().register(deleteRepoTool);
      const driver = new LoopAgentDriver({ hooks: w.hooks, kill: w.h.kill, clock: w.h.clock });
      const run = (runId: string, provider: ScriptedProvider) =>
        driver.run({
          token: w.ctx(runId).token,
          budget: budget(w.session, 5_000_000, w.h.clock),
          provider,
          model: "fake-haiku",
          billingSourceId: "bs",
          system: "s",
          messages: [{ role: "user", content: "delete the repo" }],
          tools,
          pricing: flatPricing,
          timeoutMs: 60_000,
        });
      const call = { tools: [{ name: "delete_repo", input: { repo: "org/repo" } }] };
      const first = await run("r1", new ScriptedProvider([call, { text: "never" }], w.h.clock));
      expect(first.outcome).toBe("needs_human");
      expect(first.modelCalls).toBe(1);
      expect(await w.openRows()).toHaveLength(1);
      await w.answer("yes");
      // The resumed run: the model re-makes the call (admitted), then asks for the same
      // delete again (held), so the run ends needs_human with one execution on record.
      const second = await run(
        "r2",
        new ScriptedProvider([call, call, { text: "never" }], w.h.clock),
      );
      expect(second.outcome).toBe("needs_human");
      expect(second.modelCalls).toBe(2);
      const executed = w.h.audit.entries.filter((e) => e.tool === "delete_repo" && e.allowed);
      expect(executed).toHaveLength(1);
      expect(JSON.stringify(second.messages)).toContain("deleted org/repo");
      expect(JSON.stringify(second.messages)).toContain("PENDING");
      expect(await w.openRows()).toHaveLength(1);
      expect(await w.allRows()).toHaveLength(2);
    } finally {
      await w.store.close();
    }
  });

  it("two inputs that are cut alike for display get different keys and rows", async () => {
    const w = await world();
    try {
      // Both repos share their first 2000 characters, so the card shows the same text.
      const a = { repo: `org/${"a".repeat(2_400)}1` };
      const b = { repo: `org/${"a".repeat(2_400)}2` };
      const ctx = w.ctx("r1");
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, a)).allowed).toBe(false);
      const [rowA] = await w.openRows();
      expect(cardOf(rowA).key).toBe(approvalKeyFor("delete_repo", a));
      // The row carries the display copy, cut at 2000 characters, never the raw input.
      expect(cardOf(rowA).input?.repo).toHaveLength(2_001);
      expect(cardOf(rowA).input?.repo?.endsWith("…")).toBe(true);
      await w.answer("yes");
      // The answer for a admits a once...
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, a)).allowed).toBe(true);
      // ...and never b: b files its own request under its own key.
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, b)).allowed).toBe(false);
      const [rowB] = await w.openRows();
      expect(cardOf(rowB).key).toBe(approvalKeyFor("delete_repo", b));
      expect(cardOf(rowB).key).not.toBe(cardOf(rowA).key);
      expect(cardOf(rowB).input).toEqual(cardOf(rowA).input);
      // The key helper honours a key the hooks computed from the raw input.
      expect(approvalKey({ tool: "delete_repo", input: { repo: "x…" }, key: "k" })).toBe("k");
      expect(approvalKey({ tool: "delete_repo", input: a })).toBe(approvalKeyFor("delete_repo", a));
    } finally {
      await w.store.close();
    }
  });

  it("a non-always-human approval holds for the run and for the session; a different input asks", async () => {
    const w = await world();
    try {
      const over = { allowedTools: ["merge_pr"], autonomy: 2 as const };
      const run1 = w.ctx("r1", over);
      expect((await w.hooks.beforeToolCall(run1, mergeTool, { pr: 7 })).allowed).toBe(false);
      await w.answer("yes");
      expect((await w.hooks.beforeToolCall(run1, mergeTool, { pr: 7 })).allowed).toBe(true);
      await w.hooks.afterToolCall(run1, mergeTool, { pr: 7 }, { content: "merged" });
      // Same run: held in `ctx.approvals`, no new request.
      expect((await w.hooks.beforeToolCall(run1, mergeTool, { pr: 7 })).allowed).toBe(true);
      // A later run of the session: the durable row holds, no new request.
      expect((await w.hooks.beforeToolCall(w.ctx("r2", over), mergeTool, { pr: 7 })).allowed).toBe(
        true,
      );
      const rows = await w.allRows();
      expect(rows).toHaveLength(1);
      expect(cardOf(rows[0]).consumedAt).toBeUndefined();
      // Another pull request is another question.
      expect((await w.hooks.beforeToolCall(run1, mergeTool, { pr: 8 })).allowed).toBe(false);
      expect(await w.openRows()).toHaveLength(1);
    } finally {
      await w.store.close();
    }
  });

  it("a no denies the always-human call for the session without a new request", async () => {
    const w = await world();
    try {
      const input = { repo: "org/repo" };
      expect((await w.hooks.beforeToolCall(w.ctx("r1"), deleteRepoTool, input)).allowed).toBe(
        false,
      );
      await w.answer("no");
      for (const runId of ["r2", "r3"]) {
        await expect(
          w.hooks.beforeToolCall(w.ctx(runId), deleteRepoTool, input),
        ).rejects.toMatchObject({ code: "approval_required" });
      }
      expect(await w.allRows()).toHaveLength(1);
    } finally {
      await w.store.close();
    }
  });

  it("a withdrawn or expired request no longer holds the key: the next call files a new one", async () => {
    const w = await world();
    try {
      const input = { repo: "org/repo" };
      const ctx = w.ctx("r1");
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, input)).allowed).toBe(false);
      const [open] = await w.openRows();
      if (!open) throw new Error("no open request");
      await w.store.humanRequest.withdraw(open.id, open.version);
      await w.h.clock.advance(1_000);
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, input)).allowed).toBe(false);
      expect(await w.openRows()).toHaveLength(1);
      const [reopened] = await w.openRows();
      if (!reopened) throw new Error("no open request");
      await w.store.humanRequest.expire(reopened.id, reopened.version);
      await w.h.clock.advance(1_000);
      expect((await w.hooks.beforeToolCall(ctx, deleteRepoTool, input)).allowed).toBe(false);
      expect((await w.allRows()).map((r) => r.status)).toEqual(["withdrawn", "expired", "open"]);
    } finally {
      await w.store.close();
    }
  });
});

/**
 * A hooks approval answered after its session ended (ADR 0088; the open finding of the
 * w5-review-findings review): the port matches the row by the task and the key across the
 * agent's sessions, so the next session of the task consumes the late "yes" exactly once for
 * the one matching call. Another input, another task, another agent's row or another human's
 * row never matches; an open question of an ended session keeps the re-made call pending
 * without a second row; a late "no" denies the call for the task.
 */
describe("a hooks approval answered after its session ended (ADR 0088)", () => {
  it("a late yes is found by task and key and consumed once by the next session's one matching call", async () => {
    const w = await world();
    try {
      const task = await w.task("Clean up");
      const input = { repo: "org/repo" };
      // Session 1 pauses on the call and ends; the human answers from the inbox later.
      expect(
        (await w.hooks.beforeToolCall(w.ctx("r1", { taskId: task }), deleteRepoTool, input))
          .allowed,
      ).toBe(false);
      await w.end(w.session);
      await w.answer("yes");
      // Session 2 of the same task re-makes the call: admitted once, the row spent.
      const s2 = await w.newSession();
      const run2 = w.ctx("r2", { sessionId: s2, taskId: task });
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(true);
      await w.hooks.afterToolCall(run2, deleteRepoTool, input, { content: "deleted" });
      const [spent] = await w.allRows();
      expect(spent).toMatchObject({ status: "answered", session_id: w.session, task_id: task });
      expect(cardOf(spent)).toMatchObject({ consumedAt: w.h.clock.nowIso(), consumedByRun: "r2" });
      // The same call again in session 2: a new question, filed under session 2 and the task.
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(false);
      const open = await w.openRows();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ session_id: s2, task_id: task });
      expect(open[0]?.id).not.toBe(spent?.id);
      const executed = w.h.audit.entries.filter((e) => e.tool === "delete_repo" && e.allowed);
      expect(executed.map((e) => e.runId)).toEqual(["r2"]);
    } finally {
      await w.store.close();
    }
  });

  it("a different input, another task, another agent's row or another human's row never matches", async () => {
    const w = await world();
    try {
      const task = await w.task("Clean up");
      const other = await w.task("Other");
      const input = { repo: "org/repo" };
      const key = approvalKeyFor("delete_repo", input);
      const otherHuman = (
        await w.store.human.insert({
          name: "K",
          email: "k@x.test",
          timezone: "Europe/Zurich",
          notify_prefs: {},
          default_autonomy: 2,
          monthly_cap_usd_micro: 1,
          locale: "en",
        })
      ).id;
      const otherAgent = (
        await w.store.agent.insert({
          name: "Bob",
          owner_human_id: otherHuman,
          model_config: {},
          memory_location: "l",
          status: "active",
          kind: "principal",
        })
      ).id;
      // Two answered "yes" rows for the task and the key that are not this agent's for this
      // human: one filed by another agent, one addressed to another human.
      for (const [agent, human] of [
        [otherAgent, w.human],
        [w.agent, otherHuman],
      ] as const) {
        const row = await w.store.humanRequest.insert({
          human_id: human,
          project_id: w.project,
          task_id: task,
          session_id: w.session,
          kind: "approval",
          why: "autonomy level 4 requires approval for destructive",
          steps: ["Tool: delete_repo", "Action class: destructive"],
          options: ["yes", "no"],
          blocking: true,
          risk: "high",
          change_card: { key, tool: "delete_repo", actionClass: "destructive", input },
          author_agent: agent,
        });
        await w.store.humanRequest.answer(row.id, row.version, "yes", human);
      }
      await w.end(w.session);
      const s2 = await w.newSession();
      // Neither admits this agent's call for this human: a new question is filed.
      const run2 = w.ctx("r2", { sessionId: s2, taskId: task });
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(false);
      expect(await w.openRows()).toHaveLength(1);
      const rows = await w.allRows();
      expect(rows.filter((r) => r.status === "answered").map((r) => cardOf(r).consumedAt)).toEqual([
        undefined,
        undefined,
      ]);
      // The human answers the agent's own question; session 2 ends before it is used. Each
      // probe below runs in a session of its own: within one session the key alone names the
      // call (ADR 0052), which is not what is under test here.
      await w.answer("yes");
      await w.end(s2);
      // Another input of the same tool: its own key, a new question.
      const s3 = await w.newSession();
      expect(
        (
          await w.hooks.beforeToolCall(
            w.ctx("r3", { sessionId: s3, taskId: task }),
            deleteRepoTool,
            {
              repo: "org/other",
            },
          )
        ).allowed,
      ).toBe(false);
      // The same input for another task: a new question.
      const s4 = await w.newSession();
      expect(
        (
          await w.hooks.beforeToolCall(
            w.ctx("r4", { sessionId: s4, taskId: other }),
            deleteRepoTool,
            input,
          )
        ).allowed,
      ).toBe(false);
      // A run that names no task sees only its own session's rows: it files a new question
      // although the task's answer is on file.
      const s5 = await w.newSession();
      expect(
        (await w.hooks.beforeToolCall(w.ctx("r5", { sessionId: s5 }), deleteRepoTool, input))
          .allowed,
      ).toBe(false);
      expect(await w.openRows()).toHaveLength(3);
      // The one matching call takes it.
      const s6 = await w.newSession();
      expect(
        (
          await w.hooks.beforeToolCall(
            w.ctx("r6", { sessionId: s6, taskId: task }),
            deleteRepoTool,
            input,
          )
        ).allowed,
      ).toBe(true);
      const own = (await w.allRows()).find(
        (r) => r.author_agent === w.agent && r.human_id === w.human && r.status === "answered",
      );
      expect(cardOf(own)).toMatchObject({ consumedByRun: "r6" });
      expect(await w.openRows()).toHaveLength(3);
    } finally {
      await w.store.close();
    }
  });

  it("an open question of an ended session keeps the re-made call pending without a second row", async () => {
    const w = await world();
    try {
      const task = await w.task("Clean up");
      const input = { repo: "org/repo" };
      expect(
        (await w.hooks.beforeToolCall(w.ctx("r1", { taskId: task }), deleteRepoTool, input))
          .allowed,
      ).toBe(false);
      await w.end(w.session);
      const s2 = await w.newSession();
      const run2 = w.ctx("r2", { sessionId: s2, taskId: task });
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(false);
      expect(await w.allRows()).toHaveLength(1);
      await w.answer("yes");
      expect((await w.hooks.beforeToolCall(run2, deleteRepoTool, input)).allowed).toBe(true);
      expect(await w.allRows()).toHaveLength(1);
    } finally {
      await w.store.close();
    }
  });

  it("a late no denies the call for the task in the next session without a new request", async () => {
    const w = await world();
    try {
      const task = await w.task("Clean up");
      const input = { repo: "org/repo" };
      expect(
        (await w.hooks.beforeToolCall(w.ctx("r1", { taskId: task }), deleteRepoTool, input))
          .allowed,
      ).toBe(false);
      await w.end(w.session);
      await w.answer("no");
      const s2 = await w.newSession();
      await expect(
        w.hooks.beforeToolCall(w.ctx("r2", { sessionId: s2, taskId: task }), deleteRepoTool, input),
      ).rejects.toMatchObject({ code: "approval_required" });
      expect(await w.allRows()).toHaveLength(1);
    } finally {
      await w.store.close();
    }
  });

  it("a late yes to a class that is not always-human holds for the task's later sessions", async () => {
    const w = await world();
    try {
      const task = await w.task("Merge");
      const over = { allowedTools: ["merge_pr"], autonomy: 2 as const, taskId: task };
      expect((await w.hooks.beforeToolCall(w.ctx("r1", over), mergeTool, { pr: 7 })).allowed).toBe(
        false,
      );
      await w.end(w.session);
      await w.answer("yes");
      const s2 = await w.newSession();
      const run2 = w.ctx("r2", { ...over, sessionId: s2 });
      expect((await w.hooks.beforeToolCall(run2, mergeTool, { pr: 7 })).allowed).toBe(true);
      expect((await w.hooks.beforeToolCall(run2, mergeTool, { pr: 7 })).allowed).toBe(true);
      const rows = await w.allRows();
      expect(rows).toHaveLength(1);
      expect(cardOf(rows[0]).consumedAt).toBeUndefined();
    } finally {
      await w.store.close();
    }
  });
});
