import { describe, expect, it } from "vitest";
import {
  buildLatencyReport,
  DEFAULT_LATENCY_TARGETS,
  formatLatencyReport,
  medianTotalToFirstAudio,
} from "../src/latency.ts";

describe("latency report", () => {
  it("sums the four stages into the total and flags each against its target", () => {
    const r = buildLatencyReport({
      turn: 1,
      endOfTurnMs: 200,
      finalTranscriptMs: 300,
      modelFirstTokenMs: 500,
      firstAudioMs: 200,
    });
    expect(r.totalToFirstAudioMs).toBe(1200);
    expect(r.withinTarget).toBe(true);
    expect(r.targets).toEqual(DEFAULT_LATENCY_TARGETS);
    expect(r.stages.total.targetMs).toBe(1200);
  });

  it("marks a stage over target and the whole turn as not within target", () => {
    const r = buildLatencyReport({
      turn: 2,
      endOfTurnMs: 200,
      finalTranscriptMs: 650,
      modelFirstTokenMs: 400,
      firstAudioMs: 100,
    });
    expect(r.stages.finalTranscript.withinTarget).toBe(false);
    expect(r.stages.modelFirstToken.withinTarget).toBe(true);
    expect(r.totalToFirstAudioMs).toBe(1350);
    expect(r.stages.total.withinTarget).toBe(false);
    expect(r.withinTarget).toBe(false);
    expect(formatLatencyReport(r)).toContain("final transcript     650ms /  300ms over");
  });

  it("leaves unreached stages null and never claims success for them", () => {
    const r = buildLatencyReport({
      turn: 3,
      endOfTurnMs: 10,
      finalTranscriptMs: 20,
      modelFirstTokenMs: null,
      firstAudioMs: null,
      interrupted: true,
    });
    expect(r.modelFirstTokenMs).toBeNull();
    expect(r.totalToFirstAudioMs).toBeNull();
    expect(r.withinTarget).toBe(false);
    expect(formatLatencyReport(r)).toContain("(interrupted)");
  });

  it("accepts custom targets", () => {
    const r = buildLatencyReport(
      { turn: 1, endOfTurnMs: 50, finalTranscriptMs: 50, modelFirstTokenMs: 50, firstAudioMs: 50 },
      { totalToFirstAudioMs: 100 },
    );
    expect(r.stages.total.withinTarget).toBe(false);
  });

  it("computes the median total across turns", () => {
    const mk = (total: number) =>
      buildLatencyReport({
        turn: 0,
        endOfTurnMs: 0,
        finalTranscriptMs: 0,
        modelFirstTokenMs: 0,
        firstAudioMs: total,
      });
    expect(medianTotalToFirstAudio([])).toBeNull();
    expect(medianTotalToFirstAudio([mk(900), mk(1100), mk(700)])).toBe(900);
    expect(medianTotalToFirstAudio([mk(900), mk(1100)])).toBe(1000);
  });
});
