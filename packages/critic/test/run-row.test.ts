import { ForerunnerError, Logger, type LogRecord } from "@forerunner/platform";
import { RUN_PERSIST_FAILED_AUDIT_TOOL } from "@forerunner/runtime";
import { describe, expect, it, vi } from "vitest";
import type { ReviewInput } from "../src/types.ts";
import { baseEvidence, CRITIC_PROMPT, closingReply, submitReply, until, world } from "./helpers.ts";

const input = (taskId: string): ReviewInput => ({
  subject: { kind: "task", taskId },
  tier: 1,
  evidence: baseEvidence(),
});

describe("CriticService: the critic's Run row (D.5, D.19)", () => {
  // The first live run (ADR 0040) lost every critic Run row: the driver's ttft came from
  // performance.now() with a fraction, the store refused the INTEGER column and the failure
  // was only a warning. Whole milliseconds, on the real store, no mock.
  it("persists a review whose first-token time (12.345 ms) and duration (987.65 ms) are fractional, as integers with the outcome and the cost", async () => {
    const w = await world({
      latency: "simulated",
      replies: [submitReply({}, { ttftMs: 12.345, totalMs: 987.65 }), closingReply()],
    });
    try {
      const p = w.critic.review(input(w.ids.task), w.ctx());
      await until(() => w.provider.calls.length >= 1, "the review call");
      await w.clock.advance(5_000);
      const out = await p;
      expect(out.outcome).toBe("completed");
      expect(out.verdict).toBe("accept");
      expect(out.costUsdMicro).toBeGreaterThan(0);
      const runs = await w.store.run.forTask(w.ids.task);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: out.runId,
        specialist: "critic",
        outcome: "completed",
        ttft_ms: 12,
        cost_usd_micro: out.costUsdMicro,
        timed_out: false,
      });
      expect(Number.isInteger(runs[0]?.duration_ms)).toBe(true);
      expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(988);
      expect(await w.store.auditLog.list({ tool: RUN_PERSIST_FAILED_AUDIT_TOOL })).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("keeps the review when its Run row cannot be written, and leaves an audit row and a log line that name the run and never the prompt or the evidence", async () => {
    const w = await world({ replies: [submitReply(), closingReply()] });
    const records: LogRecord[] = [];
    const off = Logger.addSink((r) => records.push(r));
    try {
      vi.spyOn(w.store.run, "insert").mockRejectedValueOnce(
        new ForerunnerError("internal", "disk full"),
      );
      const out = await w.critic.review(input(w.ids.task), w.ctx());
      // The verdict and its rows are written as usual.
      expect(out.outcome).toBe("completed");
      expect(out.verdict).toBe("accept");
      expect(out.reviewId).toBeDefined();
      expect(await w.store.review.forTask(w.ids.task)).toHaveLength(1);
      expect(await w.store.run.forTask(w.ids.task)).toEqual([]);
      // The failure is an audit row with the ids, the run and the store's message.
      const rows = await w.store.auditLog.list({ runId: out.runId });
      const row = rows.find((r) => r.tool === RUN_PERSIST_FAILED_AUDIT_TOOL);
      expect(row).toMatchObject({
        allowed: false,
        session_id: w.ids.session,
        agent_id: w.ids.critic,
        human_id: w.ids.human,
        cost_usd_micro: 0,
      });
      expect(row?.denied_reason).toContain("disk full");
      expect(JSON.parse(row?.input_summary ?? "{}")).toEqual({
        runId: out.runId,
        specialist: "critic",
        tier: 1,
      });
      // Never the prompt or the evidence.
      const text = JSON.stringify(rows);
      expect(text).not.toContain(CRITIC_PROMPT.prompt.trim().slice(0, 40));
      expect(text).not.toContain("export function clamp");
      // And a line through the runtime logger, with the same discipline.
      const logged = records.find(
        (r) => r.level === "error" && r.msg === "critic run row not persisted",
      );
      expect(logged?.data).toMatchObject({ runId: out.runId });
      expect(logged?.data?.error).toContain("disk full");
      const log = JSON.stringify(records);
      expect(log).not.toContain(CRITIC_PROMPT.prompt.trim().slice(0, 40));
      expect(log).not.toContain("export function clamp");
    } finally {
      off();
      await w.close();
    }
  });
});
