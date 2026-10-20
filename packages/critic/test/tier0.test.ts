import { resolve, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  type CheckCommand,
  type CheckRunner,
  ProcessCheckRunner,
  type ProcessRunner,
  reviewTier0,
  TIER0_CONFIDENCE_WITHOUT_CHECKS,
  TIER0_MODEL,
} from "../src/tier0.ts";
import { baseEvidence } from "./helpers.ts";

const clock = new SimulatedClock();

describe("tier 0: automated checks only", () => {
  it("grades by pass share and accepts only when every required check passes", async () => {
    const out = await reviewTier0({
      clock,
      evidence: baseEvidence({
        checkResults: [
          { name: "lint", passed: true, output: "" },
          { name: "typecheck", passed: true, output: "" },
          { name: "tests", passed: false, output: "1 failing\n  clamp > upper bound" },
        ],
      }),
    });
    // three checks plus "criteria present": 3 of 4 items passed
    expect(out.grade).toBe(75);
    expect(out.verdict).toBe("revise");
    expect(out.model).toBe(TIER0_MODEL);
    expect(out.costUsdMicro).toBe(0);
    expect(out.confidence).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      severity: "high",
      description: "Check failed: tests",
      where: "1 failing",
    });
    expect(out.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(out.evidence).toContain("[fail] tests: 1 failing");
  });

  it("accepts with grade 100 when everything passes and criteria exist", async () => {
    const out = await reviewTier0({ clock, evidence: baseEvidence() });
    expect(out).toMatchObject({ grade: 100, verdict: "accept", tier: 0, outcome: "completed" });
    expect(out.findings).toEqual([]);
    expect(out.adjustments).toEqual([]);
  });

  it("an optional check that fails leaves a low finding and does not block accept", async () => {
    const out = await reviewTier0({
      clock,
      evidence: baseEvidence({
        checkResults: [
          { name: "lint", passed: true, output: "" },
          { name: "typecheck", passed: true, output: "" },
          { name: "tests", passed: true, output: "" },
          { name: "coverage", passed: false, output: "81% < 85%", required: false },
        ],
      }),
    });
    expect(out.grade).toBe(80);
    expect(out.verdict).toBe("accept");
    expect(out.findings.map((f) => f.severity)).toEqual(["low"]);
  });

  it("with no checks at all the confidence is low and accept becomes escalate", async () => {
    const out = await reviewTier0({ clock, evidence: baseEvidence({ checkResults: [] }) });
    expect(out.confidence).toBe(TIER0_CONFIDENCE_WITHOUT_CHECKS);
    expect(out.verdict).toBe("escalate");
    expect(out.adjustments.map((a) => a.rule)).toEqual(["low_confidence"]);
    expect(out.summary).toContain("no automated checks");
  });

  it("missing acceptance criteria is a medium finding and blocks accept", async () => {
    const out = await reviewTier0({
      clock,
      evidence: baseEvidence({
        acceptanceCriteria: [],
        checkResults: [{ name: "t", passed: true, output: "" }],
      }),
    });
    expect(out.grade).toBe(50);
    expect(out.verdict).toBe("revise");
    expect(out.findings[0]).toMatchObject({ severity: "medium" });
    expect(out.findings[0]?.description).toMatch(/No acceptance criteria/);
    expect(out.evidence).toContain("[fail] acceptance criteria present");
  });

  it("runs check commands through the injected runner in the worktree with a timeout", async () => {
    const seen: { cmd: CheckCommand; cwd?: string }[] = [];
    const runner: CheckRunner = {
      async run(cmd, o) {
        seen.push({ cmd, cwd: o.cwd });
        return {
          name: cmd.name,
          passed: cmd.name !== "slow",
          output: `${cmd.argv.join(" ")} -> exit 0`,
        };
      },
    };
    const out = await reviewTier0({
      clock,
      runner,
      cwd: "/work/tree",
      evidence: baseEvidence({ checkResults: [] }),
      checks: [
        { name: "unit", argv: ["pnpm", "test"], timeoutMs: 1000 },
        { name: "slow", argv: ["pnpm", "e2e"] },
      ],
    });
    expect(seen.map((s) => s.cmd.name)).toEqual(["unit", "slow"]);
    expect(seen[0]?.cwd).toBe("/work/tree");
    expect(out.verdict).toBe("revise");
    expect(out.findings[0]?.description).toBe("Check failed: slow");
  });

  it("ProcessCheckRunner resolves a relative command cwd against the review's cwd, keeps an absolute one", async () => {
    const cwds: (string | undefined)[] = [];
    const exec: ProcessRunner = async (_argv, opts) => {
      cwds.push(opts.cwd);
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 1,
      };
    };
    const runner = new ProcessCheckRunner(exec);
    const worktree = resolve("work", "tree");
    const elsewhere = resolve("elsewhere");
    await runner.run({ name: "sub", argv: ["x"], cwd: "packages/sub" }, { cwd: worktree });
    await runner.run({ name: "abs", argv: ["x"], cwd: elsewhere }, { cwd: worktree });
    await runner.run({ name: "root", argv: ["x"] }, { cwd: worktree });
    await runner.run({ name: "bare", argv: ["x"], cwd: "packages/sub" }, {});
    expect(cwds).toEqual([
      resolve(worktree, "packages", "sub"),
      elsewhere,
      worktree,
      resolve("packages", "sub"),
    ]);
  });

  it("ProcessCheckRunner reports the exit code, output tail and timeouts of a real process", async () => {
    const runner = new ProcessCheckRunner();
    const ok = await runner.run({
      name: "node-ok",
      argv: ["node", "-e", "console.log('hello from check')"],
    });
    expect(ok.passed).toBe(true);
    expect(ok.output).toContain("exit 0");
    expect(ok.output).toContain("hello from check");
    const bad = await runner.run({
      name: "node-bad",
      argv: ["node", "-e", "process.exit(3)"],
      required: false,
    });
    expect(bad.passed).toBe(false);
    expect(bad.required).toBe(false);
    expect(bad.output).toContain("exit 3");
    const slow = await runner.run({
      name: "node-slow",
      argv: ["node", "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 200,
    });
    expect(slow.passed).toBe(false);
    expect(slow.output).toContain("timeout");
  });
});
