import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/daemon/views.ts";

/** Session log lines for the events added with U-013 and U-017. */
describe("session log lines", () => {
  it("says when a session put claimed tasks back to ready (U-013)", () => {
    expect(describeEvent("task.claims_released", { count: 2 })).toBe(
      "Put 2 task(s) back to ready: their claim had lapsed or no agent held it.",
    );
  });

  it("shows the critic's measurements once, apart from the review line (U-017)", () => {
    expect(
      describeEvent("critic.session_review_metrics", {
        metrics: {
          plannedTasks: 1,
          plannedDoneTasks: 0,
          actualUsdMicro: 0,
          estimateUsdMicro: 204_400,
        },
      }),
    ).toBe(
      "Session review measured: 0 of 1 planned task(s) done, 0.00 USD spent of a 0.20 USD estimate.",
    );
  });
});
