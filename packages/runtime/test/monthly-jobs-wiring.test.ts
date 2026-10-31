/**
 * The monthly jobs inside the composed daemon (spec H.7, P.15, ADR 0060): the scheduler that
 * `composeRuntime` builds fires the critic calibration on the simulated clock and the
 * notification is raised through the daemon's notifier; the settings decide the schedules;
 * the handover's session in the daemon runs with no memory at all, so no lesson (the shared
 * scope included) reaches a model call of the fresh agent: only the repo and the docs.
 * Fake provider, `sqlite::memory:`, a temp install directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { CALIBRATION_AGENT_ID, CALIBRATION_SCHEDULE_ID } from "../src/jobs/calibration.ts";
import { handoverAgentId, handoverScheduleId } from "../src/jobs/handover.ts";
import type { NotificationRecord } from "../src/notifications/types.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
const LESSON =
  "Before touching the clamp module always run the zebra checklist from the team wiki first.";
const SEED = {
  title: "Fix the clamp upper bound (zebra)",
  outcome: "clamp returns hi above the range; the clamp module and the zebra checklist agree.",
  acceptanceCriteria: ["clamp returns hi above the range"],
  riskTier: 1,
  files: ["src/clamp.js"],
};

describe("monthly jobs in the composed daemon", () => {
  let rt: RuntimeApp;
  let home: string;
  let provider: ScriptedProvider;
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const records: NotificationRecord[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-monthly-jobs-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    provider = new ScriptedProvider([{ text: "Done." }], clock);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      startServices: false,
    });
    rt.notifier.emitter.on("record", (r) => void records.push(r));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the handover's fresh agent gets no lesson in any model call, the shared scope included", async () => {
    await rt.memory.ctx.repo.add({
      scope: "shared",
      project_id: null,
      text: LESSON,
      source: "session:seed",
      tags: ["coder", "clamp"],
      confidence: 0.9,
      hit_count: 0,
      pinned: false,
      status: "active",
      embedding: [...rt.memory.ctx.embedder.embed(LESSON)],
      author_agent: rt.agent.id,
    });
    const project = await rt.store.project.insert({
      name: "Forerunner",
      goal: "the handover target",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 3,
      summary_cache: {},
      data_assets: [],
      settings: { handover: { enabled: true, seed: SEED } },
      small_project_mode: false,
      active: true,
    });
    const before = provider.calls.length;
    const r = await rt.jobs.handover.run(project.id);
    expect(r.status).toBe("ran");
    const report = r.report;
    if (!report) throw new Error("no report");
    expect(report.memory).toBeNull();
    // Control: memory WOULD hand that lesson to this agent on this task.
    const recalled = await rt.memory.recall({
      agentId: report.agentId,
      kind: "principal",
      projectId: project.id,
      query: `${SEED.title}\n${SEED.outcome}\n${SEED.acceptanceCriteria.join("\n")}`,
      tags: ["coder"],
      maxTokens: 400,
    });
    expect(recalled.block).toContain("zebra checklist");
    // The fresh agent's specialist did run on the seed, and no call carried the lesson.
    const calls = provider.calls.slice(before).map((c) => JSON.stringify(c));
    // On failure, say what the handover run reported (it failed on Windows CI only).
    expect(
      calls.some((c) => c.includes(SEED.title)),
      `no model call on the seed; the handover report: ${JSON.stringify(report).slice(0, 2000)}`,
    ).toBe(true);
    expect(calls.filter((c) => c.includes("zebra checklist from the team wiki"))).toEqual([]);
    // The settings made one handover schedule for the project, under its own agent id.
    await rt.jobs.refreshSchedules();
    expect(rt.scheduler.list().find((s) => s.id === handoverScheduleId(project.id))).toMatchObject({
      agentId: handoverAgentId(project.id),
      kind: "monthly",
      dayOfMonth: 1,
      time: "07:00",
    });
  }, 120_000);

  it("the composed scheduler fires the calibration once on day 1 at 06:00 local and the notification is raised", async () => {
    const h = await rt.store.human.mustGet(rt.human.id);
    await rt.store.human.update(h.id, h.version, {
      notify_prefs: { ...h.notify_prefs, calibration: { specialists: ["coder"] } },
    });
    const calibrationStarts = () =>
      rt.scheduler.log.filter((l) => l.req.agentId === CALIBRATION_AGENT_ID);
    const settle = async () => {
      for (let i = 0; i < 600 && rt.scheduler.isActive(CALIBRATION_AGENT_ID); i++)
        await new Promise((r) => setTimeout(r, 50));
    };
    // 23 October: first sight after the day, nothing runs this month.
    await rt.scheduler.tick();
    expect(rt.scheduler.list().find((s) => s.id === CALIBRATION_SCHEDULE_ID)).toMatchObject({
      kind: "monthly",
      dayOfMonth: 1,
      time: "06:00",
      timezone: "Europe/Zurich",
      enabled: true,
    });
    expect(calibrationStarts()).toEqual([]);
    // 1 November 05:59 CET: not yet; 06:01 CET: the run.
    await clock.set("2026-11-01T04:59:00Z");
    await rt.scheduler.tick();
    expect(calibrationStarts()).toEqual([]);
    await clock.set("2026-11-01T05:01:00Z");
    await rt.scheduler.tick();
    expect(calibrationStarts().map((l) => l.result)).toEqual(["started"]);
    await settle();
    const rec = records.find((r) => r.notification.kind === "critic_calibration");
    expect(rec?.notification).toMatchObject({ humanId: rt.human.id });
    expect(rec?.notification.title).toMatch(/^Critic calibration 2026-11-01/);
    // Later the same month: no second run.
    await clock.set("2026-11-15T12:00:00Z");
    await rt.scheduler.tick();
    await settle();
    expect(calibrationStarts()).toHaveLength(1);
  }, 120_000);
});
