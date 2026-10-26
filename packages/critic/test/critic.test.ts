import { BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import {
  ContextPipeline,
  type RunEvent,
  type RunPricing,
  type SignedToken,
} from "@forerunner/runtime";
import { type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_EFFORT_TOKENS_CEILING,
  REVIEW_TOKENS_PER_CALL,
  VERDICT_ADJUSTED_AUDIT_TOOL,
} from "../src/critic.ts";
import { SIGNOFF_KEY } from "../src/followup.ts";
import { DEFAULT_DEEP_REVIEW_TIMEOUT_MS } from "../src/model.ts";
import { ESCALATE_RULE } from "../src/rules.ts";
import { SUBMIT_REVIEW_TOOL } from "../src/schema.ts";
import type { CheckCommand, CheckRunner } from "../src/tier0.ts";
import type { ReviewEvidence, ReviewInput } from "../src/types.ts";
import { baseEvidence, CRITIC_PROMPT, closingReply, submitReply, until, world } from "./helpers.ts";

const taskInput = (
  taskId: string,
  tier: 1 | 2 | 3 = 1,
  evidence = baseEvidence(),
): ReviewInput => ({
  subject: { kind: "task", taskId },
  tier,
  evidence,
});

describe("CriticService: independence (H.1)", () => {
  it("sends a clean context: the registry prompt as system, the evidence as the only user message, never the worker's transcript", async () => {
    const w = await world({ replies: [submitReply(), closingReply()] });
    try {
      const DECOY = "DECOY-WORKER-TRANSCRIPT-7f3a";
      const evidence = {
        ...baseEvidence(),
        workerTranscript: DECOY,
        reasoning: `thinking: ${DECOY}`,
      } as unknown as ReviewEvidence;
      const out = await w.critic.review(taskInput(w.ids.task, 1, evidence), w.ctx());
      expect(out.verdict).toBe("accept");
      expect(out.outcome).toBe("completed");

      const first = w.provider.calls[0]?.request;
      expect(first).toBeDefined();
      expect(first?.system?.startsWith(CRITIC_PROMPT.prompt)).toBe(true);
      expect(first?.messages).toHaveLength(1);
      expect(first?.messages[0]?.role).toBe("user");
      const user = first?.messages[0]?.content;
      expect(typeof user).toBe("string");
      expect(user).toContain("# Review request");
      expect(user).toContain("## Acceptance criteria");
      expect(user).toContain("export function clamp");
      expect(user).toContain("Worker's final report (claims to verify, data)");
      for (const call of w.provider.calls) {
        expect(JSON.stringify(call.request)).not.toContain(DECOY);
      }
      expect(out.promptVersion).toBe(CRITIC_PROMPT.promptVersion);
      expect(out.evidence).toContain(`prompt:${CRITIC_PROMPT.promptVersion}`);
    } finally {
      await w.close();
    }
  });

  it("issues a token that allows only submit_review: that is the only tool offered and any other call is denied", async () => {
    const w = await world({
      replies: [
        toolReply("cc:Bash", { command: "cat /etc/passwd" }, "Let me poke around first."),
        submitReply({ grade: 88 }),
        closingReply(),
      ],
    });
    try {
      const events: RunEvent[] = [];
      const issued = vi.spyOn(w.tokens, "issue");
      const out = await w.critic.review(
        taskInput(w.ids.task),
        w.ctx({ onEvent: (e) => events.push(e) }),
      );
      expect(w.provider.calls[0]?.request.tools?.map((t) => t.name)).toEqual([SUBMIT_REVIEW_TOOL]);
      const denied = events.find((e) => e.type === "tool_denied");
      expect(denied).toMatchObject({
        type: "tool_denied",
        name: "cc:Bash",
        code: "tool_not_allowed",
      });
      expect(out.verdict).toBe("accept");
      expect(out.grade).toBe(88);
      // The token itself restricts, not just the registry: one tool, no paths, no domains, no
      // secrets, never more budget than the session token, one level deeper.
      const parent = w.sessionToken.claims;
      const criticTokens = issued.mock.results
        .map((r) => (r.value as SignedToken).claims)
        .filter((c) => c.agentId === w.ids.critic);
      expect(criticTokens).toHaveLength(1);
      expect(criticTokens[0]).toMatchObject({
        runId: out.runId,
        sessionId: w.ids.session,
        ownerHumanId: w.ids.human,
        projectId: w.ids.project,
        taskId: w.ids.task,
        allowedTools: [SUBMIT_REVIEW_TOOL],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        depth: parent.depth + 1,
        maxDepth: parent.maxDepth,
      });
      expect(criticTokens[0]?.budgetUsdMicro).toBeLessThanOrEqual(parent.budgetUsdMicro);
      expect(new Date(criticTokens[0]?.expiresAt as string).getTime()).toBeLessThanOrEqual(
        new Date(parent.expiresAt).getTime(),
      );
      const start = events.find((e) => e.type === "run_start");
      expect(start).toMatchObject({ type: "run_start", runId: out.runId });
      // The critic ran as its own agent, at depth 1, on the session's budget.
      expect(
        w.ledger.entries.every((e) => e.agentId === w.ids.critic && e.sessionId === w.ids.session),
      ).toBe(true);
      expect(w.ledger.entries.length).toBeGreaterThan(0);
    } finally {
      await w.close();
    }
  });

  it("bypasses context compression for the evidence: every block is recorded uncompressed", async () => {
    const pipeline = new ContextPipeline();
    const noisy = `${"same line of log\n".repeat(400)}ERROR real\n`;
    const w = await world({
      replies: [submitReply(), closingReply()],
      deps: { context: pipeline },
    });
    try {
      const run = vi.spyOn(w.driver, "run");
      const out = await w.critic.review(
        taskInput(w.ids.task, 1, baseEvidence({ testOutput: noisy, diff: noisy })),
        w.ctx(),
      );
      expect(pipeline.records.length).toBeGreaterThanOrEqual(2);
      for (const r of pipeline.records) {
        expect(r.transforms).toEqual([]);
        expect(r.tokensAfter).toBe(r.tokensBefore);
      }
      expect(out.evidence.some((e) => e.includes("sent uncompressed"))).toBe(true);
      const user = w.provider.calls[0]?.request.messages[0]?.content as string;
      expect(user).toContain("ERROR real");
      // ADR 0003: the critic sets compression "off" on its run and uses the session pipeline,
      // so the loop's own tool-result compression is bypassed too, not only the evidence.
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ compression: "off", phase: "review" });
      expect(run.mock.calls[0]?.[0]?.context).toBe(pipeline);
      const run0 = (await w.store.run.forTask(w.ids.task))[0];
      expect(run0?.tokens_before_compression).toBe(run0?.tokens_after_compression);
    } finally {
      await w.close();
    }
  });
});

describe("CriticService: checks run at tier 2+ (H.2)", () => {
  const unit: CheckCommand = { name: "unit", argv: ["pnpm", "test"] };

  it("tier 2 runs the task's check commands in the worktree before the model reads; a failed check is a finding", async () => {
    const seen: { cmd: CheckCommand; cwd?: string }[] = [];
    const checkRunner: CheckRunner = {
      async run(cmd, o) {
        seen.push({ cmd, cwd: o.cwd });
        return { name: cmd.name, passed: false, output: "1 failing\n  clamp > upper bound" };
      },
    };
    const w = await world({
      replies: [submitReply({ grade: 95 }), closingReply()],
      deps: { checkRunner },
    });
    try {
      const out = await w.critic.review(
        taskInput(w.ids.task, 2, baseEvidence({ checkResults: [] })),
        w.ctx({ checks: [unit], cwd: "/work/tree" }),
      );
      expect(seen).toEqual([{ cmd: unit, cwd: "/work/tree" }]);
      // The model saw the result the critic ran, as data.
      const user = w.provider.calls[0]?.request.messages[0]?.content as string;
      expect(user).toContain("## Check results");
      expect(user).toContain("[FAIL] unit");
      expect(user).toContain("1 failing");
      expect(out.verdict).toBe("revise");
      expect(out.findings).toContainEqual(
        expect.objectContaining({ severity: "high", description: "Check failed: unit" }),
      );
      expect(out.evidence).toContain("ran: unit -> fail (1 failing)");
    } finally {
      await w.close();
    }
  });

  it("tier 1 is a light read: commands are not run and the evidence says so", async () => {
    const checkRunner: CheckRunner = {
      async run() {
        throw new Error("tier 1 must not run commands");
      },
    };
    const w = await world({
      replies: [submitReply(), closingReply()],
      deps: { checkRunner },
    });
    try {
      const out = await w.critic.review(
        taskInput(w.ids.task, 1),
        w.ctx({ checks: [unit], cwd: "/work/tree" }),
      );
      expect(out.verdict).toBe("accept");
      expect(out.evidence).toContain(
        "checks: 1 command(s) not run at tier 1 (light read); pass checkResults or review at tier 2",
      );
    } finally {
      await w.close();
    }
  });
});

describe("CriticService: rules in code", () => {
  it("medium confidence accepts a clean result (ADR 0042); the stored confidence sits above the H.4 line", async () => {
    const w = await world({
      replies: [submitReply({ confidence: "medium", grade: 95 }), closingReply()],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("accept");
      expect(out.confidence).toBeGreaterThanOrEqual(0.6);
      expect(out.adjustments).toEqual([]);
      const review = await w.store.review.latestForTask(w.ids.task);
      expect(review?.verdict).toBe("accept");
      expect(await w.store.auditLog.list({ tool: VERDICT_ADJUSTED_AUDIT_TOOL })).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("an escalate with no named ground on clean work becomes accept, with a critic.verdict_adjusted audit row and the adjustment on the event", async () => {
    const w = await world({
      replies: [
        submitReply({
          confidence: "medium",
          grade: 86,
          verdict: "escalate",
          summary: "Correct against all five criteria by reading; I did not run the tests myself.",
        }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("accept");
      expect(out.findings).toEqual([]);
      expect(out.adjustments).toEqual([
        expect.objectContaining({ rule: ESCALATE_RULE, from: "escalate", to: "accept" }),
      ]);
      expect(out.adjustments[0]?.reason).toContain("no escalation reason was given");
      expect(out.evidence.some((l) => l.startsWith("escalate not qualified:"))).toBe(true);
      const review = await w.store.review.latestForTask(w.ids.task);
      expect(review?.verdict).toBe("accept");
      expect(await w.store.finding.openFor(w.ids.task)).toEqual([]);
      const audit = await w.store.auditLog.list({ tool: VERDICT_ADJUSTED_AUDIT_TOOL });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        session_id: w.ids.session,
        run_id: out.runId,
        agent_id: w.ids.critic,
        human_id: w.ids.human,
        allowed: true,
        result_summary: "verdict accept (model said escalate)",
      });
      const summary = JSON.parse(audit[0]?.input_summary ?? "{}") as {
        reviewId: string;
        adjustments: { rule: string; from: string; to: string }[];
      };
      expect(summary.reviewId).toBe(review?.id);
      expect(summary.adjustments).toEqual([
        expect.objectContaining({ rule: ESCALATE_RULE, from: "escalate", to: "accept" }),
      ]);
      // The evidence never enters the audit row.
      expect(audit[0]?.input_summary).not.toContain("export function clamp");
      const events = await w.store.event.list(w.ids.session);
      const ev = events.find((e) => e.type === "critic.review");
      expect(ev?.payload).toMatchObject({
        verdict: "accept",
        adjustments: [{ rule: ESCALATE_RULE, from: "escalate", to: "accept" }],
      });
    } finally {
      await w.close();
    }
  });

  it("an escalate that names an item the evidence lists as unavailable stands; one that names present material does not", async () => {
    const w = await world({
      replies: [
        submitReply(
          {
            confidence: "medium",
            grade: 80,
            verdict: "escalate",
            escalation: { reason: "evidence_missing", detail: "the test output" },
          },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        submitReply(
          {
            confidence: "medium",
            grade: 80,
            verdict: "escalate",
            escalation: { reason: "evidence_missing", detail: "the fixture text" },
          },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        closingReply(),
      ],
    });
    try {
      const listed = await w.critic.review(
        taskInput(
          w.ids.task,
          1,
          baseEvidence({
            testOutput: undefined,
            unavailable: [{ name: "test output", reason: "the runner's log was rotated" }],
          }),
        ),
        w.ctx(),
      );
      expect(listed.verdict).toBe("escalate");
      expect(listed.adjustments).toEqual([]);
      expect(listed.evidence).toContain("escalate: evidence not available: test output");
      const sent = String(w.provider.calls[0]?.request.messages[0]?.content);
      expect(sent).toContain(
        "## Evidence not available\n- test output: the runner's log was rotated",
      );

      const task2 = await w.newTask();
      const complete = await w.critic.review(taskInput(task2.id), w.ctx());
      expect(complete.verdict).toBe("accept");
      expect(complete.adjustments.map((a) => a.rule)).toEqual([ESCALATE_RULE]);
      expect(complete.adjustments[0]?.reason).toContain('"the fixture text" as missing');
      expect(complete.adjustments[0]?.reason).toContain("the evidence is complete");
    } finally {
      await w.close();
    }
  });

  it("a blocker finding cannot accept: it is stored as critical and the task keeps an open finding", async () => {
    const w = await world({
      replies: [
        submitReply({
          verdict: "accept",
          findings: [
            { severity: "blocker", what: "The test file was deleted", where: "test/math.test.ts" },
          ],
        }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("revise");
      expect(out.findings[0]).toMatchObject({
        severity: "critical",
        description: "The test file was deleted",
      });
      expect(out.adjustments[0]?.rule).toBe("blocking_finding");
      const open = await w.store.finding.openFor(w.ids.task);
      expect(open).toHaveLength(1);
      expect(open[0]?.fingerprint).toBe(out.findings[0]?.fingerprint);
      await expect(
        w.store.task.transition(
          w.ids.task,
          (await w.store.task.mustGet(w.ids.task)).version,
          "done",
          "try",
        ),
      ).rejects.toMatchObject({ code: "findings_open" });
    } finally {
      await w.close();
    }
  });

  it("grade and verdict must agree: accept at grade 60 becomes revise", async () => {
    const w = await world({ replies: [submitReply({ grade: 60 }), closingReply()] });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("revise");
      expect(out.grade).toBe(60);
      expect(out.adjustments[0]?.rule).toBe("grade_verdict_consistency");
      // A revise with no named finding still leaves something to act on.
      expect(out.findings).toHaveLength(1);
      expect((await w.store.finding.openFor(w.ids.task)).length).toBe(1);
    } finally {
      await w.close();
    }
  });

  it("tier 3 ends in a human verdict with a blocking sign-off request that carries the summary", async () => {
    const w = await world({
      replies: [submitReply({ grade: 97, summary: "Flawless migration." }), closingReply()],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task, 3), w.ctx());
      expect(out.verdict).toBe("human");
      expect(out.model).toBe("fake-opus");
      expect(out.adjustments.at(-1)?.rule).toBe("tier3_human_signoff");
      expect(out.humanRequestId).toBeDefined();
      const req = await w.store.humanRequest.mustGet(out.humanRequestId as string);
      expect(req).toMatchObject({
        kind: "approval",
        blocking: true,
        status: "open",
        human_id: w.ids.human,
        task_id: w.ids.task,
        project_id: w.ids.project,
      });
      expect(req.why).toContain("Flawless migration.");
      expect(req.why).toContain("tier 3");
      expect(req.options).toEqual(["accept", "revise", "cancel"]);
      // The card the runtime's sign-off sync applies the answer through (RT-P5-1).
      expect(req.change_card).toEqual({
        key: SIGNOFF_KEY,
        task_id: w.ids.task,
        review_id: out.reviewId,
        run_id: null,
        finding_ids: [],
        reason: "verdict",
        applied_at: null,
      });
      const run = (await w.store.run.forTask(w.ids.task))[0];
      expect(run).toMatchObject({
        specialist: "critic",
        model: "fake-opus",
        effort: "max",
        prompt_version: CRITIC_PROMPT.promptVersion,
      });
      // A clean tier 3 result names nothing wrong: no finding is invented for the sign-off, so
      // nothing blocks the close once the human accepts (B.4), and the request has no steps.
      expect(out.grade).toBe(97);
      expect(out.findings).toEqual([]);
      expect(out.findingIds).toEqual([]);
      expect(await w.store.finding.openFor(w.ids.task)).toEqual([]);
      expect(req.steps).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("a clean review at low confidence escalates without inventing a finding", async () => {
    const w = await world({
      replies: [
        submitReply({ confidence: "low", grade: 95, summary: "Looks fine." }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("escalate");
      expect(out.adjustments.map((a) => a.rule)).toEqual(["low_confidence"]);
      expect(out.findings).toEqual([]);
      expect(await w.store.finding.openFor(w.ids.task)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("a revise or escalate from the model with no named finding still leaves one thing to act on", async () => {
    const w = await world({
      replies: [
        submitReply(
          { verdict: "escalate", grade: 40, summary: "Wrong approach entirely." },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        submitReply(
          { verdict: "revise", grade: 60, summary: "Needs another pass." },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        closingReply(),
      ],
    });
    try {
      // An escalate with no finding and no ground is the verdict the findings and the grade
      // justify: revise (grade 40 cannot accept), with the summary as the thing to act on.
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("revise");
      expect(out.adjustments.map((a) => a.rule)).toEqual([
        ESCALATE_RULE,
        "grade_verdict_consistency",
      ]);
      expect(out.findings).toEqual([
        expect.objectContaining({ severity: "medium", description: "Wrong approach entirely." }),
      ]);
      expect(await w.store.finding.openFor(w.ids.task)).toHaveLength(1);
      const task2 = await w.newTask();
      const revise = await w.critic.review(taskInput(task2.id), w.ctx());
      expect(revise.verdict).toBe("revise");
      expect(revise.adjustments).toEqual([]);
      expect(revise.findings).toEqual([
        expect.objectContaining({ severity: "medium", description: "Needs another pass." }),
      ]);
    } finally {
      await w.close();
    }
  });

  it("an escalate on a major finding stands, and so does one at low confidence (H.4), each with its ground in the evidence", async () => {
    const w = await world({
      replies: [
        submitReply(
          {
            verdict: "escalate",
            grade: 50,
            confidence: "high",
            findings: [{ severity: "major", what: "The migration is incomplete" }],
          },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        submitReply(
          { verdict: "escalate", grade: 90, confidence: "low", summary: "Unsure." },
          { when: { lastUserIncludes: "# Review request" } },
        ),
        closingReply(),
      ],
    });
    try {
      const major = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(major.verdict).toBe("escalate");
      expect(major.adjustments).toEqual([]);
      expect(major.evidence).toContain("escalate: a high finding is open");
      const task2 = await w.newTask();
      const low = await w.critic.review(taskInput(task2.id), w.ctx());
      expect(low.verdict).toBe("escalate");
      expect(low.adjustments).toEqual([]);
      expect(low.findings).toEqual([]);
      expect(low.evidence.some((l) => l.startsWith("escalate: confidence 0.20 is below"))).toBe(
        true,
      );
    } finally {
      await w.close();
    }
  });

  it("a failed required check blocks accept at tier 1 whatever the model said (B.4)", async () => {
    const w = await world({ replies: [submitReply({ grade: 96 }), closingReply()] });
    try {
      const out = await w.critic.review(
        taskInput(
          w.ids.task,
          1,
          baseEvidence({
            checkResults: [{ name: "pnpm test", passed: false, output: "2 failing" }],
          }),
        ),
        w.ctx(),
      );
      expect(out.verdict).toBe("revise");
      expect(out.findings).toContainEqual(
        expect.objectContaining({
          severity: "high",
          description: "Check failed: pnpm test",
          where: "2 failing",
        }),
      );
    } finally {
      await w.close();
    }
  });

  it("an unmet acceptance criterion becomes a high finding", async () => {
    const w = await world({
      replies: [
        submitReply({
          criteria: [
            { text: "src/math.ts exports clamp", met: true, evidence: "diff line 3" },
            { text: "tests pass", met: false, evidence: "no test output for clamp" },
          ],
        }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.verdict).toBe("revise");
      expect(out.findings[0]).toMatchObject({
        severity: "high",
        description: "Acceptance criterion not met: tests pass",
      });
      expect(out.evidence).toContain("[met] src/math.ts exports clamp — diff line 3");
    } finally {
      await w.close();
    }
  });

  it("no structured verdict is a conservative escalate with a 'did not complete' finding", async () => {
    const w = await world({ replies: [textReply("I would rather not say.")] });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.outcome).toBe("no_verdict");
      expect(out.verdict).toBe("escalate");
      expect(out.grade).toBe(0);
      expect(out.findings[0]?.description).toContain("did not complete");
      expect(out.summary).toContain("no structured verdict");
    } finally {
      await w.close();
    }
  });

  it("rejects an invalid tier or subject before touching a model", async () => {
    const w = await world();
    try {
      await expect(
        w.critic.review({ ...taskInput(w.ids.task), tier: 4 as unknown as 1 }, w.ctx()),
      ).rejects.toBeInstanceOf(ForerunnerError);
      expect(w.provider.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });
});

describe("CriticService: doc drift at tier 2+ (P.14)", () => {
  const drifting = () =>
    baseEvidence({
      changedFiles: ["packages/critic/src/rules.ts"],
      moduleFilesTouched: ["packages/critic/src/rules.ts"],
      docsTouched: [],
    });

  it("adds a medium finding when a module changed without its maintainer doc; tier 1 does not check", async () => {
    const w = await world({
      replies: [submitReply(), closingReply(), submitReply(), closingReply()],
    });
    try {
      const t2 = await w.critic.review(taskInput(w.ids.task, 2, drifting()), w.ctx());
      expect(t2.verdict).toBe("revise");
      expect(t2.findings[0]).toMatchObject({
        severity: "medium",
        where: "packages/critic/src/rules.ts",
      });
      expect(t2.findings[0]?.description).toContain(
        "packages/critic changed without its maintainer doc (docs/maintainers/critic.md)",
      );
      expect(t2.evidence).toContain("docs: 1 module(s) without their doc");
      const t1 = await w.critic.review(taskInput(w.ids.task, 1, drifting()), w.ctx());
      expect(t1.verdict).toBe("accept");
    } finally {
      await w.close();
    }
  });

  it("no finding when the doc changed too or the PR body waives it", async () => {
    const w = await world({
      replies: [submitReply(), closingReply(), submitReply(), closingReply()],
    });
    try {
      const withDoc = await w.critic.review(
        taskInput(
          w.ids.task,
          2,
          baseEvidence({ ...drifting(), docsTouched: ["docs/maintainers/critic.md"] }),
        ),
        w.ctx(),
      );
      expect(withDoc.verdict).toBe("accept");
      expect(withDoc.evidence).toContain("docs: no drift");
      const waived = await w.critic.review(
        taskInput(
          w.ids.task,
          2,
          baseEvidence({ ...drifting(), docsWaiver: "docs: none needed: constants only" }),
        ),
        w.ctx(),
      );
      expect(waived.verdict).toBe("accept");
      expect(waived.evidence).toContain("docs: waived by the PR body");
    } finally {
      await w.close();
    }
  });
});

describe("CriticService: persistence, resolution and patterns (H.3, H.5)", () => {
  it("persists the review, its findings with fingerprints, the critic run and an event", async () => {
    const w = await world({
      replies: [
        submitReply({
          verdict: "revise",
          grade: 55,
          summary: "Two problems.",
          findings: [
            {
              severity: "major",
              what: "Tests were weakened in test/math.test.ts:4",
              required_action: "Restore the assertions",
            },
            { severity: "minor", what: "Unrelated formatting change", where: "src/other.ts" },
          ],
          evidence: ["diff:src/math.ts#L3"],
          checks_run: ["node --test -> exit 1"],
        }),
        closingReply(),
      ],
    });
    try {
      const out = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(out.reviewId).toBeDefined();
      const review = await w.store.review.mustGet(out.reviewId as string);
      expect(review).toMatchObject({
        task_id: w.ids.task,
        session_id: w.ids.session,
        verdict: "revise",
        grade: 55,
        tier: 1,
        critic_model: "fake-sonnet",
        author_agent: w.ids.critic,
      });
      expect(review.evidence).toContain("diff:src/math.ts#L3");
      expect(review.evidence).toContain("ran: node --test -> exit 1");
      const findings = await w.store.finding.forReview(review.id);
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.status)).toEqual(["open", "open"]);
      expect(findings.map((f) => f.severity).sort()).toEqual(["high", "low"]);
      expect(findings.every((f) => /^[0-9a-f]{16}$/.test(f.fingerprint))).toBe(true);
      expect(findings.find((f) => f.severity === "high")?.required_action).toBe(
        "Restore the assertions",
      );
      expect(out.findingIds).toEqual(findings.map((f) => f.id));
      const runs = await w.store.run.forSession(w.ids.session);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: out.runId,
        specialist: "critic",
        task_id: w.ids.task,
        provider: "fake",
        effort: "medium",
      });
      expect(runs[0]?.cost_usd_micro).toBe(out.costUsdMicro);
      expect(out.costUsdMicro).toBeGreaterThan(0);
      const events = await w.store.event.list(w.ids.session);
      expect(events.map((e) => e.type)).toContain("critic.review");
    } finally {
      await w.close();
    }
  });

  it("an accepting re-review resolves the task's earlier open findings with the run that fixed them", async () => {
    const w = await world({
      replies: [
        submitReply({
          verdict: "revise",
          grade: 50,
          findings: [{ severity: "major", what: "Off by one in clamp" }],
        }),
        closingReply(),
        submitReply({ grade: 93 }),
        closingReply(),
      ],
    });
    try {
      const first = await w.critic.review(taskInput(w.ids.task), w.ctx());
      const openBefore = await w.store.finding.openFor(w.ids.task);
      expect(openBefore).toHaveLength(1);
      const fix = await w.store.run.insert({
        session_id: w.ids.session,
        task_id: w.ids.task,
        specialist: "coder",
        model: "fake-sonnet",
      });
      const second = await w.critic.review(
        taskInput(w.ids.task, 1, baseEvidence({ runId: fix.id })),
        w.ctx(),
      );
      // The second call saw the earlier finding in its evidence.
      const user = w.provider.calls[2]?.request.messages[0]?.content as string;
      expect(user).toContain("Open findings from earlier reviews");
      expect(user).toContain("Off by one in clamp");
      expect(second.verdict).toBe("accept");
      expect(second.resolvedFindingIds).toEqual(first.findingIds);
      const resolved = await w.store.finding.mustGet(first.findingIds?.[0] as string);
      expect(resolved).toMatchObject({ status: "resolved", resolved_by_run: fix.id });
      expect(await w.store.finding.openFor(w.ids.task)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("the same finding in two sessions is a pattern and yields a lesson proposal", async () => {
    const finding = (where: string) => ({
      severity: "major" as const,
      what: `Tests were weakened: assertions removed in ${where}`,
    });
    const w = await world({
      replies: [
        submitReply({ verdict: "revise", grade: 40, findings: [finding("test/a.test.ts:10")] }),
        closingReply(),
        submitReply({
          verdict: "revise",
          grade: 45,
          findings: [finding("packages/x/test/b.test.ts:99")],
        }),
        closingReply(),
      ],
    });
    try {
      const first = await w.critic.review(taskInput(w.ids.task), w.ctx());
      expect(first.patterns).toEqual([]);
      expect(first.lessonProposals).toEqual([]);

      const session2 = await w.newSession();
      const task2 = await w.newTask();
      const second = await w.critic.review(
        taskInput(task2.id),
        w.ctx({ sessionToken: w.tokenFor(session2, task2.id) }),
      );
      expect(second.findings[0]?.fingerprint).toBe(first.findings[0]?.fingerprint);
      expect(second.patterns).toEqual([
        { fingerprint: first.findings[0]?.fingerprint, total: 2, sessions: 2, tasks: 2 },
      ]);
      expect(second.lessonProposals).toHaveLength(1);
      expect(second.lessonProposals[0]).toMatchObject({
        scope: "critic",
        tags: ["critic", "pattern", "high"],
        source: `critic:pattern:${first.findings[0]?.fingerprint}`,
      });
      expect(second.lessonProposals[0]?.text).toContain("2 times in 2 sessions");
      expect(second.lessonProposals[0]?.text).toContain("Tests were weakened");
      expect(await w.store.finding.repeated(2)).toHaveLength(1);
      // Proposals are returned, never written: the critic does not touch the lesson table.
      expect(await w.store.lesson.count()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it("the model follows the tier and the ceiling the context gives, and the run row records it", async () => {
    const w = await world({
      replies: [submitReply(), closingReply(), submitReply(), closingReply()],
    });
    try {
      const capped = await w.critic.review(
        taskInput(w.ids.task, 2),
        w.ctx({ projectSettings: { critic_ceiling: "sonnet" } }),
      );
      expect(capped.model).toBe("fake-sonnet");
      const free = await w.critic.review(taskInput(w.ids.task, 2), w.ctx());
      expect(free.model).toBe("fake-opus");
      expect(w.provider.calls[0]?.request.model).toBe("fake-sonnet");
      expect(w.provider.calls[0]?.request.effort).toBe("high");
      expect(w.provider.calls[2]?.request.model).toBe("fake-opus");
      const runs = await w.store.run.forTask(w.ids.task);
      expect(runs.map((r) => r.model).sort()).toEqual(["fake-opus", "fake-sonnet"]);
    } finally {
      await w.close();
    }
  });

  it("the project's critic_ceiling is read from the store when the context gives no settings, and the stricter ceiling wins (D.3)", async () => {
    const w = await world({
      replies: [submitReply(), closingReply(), submitReply(), closingReply()],
      projectSettings: { critic_ceiling: "sonnet" },
    });
    try {
      // A plain context: the project row alone caps a tier 2 review at sonnet.
      const plain = await w.critic.review(taskInput(w.ids.task, 2), w.ctx());
      expect(plain.model).toBe("fake-sonnet");
      expect(w.provider.calls[0]?.request.model).toBe("fake-sonnet");
      // A caller cannot raise the critic above the project's ceiling.
      const raised = await w.critic.review(taskInput(w.ids.task, 2), w.ctx({ ceiling: "opus" }));
      expect(raised.model).toBe("fake-sonnet");
      expect(w.provider.calls[2]?.request.model).toBe("fake-sonnet");
    } finally {
      await w.close();
    }
  });

  it("a session subject's review event goes to the subject session, not the token's", async () => {
    const w = await world({
      replies: [submitReply({ summary: "Quiet session." }), closingReply()],
    });
    try {
      const subject = await w.newSession({ summary: "Done: 0.", status: "completed" });
      const out = await w.critic.review(
        {
          subject: { kind: "session", sessionId: subject },
          tier: 1,
          evidence: { acceptanceCriteria: [] },
        },
        w.ctx(),
      );
      expect(out.verdict).toBe("accept");
      const review = await w.store.review.mustGet(out.reviewId as string);
      expect(review.session_id).toBe(subject);
      const onSubject = (await w.store.event.list(subject)).filter(
        (e) => e.type === "critic.review",
      );
      expect(onSubject).toHaveLength(1);
      expect(onSubject[0]?.payload).toMatchObject({ reviewId: out.reviewId });
      const onToken = (await w.store.event.list(w.ids.session)).filter(
        (e) => e.type === "critic.review",
      );
      expect(onToken).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("a session subject at tier 1 adds the model's read to the deterministic checks and a lie ends with the human", async () => {
    const w = await world({
      replies: [submitReply({ grade: 90, summary: "Great session." }), closingReply()],
    });
    try {
      const done = await w.newTask({ status: "done", title: "done one" });
      const open = await w.newTask({ status: "in_progress", title: "open one" });
      await w.store.session.patch(w.ids.session, {
        // A plan write carries its reason and author (spec B.5).
        reason: "planned for the test",
        author_agent: w.ids.owner,
        plan: {
          items: [
            { taskId: done.id, title: done.title, estimateUsdMicro: 1000 },
            { taskId: open.id, title: open.title, estimateUsdMicro: 1000 },
          ],
          estimateUsdMicro: 2000,
          summary: "",
        },
        summary: "Done: 2 tasks. Cost: USD 0.0020.",
      });
      const out = await w.critic.review(
        {
          subject: { kind: "session", sessionId: w.ids.session },
          tier: 1,
          evidence: { acceptanceCriteria: [] },
        },
        w.ctx(),
      );
      expect(out.verdict).toBe("human");
      expect(
        out.findings.some((f) => f.description.startsWith("Summary claims 2 task(s) done but 1")),
      ).toBe(true);
      expect(out.grade).toBeLessThanOrEqual(70);
      const review = (await w.store.review.forSession(w.ids.session))[0];
      expect(review).toMatchObject({ session_id: w.ids.session, task_id: null, verdict: "human" });
      const user = w.provider.calls[0]?.request.messages[0]?.content as string;
      expect(user).toContain("## Session");
      expect(user).toContain("Done: 2 tasks");
    } finally {
      await w.close();
    }
  });
});

describe("CriticService: a max-effort review finishes inside its budget (D.15 live run of 2026-10-25)", () => {
  // Live, tier 3 on Opus 5.5 at effort max spent the whole 8192-token first call thinking and
  // ended with no verdict. The loop prices a call at its full output cap, and a review was two
  // calls (submit_review, then a closing call), so a larger fixed cap had the closing call
  // refused under the USD 0.50 review cap. Priced here at Opus 5.5's list rates in micro-USD
  // per token (USD 4 / 20 per MTok, fast mode 8 / 40).
  const OPUS: RunPricing = {
    estimate: (i, o) => Math.ceil(4 * i + 20 * o),
    cost: (u) => 4 * u.input_tokens + 20 * u.output_tokens,
  };
  const OPUS_FAST: RunPricing = {
    estimate: (i, o) => Math.ceil(8 * i + 40 * o),
    cost: (u) => 8 * u.input_tokens + 40 * u.output_tokens,
  };
  const pricing = (model: string): RunPricing => (model.endsWith("-fast") ? OPUS_FAST : OPUS);
  const TABLE: PricingTable = {
    ...BUILTIN_PRICING,
    "fake-opus": { ...(BUILTIN_PRICING["claude-opus-5-5"] as PricingTable[string]) },
    "fake-opus-fast": { ...(BUILTIN_PRICING["claude-opus-5-5-fast"] as PricingTable[string]) },
  };
  const REVIEW_CAP = 500_000;

  /**
   * A model that needs `need` output tokens (thinking and the tool call) before its verdict:
   * with a smaller max_tokens it thinks to the cap and stops there, as the live call did.
   */
  const needs = (need: number): ScriptedReply[] => [
    submitReply(
      {},
      { when: (req) => (req.max_tokens ?? 0) >= need, usage: { output_tokens: need } },
    ),
    {
      when: (req) => (req.max_tokens ?? 0) < need,
      reply: {
        thinking: "Still weighing the diff.",
        stopReason: "max_tokens",
        usage: { output_tokens: 8192 },
      },
      times: Number.POSITIVE_INFINITY,
    },
    closingReply(),
  ];

  const review = async (opts: { tier: 2 | 3; need: number; fast?: boolean }) => {
    const w = await world({
      replies: needs(opts.need),
      ...(opts.fast ? { projectSettings: { fast_mode: true } } : {}),
      deps: {
        pricing,
        ...(opts.fast
          ? { fastMode: async () => ({ sourceKind: "api_key" as const, pricing: TABLE }) }
          : {}),
      },
    });
    if (opts.fast) Object.assign(w.provider, { fastMode: true });
    const events: RunEvent[] = [];
    const out = await w.critic.review(
      taskInput(w.ids.task, opts.tier),
      w.ctx({ budgetUsdMicro: REVIEW_CAP, onEvent: (e) => events.push(e) }),
    );
    const estimates = events.flatMap((e) =>
      e.type === "model_call_start" ? [e.estimateUsdMicro] : [],
    );
    return { w, out, estimates, calls: w.provider.calls.map((c) => c.request) };
  };

  it("tier 3 at effort max, Opus: one call sized from the budget left, verdict captured, outcome completed", async () => {
    const r = await review({ tier: 3, need: 15_000 });
    try {
      expect(r.calls[0]?.effort).toBe("max");
      expect(r.out.outcome).toBe("completed");
      // The model's verdict was used (its grade); tier 3 always ends at the human (ADR 0028).
      expect(r.out.grade).toBe(92);
      expect(r.out.verdict).toBe("human");
      // The verdict ends the run: no closing call priced at a full cap after it.
      expect(r.calls).toHaveLength(1);
      const cap = r.calls[0]?.max_tokens ?? 0;
      expect(cap).toBeGreaterThanOrEqual(15_000);
      expect(cap).toBeLessThanOrEqual(MAX_EFFORT_TOKENS_CEILING);
      expect(r.estimates[0]).toBeLessThanOrEqual(REVIEW_CAP);
      expect(r.out.costUsdMicro).toBeLessThanOrEqual(REVIEW_CAP);
    } finally {
      await r.w.close();
    }
  });

  it("tier 3 at effort max in fast mode: the cap shrinks to what USD 0.50 buys at USD 40 per MTok, the review still completes", async () => {
    const r = await review({ tier: 3, need: 10_000, fast: true });
    try {
      expect(r.calls[0]?.speed).toBe("fast");
      expect(r.out.model).toBe("fake-opus-fast");
      expect(r.out.outcome).toBe("completed");
      expect(r.calls).toHaveLength(1);
      const cap = r.calls[0]?.max_tokens ?? 0;
      expect(cap).toBeGreaterThanOrEqual(10_000);
      expect(cap).toBeLessThan(15_000);
      expect(r.estimates[0]).toBeLessThanOrEqual(REVIEW_CAP);
      expect(r.out.costUsdMicro).toBeLessThanOrEqual(REVIEW_CAP);
    } finally {
      await r.w.close();
    }
  });

  it("a max-effort review is still bounded by its deep-review timeout", async () => {
    // The larger cap buys a longer call, not a longer review: a model that has not answered by
    // DEFAULT_DEEP_REVIEW_TIMEOUT_MS is cut off and the review names the timeout.
    const w = await world({
      latency: "simulated",
      replies: [submitReply({}, { ttftMs: DEFAULT_DEEP_REVIEW_TIMEOUT_MS + 60_000 })],
      deps: { pricing },
    });
    try {
      const p = w.critic.review(taskInput(w.ids.task, 3), w.ctx({ budgetUsdMicro: REVIEW_CAP }));
      await until(() => w.provider.calls.length >= 1, "the review call");
      const req = w.provider.calls[0]?.request;
      expect(req?.effort).toBe("max");
      expect(req?.max_tokens ?? 0).toBeGreaterThan(REVIEW_TOKENS_PER_CALL);
      await w.clock.advance(DEFAULT_DEEP_REVIEW_TIMEOUT_MS + 1);
      const out = await p;
      expect(out.outcome).toBe("timeout");
      // No verdict was captured: the review is not a pass (grade 0, escalate).
      expect(out.grade).toBe(0);
      expect(out.verdict).not.toBe("accept");
      expect(w.provider.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it("tier 2 at effort high is unchanged: 8192 per call, submit_review then the closing call", async () => {
    const r = await review({ tier: 2, need: 2_000 });
    try {
      expect(r.calls.map((c) => c.effort)).toEqual(["high", "high"]);
      expect(r.calls.map((c) => c.max_tokens)).toEqual([REVIEW_TOKENS_PER_CALL, 8192]);
      expect(r.out.outcome).toBe("completed");
    } finally {
      await r.w.close();
    }
  });

  it("a captured verdict is not reported as budget_exceeded when the call after it is refused", async () => {
    // Measure the first call's estimate, then give a run cap that covers it and not the
    // closing call: the closing call is refused, the verdict already stands.
    const probe = await world({ replies: [submitReply(), closingReply()] });
    let first = 0;
    try {
      await probe.critic.review(
        taskInput(probe.ids.task, 2),
        probe.ctx({
          onEvent: (e) => {
            if (e.type === "model_call_start" && first === 0) first = e.estimateUsdMicro;
          },
        }),
      );
    } finally {
      await probe.close();
    }
    expect(first).toBeGreaterThan(8192);
    const w = await world({ replies: [submitReply({ grade: 91 }), closingReply()] });
    try {
      const events: RunEvent[] = [];
      const out = await w.critic.review(
        taskInput(w.ids.task, 2),
        w.ctx({ budgetUsdMicro: first + 100, onEvent: (e) => events.push(e) }),
      );
      expect(events.filter((e) => e.type === "model_call_start")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "run_end", outcome: "budget_exceeded" });
      expect(out.outcome).toBe("completed");
      expect(out.verdict).toBe("accept");
      expect(out.grade).toBe(91);
    } finally {
      await w.close();
    }
  });
});
