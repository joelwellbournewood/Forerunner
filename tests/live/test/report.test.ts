import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  comparePhase1,
  completedOrInReview,
  PHASE1_EVIDENCE_FILE,
  PHASE1_EVIDENCE_VAR,
  readPhase1Evidence,
} from "../src/report.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-report-"));
  temps.push(dir);
  return dir;
}

const RUN = "2026-10-20T20:04:16.132Z";
const OTHER_RUN = "2026-10-20T18:58:41.000Z";

/** The shape `live-1-phase1.live.test.ts` writes to `phase1-live.json`. */
function phase1File(dir: string, run: string, name = PHASE1_EVIDENCE_FILE): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      run,
      session: {
        tasks: [
          { title: "Add a greeting", outcome: "done", verdict: "accept", grade: 95 },
          { title: "Add a farewell", outcome: "in_review", verdict: null, grade: null },
          { title: "Count words", outcome: "done", verdict: "accept", grade: 93 },
        ],
      },
    }),
    "utf8",
  );
  return file;
}

const SUBSCRIPTION_TASKS = [
  { title: "Add a greeting", outcome: "done", verdict: "accept" },
  { title: "Add a farewell", outcome: "done", verdict: "accept" },
  { title: "Count words", outcome: "failed", verdict: null },
];

describe("the API-key half's evidence file", () => {
  it("is null when no file is in the report directory and the variable is not set", () => {
    expect(readPhase1Evidence(tempDir(), {})).toBeNull();
  });

  it("reads the run and the per-task outcomes from the report directory", () => {
    const dir = tempDir();
    const file = phase1File(dir, RUN);
    const phase1 = readPhase1Evidence(dir, {});
    expect(phase1).not.toBeNull();
    expect(phase1?.file).toBe(file);
    expect(phase1?.run).toBe(RUN);
    expect(phase1?.tasks).toEqual([
      { title: "Add a greeting", outcome: "done", verdict: "accept", grade: 95 },
      { title: "Add a farewell", outcome: "in_review", verdict: null, grade: null },
      { title: "Count words", outcome: "done", verdict: "accept", grade: 93 },
    ]);
  });

  it("takes the file named by the variable over the report directory's", () => {
    const dir = tempDir();
    phase1File(dir, OTHER_RUN);
    const named = phase1File(tempDir(), RUN, "elsewhere.json");
    const phase1 = readPhase1Evidence(dir, { [PHASE1_EVIDENCE_VAR]: named });
    expect(phase1?.file).toBe(named);
    expect(phase1?.run).toBe(RUN);
  });

  it("is null for a file that is not JSON or not an object", () => {
    const dir = tempDir();
    writeFileSync(join(dir, PHASE1_EVIDENCE_FILE), "not json", "utf8");
    expect(readPhase1Evidence(dir, {})).toBeNull();
    writeFileSync(join(dir, PHASE1_EVIDENCE_FILE), "[1]", "utf8");
    expect(readPhase1Evidence(dir, {})?.tasks).toEqual([]);
  });
});

describe("the per-task comparison of the subscription half with the API-key half", () => {
  it("is made only for the same run: outcomes compared as completed-or-in-review", () => {
    const dir = tempDir();
    const file = phase1File(dir, RUN);
    const c = comparePhase1(readPhase1Evidence(dir, {}), RUN, SUBSCRIPTION_TASKS, dir);
    expect(c.made).toBe(true);
    expect(c.stale).toBe(false);
    expect(c.reason).toBeNull();
    expect(c.file).toBe(file);
    expect(c.apiKeyRun).toBe(RUN);
    expect(c.tasks.map((t) => [t.title, t.same])).toEqual([
      ["Add a greeting", true],
      ["Add a farewell", true], // in_review on the key, done on the subscription: both count
      ["Count words", false], // done on the key, failed on the subscription
    ]);
    expect(c.tasks[0]?.apiKey).toEqual({ outcome: "done", verdict: "accept" });
    expect(c.tasks[0]?.subscription).toEqual({ outcome: "done", verdict: "accept" });
  });

  it("a file from another run is flagged as stale and listed, never compared silently", () => {
    const dir = tempDir();
    const file = phase1File(dir, OTHER_RUN);
    const c = comparePhase1(readPhase1Evidence(dir, {}), RUN, SUBSCRIPTION_TASKS, dir);
    expect(c.made).toBe(false);
    expect(c.stale).toBe(true);
    expect(c.file).toBe(file);
    expect(c.apiKeyRun).toBe(OTHER_RUN);
    expect(c.reason).toContain(OTHER_RUN);
    expect(c.reason).toContain(RUN);
    expect(c.reason).toContain(file);
    // The other run's outcomes stay visible in the evidence, with the verdict per task.
    expect(c.tasks.map((t) => [t.title, t.apiKey?.outcome ?? null, t.same])).toEqual([
      ["Add a greeting", "done", true],
      ["Add a farewell", "in_review", true],
      ["Count words", "done", false],
    ]);
  });

  it("without a file it is not made, with the reason naming the directory and the variable", () => {
    const dir = tempDir();
    const c = comparePhase1(null, RUN, SUBSCRIPTION_TASKS, dir);
    expect(c.made).toBe(false);
    expect(c.stale).toBe(false);
    expect(c.file).toBeNull();
    expect(c.apiKeyRun).toBeNull();
    expect(c.reason).toContain(dir);
    expect(c.reason).toContain(PHASE1_EVIDENCE_VAR);
    expect(c.tasks.map((t) => [t.title, t.apiKey, t.same])).toEqual([
      ["Add a greeting", null, null],
      ["Add a farewell", null, null],
      ["Count words", null, null],
    ]);
  });

  it("a task the API-key half did not record compares as null, not as a match", () => {
    const dir = tempDir();
    phase1File(dir, RUN);
    const c = comparePhase1(
      readPhase1Evidence(dir, {}),
      RUN,
      [{ title: "A fourth task", outcome: "done", verdict: null }],
      dir,
    );
    expect(c.made).toBe(true);
    expect(c.tasks).toEqual([
      {
        title: "A fourth task",
        apiKey: null,
        subscription: { outcome: "done", verdict: null },
        same: null,
      },
    ]);
  });

  it("completed or in review is done or in_review, nothing else", () => {
    expect(completedOrInReview("done")).toBe(true);
    expect(completedOrInReview("in_review")).toBe(true);
    for (const s of ["failed", "ready", "needs_human", "claimed", "cancelled", ""]) {
      expect(completedOrInReview(s), s).toBe(false);
    }
  });
});
