import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import { StateApprovals } from "../src/wiring/state-ports.ts";
import { budget, deleteRepoTool, harness } from "./helpers.ts";

/**
 * Critic scratch: the always-human consumption was fixed in `ctx.approvals`, but the daemon's
 * approval port is `StateApprovals`, which answers from the durable HumanRequest row. Does an
 * identical always-human call in the SAME run ask again after the first execution?
 */
describe("critic scratch: always-human approval through StateApprovals", () => {
  // Open finding of the security review (PROGRESS.md "Where to pick up": the durable StateApprovals row is not consumed); expected to fail until it is fixed.
  it.fails("an identical delete_repo in the same run asks again after the first execution", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    try {
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
      const alice = (
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
      const sess = await store.session.insert({
        agent_id: alice,
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
      });
      const token = h.tokens.issue({
        runId: "r1",
        sessionId: sess.id,
        agentId: alice,
        ownerHumanId: human,
        projectId: project,
        allowedTools: ["delete_repo"],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy: 4,
        planApproved: true,
        expiresAt: new Date(h.clock.now() + 3_600_000).toISOString(),
      });
      const ctx: RunContext = {
        token,
        budget: budget(sess.id, 5_000_000, h.clock),
        signal: new AbortController().signal,
        runDeadlineMs: h.clock.now() + 600_000,
        phase: "work",
        model: "fake-haiku",
        provider: "fake",
        billingSourceId: "bs",
        approvals: new Set(),
      };
      const input = { repo: "org/repo" };
      // 1. The first call pauses on a HumanRequest.
      const first = await hooks.beforeToolCall(ctx, deleteRepoTool, input);
      expect(first.allowed).toBe(false);
      const open = await store.humanRequest.open({ humanId: human });
      expect(open).toHaveLength(1);
      await store.humanRequest.answer(open[0]!.id, open[0]!.version, "yes", human);
      // 2. The resume re-makes the paused call once: allowed.
      const resumed = await hooks.beforeToolCall(ctx, deleteRepoTool, input);
      expect(resumed.allowed).toBe(true);
      await hooks.afterToolCall(ctx, deleteRepoTool, input, { content: "deleted" });
      // 3. The same delete again, same run: it should ask (pending, a new open request).
      const again = await hooks.beforeToolCall(ctx, deleteRepoTool, input);
      const openAfter = await store.humanRequest.open({ humanId: human });
      expect({ allowed: again.allowed, openRequests: openAfter.length }).toEqual({
        allowed: false,
        openRequests: 1,
      });
    } finally {
      await store.close();
    }
  });
});
