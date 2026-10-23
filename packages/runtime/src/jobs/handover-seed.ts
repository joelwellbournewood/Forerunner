/**
 * The seeded change of the handover test (spec P.15 "a fresh agent with only the repo and docs
 * makes a small seeded change"; ADR 0060). A seed is the task the fresh agent gets, phrased
 * the way the repository's own docs would hand it over, plus the files the change names (the
 * docs task names them when the agent got stuck there). Two seeds ship:
 *
 * - `CLAMP_SEED` with `SEEDED_REPO`: the sample repository of scenario 8 (the standard doc
 *   set, a defect in `src/clamp.js`, the failing `test/clamp.test.js`) and the task that
 *   fixes it. The scenario and the job's unit test run it; a project whose repository is that
 *   sample can name it in `settings.handover.seed`.
 * - `defaultHandoverSeed(date)`: for any repository with the standard doc set, a one-line
 *   addition to `docs/runbook.md` that proves the agent found the docs, the checks and the
 *   change path from README.md alone. Used when the project setting names no seed.
 *
 * This module has no test-harness dependency, so the daemon's job and the scenario share it.
 */
import type { JsonObject } from "@forerunner/state";
import { z } from "zod";

export interface HandoverSeed {
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
  riskTier: number;
  /** Registry specialist; default the planner's (coder). */
  specialist?: string;
  /** The files the change names: the docs task lists them when the agent got stuck. */
  files: string[];
}

export const HandoverSeedSchema = z.object({
  title: z.string().min(1).max(200),
  outcome: z.string().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
  riskTier: z.number().int().min(0).max(3),
  specialist: z.string().min(1).optional(),
  files: z.array(z.string().min(1)).min(1).max(50),
});

/** A seed from a settings value; null when it is not one (the caller falls back to the default). */
export function handoverSeedOf(raw: unknown): HandoverSeed | null {
  const parsed = HandoverSeedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The default seed: a dated line at the end of `docs/runbook.md` (created from the README's
 * doc list when the repository has none). Small, reversible, and only doable by reading the
 * docs: where the test command lives, where the runbook is, how a change is checked.
 */
export function defaultHandoverSeed(date: string): HandoverSeed {
  const line = `Handover check ${date}: a fresh agent made this change from README.md and docs/ alone.`;
  return {
    title: `Handover check ${date}: note the run in the runbook`,
    outcome: `docs/runbook.md ends with the line "${line}" (create the file from the README's doc list if the repository has none). Nothing else changes. Start from README.md; the docs say how the checks run.`,
    acceptanceCriteria: [
      `docs/runbook.md ends with the line: ${line}`,
      "No other file changes",
      "The check command the docs name still passes",
    ],
    riskTier: 1,
    files: ["README.md", "docs/runbook.md"],
  };
}

export const CLAMP_BUGGY = `/**
 * clamp(x, lo, hi): x limited to the closed range [lo, hi].
 */
export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return lo; // seeded defect: the upper bound returns the wrong edge
  return x;
}
`;

export const CLAMP_FIXED = `/**
 * clamp(x, lo, hi): x limited to the closed range [lo, hi].
 */
export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
`;

export const CLAMP_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/clamp.js";

test("clamp keeps values inside the range", () => {
  assert.equal(clamp(3, 0, 5), 3);
  assert.equal(clamp(-1, 0, 5), 0);
});

test("clamp returns the upper bound above it", () => {
  assert.equal(clamp(10, 0, 5), 5);
});
`;

/** The seeded sample repository: docs first, a defect, a failing test. Keys are POSIX paths. */
export const SEEDED_REPO: Record<string, string> = {
  "README.md": `# clamp

A one-function library. Start with docs/overview.md; docs/testing.md says how the tests run
and what they pin; docs/runbook.md lists the day-to-day commands.
`,
  "docs/overview.md": `# Overview

The library exports one function, \`clamp(x, lo, hi)\` in \`src/clamp.js\`. It limits a number
to the closed range [lo, hi]. A value below lo becomes lo; a value above hi becomes hi.
`,
  "docs/testing.md": `# Testing

Run \`node --test test/clamp.test.js\` from the repository root (Node 22, no dependencies).
The test pins both edges of the range: below lo gives lo, above hi gives hi. A change to
\`src/clamp.js\` is done when this command exits 0.
`,
  "docs/runbook.md": `# Runbook

- Tests: \`node --test test/clamp.test.js\`
- Release: tag the commit; there is no build step.
`,
  "package.json": `{
  "name": "clamp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/clamp.test.js" }
}
`,
  "src/clamp.js": CLAMP_BUGGY,
  "test/clamp.test.js": CLAMP_TEST,
};

/** The project setting that makes the critic run the test at tier 2 (`settings.checks`). */
export const SEEDED_CHECKS: JsonObject = {
  checks: [
    { name: "tests", argv: ["node", "--test", "test/clamp.test.js"], required: true },
  ] as never,
};

/** The task of scenario 8 on the sample repository: phrased as its docs would hand it over. */
export const CLAMP_SEED: HandoverSeed = {
  title: "Fix the clamp upper bound",
  outcome:
    "test/clamp.test.js passes: clamp never returns a value above hi. Start from README.md; docs/testing.md says how the tests run.",
  acceptanceCriteria: [
    "node --test test/clamp.test.js exits 0",
    "src/clamp.js returns hi for values above the range",
  ],
  riskTier: 2,
  files: ["src/clamp.js", "test/clamp.test.js", "docs/testing.md"],
};
