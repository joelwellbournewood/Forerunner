/**
 * Phase 4 gate harness (spec, build order): "Over 4 simulated weeks on the eval projects, the
 * repeat-finding rate drops. Memory loaded per session stays under the set token budget."
 *
 * Four simulated weeks (SimulatedClock) on two projects shaped after the two eval sets, one
 * principal agent each, one session per agent per day on the fake provider. The scripted
 * specialist repeats a kind of work's characteristic defect unless its brief carries the lesson
 * about it; the scripted critic flags the defect from the diff; the production loop does the
 * rest (verdict, retry, resolved finding recorded as a lesson at session end, lesson recalled
 * into the next brief under the task budget, repeat findings into critic memory, weekly
 * consolidation through the inbox). The same weeks run once more without the memory port as
 * the control. See src/four-weeks.ts for the families and the schedule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CODER_FAMILIES,
  type FourWeeksReport,
  formatFourWeeks,
  RESEARCHER_FAMILIES,
  runFourWeeks,
} from "../src/four-weeks.ts";

const SESSION_BUDGET = 600;
const TASK_BUDGET = 300;

/** The gate evidence lines, also written to FORERUNNER_E2E_REPORT_DIR when it is set. */
function record(name: string, text: string): void {
  console.log(text);
  const dir = process.env.FORERUNNER_E2E_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${text}\n`, "utf8");
}

describe("phase 4 gate: four simulated weeks on the eval projects (fake provider)", () => {
  // The with-memory run is what both tests measure (the gate, and the control's baseline), so
  // it runs once before them and each test stands on its own under `-t`.
  let withMemory: FourWeeksReport | undefined;

  beforeAll(async () => {
    withMemory = await runFourWeeks({
      memory: true,
      sessionMemoryBudget: SESSION_BUDGET,
      taskMemoryBudget: TASK_BUDGET,
    });
    record("phase4-four-weeks-memory-on.txt", formatFourWeeks(withMemory));
  }, 1_200_000);

  /** The with-memory report, or a clear failure when the hook did not produce one. */
  function memoryRun(): FourWeeksReport {
    if (!withMemory) throw new Error("the with-memory four weeks of beforeAll did not run");
    return withMemory;
  }

  it("with memory: the repeat-finding rate drops week over week and memory per session stays under the budget", () => {
    const withMemory = memoryRun();
    const rates = withMemory.repeatRates;
    expect(rates).toHaveLength(4);
    expect(withMemory.weeks.every((w) => w.sessions === 14 && w.reviews > 0)).toBe(true);
    // The rate drops: week 1 has repeats (a kind of work recurs the day after its first
    // finding, before the lesson lands), every later week is at or under the one before, and
    // the last week is under the first.
    expect(rates[0]).toBeGreaterThan(0);
    for (let i = 1; i < rates.length; i++)
      expect(rates[i], `week ${i + 1} <= week ${i}`).toBeLessThanOrEqual(rates[i - 1] ?? 0);
    expect(rates[3]).toBeLessThan(rates[0] ?? 0);
    expect(rates[3]).toBe(0);
    // Nothing escaped the ladder: every sent-back task was fixed on its retry.
    expect(withMemory.weeks.reduce((n, w) => n + w.needsHuman, 0)).toBe(0);
    expect(withMemory.totals.reviewFailures).toBe(0);
    expect(withMemory.totals.deniedAuditRows).toBe(0);
    expect(withMemory.totals.auditRows).toBeGreaterThan(withMemory.totals.tasks);

    // Memory per session: the runner's count and an independent count of the lessons
    // section of every brief never exceed the project's budget; the same for every
    // specialist brief under the task budget. The budget is approached, not idle.
    const m = withMemory.memory;
    expect(m.perSession).toHaveLength(withMemory.totals.sessions);
    for (const s of m.perSession) {
      expect(s.budget).toBe(SESSION_BUDGET);
      expect(s.tokens).toBeLessThanOrEqual(SESSION_BUDGET);
    }
    expect(m.briefTokens).toHaveLength(withMemory.totals.sessions);
    for (const t of m.briefTokens) expect(t).toBeLessThanOrEqual(SESSION_BUDGET);
    expect(m.taskBriefTokens.length).toBeGreaterThanOrEqual(withMemory.totals.tasks);
    for (const t of m.taskBriefTokens) expect(t).toBeLessThanOrEqual(TASK_BUDGET);
    expect(m.maxSessionTokens).toBeGreaterThan(SESSION_BUDGET / 2);
    expect(m.maxTaskTokens).toBeGreaterThan(TASK_BUDGET / 2);
    expect(m.overBudgetEvents).toBe(0);

    // What memory holds at the end: one private lesson per kind of work and agent (the
    // near-duplicate merge keeps a repeated lesson single), the critic's pattern lessons, and
    // four weekly consolidation rounds answered from the inbox.
    const families = CODER_FAMILIES.length + RESEARCHER_FAMILIES.length;
    expect(withMemory.totals.privateLessons).toBeGreaterThanOrEqual(families);
    expect(withMemory.totals.criticLessons).toBeGreaterThanOrEqual(1);
    expect(withMemory.consolidation).toHaveLength(4);
    expect(withMemory.consolidation.map((c) => c.week)).toEqual([1, 2, 3, 4]);
    expect(withMemory.weeks.reduce((n, w) => n + w.lessonsRecorded, 0)).toBeGreaterThanOrEqual(
      families,
    );
  });

  it("control without memory: the same four weeks repeat the same findings and the rate does not drop", async () => {
    const withMemory = memoryRun();
    const control = await runFourWeeks({ memory: false });
    record("phase4-four-weeks-memory-off.txt", formatFourWeeks(control));
    const rates = control.repeatRates;
    expect(rates[3]).toBeGreaterThanOrEqual(rates[0] ?? 0);
    expect(rates[0]).toBeGreaterThan(withMemory.repeatRates[0] ?? 0);
    expect(control.totals.repeats).toBeGreaterThan(withMemory.totals.repeats * 4);
    expect(control.memory.perSession).toHaveLength(0);
    expect(control.totals.privateLessons).toBe(0);
    expect(control.totals.criticLessons).toBe(0);
    expect(control.consolidation).toEqual([]);
    expect(control.totals.reviewFailures).toBe(0);
  }, 1_200_000);
});
