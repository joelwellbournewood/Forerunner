import { PerformanceView as RuntimePerformanceView } from "@forerunner/runtime/daemon/api-types";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatBytes, formatMs, formatShare } from "../src/lib/format.ts";
import { effortLabel, measuredAgainstTarget, targetLabel } from "../src/pages/PerformancePage.tsx";
import { PERFORMANCE } from "./fixtures.ts";
import { createHarness, renderApp } from "./helpers.tsx";

/**
 * The Performance page (spec D.7, D.19) against the daemon's `GET /performance` shape (the
 * runtime's `PerformanceView`, served by daemon/views.ts `performanceView`): every mode against
 * its target with p50 and p90 by nearest rank, the effort in force, the window.
 */
describe("Performance view", () => {
  it("formats sizes, times and shares", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(48_000_000)).toBe("46 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.2 GB");
    expect(formatMs(420)).toBe("420 ms");
    expect(formatMs(2100)).toBe("2.1 s");
    expect(formatMs(75_000)).toBe("1 min 15 s");
    expect(formatMs(null)).toBe("—");
    expect(formatShare(0.67)).toBe("67%");
    expect(formatShare(null)).toBe("—");
  });

  it("reads the daemon's shape: the fixture is a runtime PerformanceView", () => {
    expect(RuntimePerformanceView.safeParse(PERFORMANCE).success).toBe(true);
  });

  it("compares the p90 of the right figure with each mode's target", () => {
    const [voice, text, routing, planning, coder] = PERFORMANCE.modes;
    if (!voice || !text || !routing || !planning || !coder) throw new Error("fixture");
    expect(targetLabel(voice)).toBe("first audio under 1.2 s");
    expect(targetLabel(text)).toBe("first token under 1.0 s");
    expect(targetLabel(routing)).toBe("under 3.0 s");
    expect(targetLabel(coder)).toBe("set by task budget and timeout");
    expect(measuredAgainstTarget(text)).toBe(1350);
    expect(measuredAgainstTarget(planning)).toBe(75_000);
    expect(measuredAgainstTarget(routing)).toBeNull();
    expect(measuredAgainstTarget(coder)).toBeNull();
  });

  it("names the effort in force and the table's when the project's offset moved it", () => {
    const critic = PERFORMANCE.modes.find((m) => m.mode === "critic_t1");
    if (!critic) throw new Error("fixture");
    expect(effortLabel(critic)).toBe("medium");
    expect(effortLabel({ ...critic, effort: "high" })).toBe("high (table medium)");
    // The effort a risky task raises the mode to (the coder at risk tier 2 and above).
    const coder = PERFORMANCE.modes.find((m) => m.mode === "coder");
    if (!coder) throw new Error("fixture");
    expect(effortLabel(coder)).toBe("medium; high from risk tier 2");
  });

  it("shows every mode against its target with the effort, the share and the last measurement, and the estimate accuracy", async () => {
    renderApp("/performance");
    const table = await screen.findByTestId("performance-modes");
    const rows = within(table).getAllByTestId("performance-mode");
    expect(rows).toHaveLength(8);
    const text = rows.find((r) => r.dataset.mode === "text_chat");
    if (!text) throw new Error("no text chat row");
    expect(within(text).getByTestId("ttft")).toHaveTextContent("420 ms / 1.4 s");
    expect(within(text).getByTestId("total")).toHaveTextContent("2.1 s / 4.8 s");
    expect(within(text).getByTestId("effort")).toHaveTextContent("low");
    expect(within(text).getByTestId("last")).not.toHaveTextContent("—");
    expect(text).toHaveTextContent("90%");
    expect(within(text).getByTestId("target-bar")).toHaveAttribute("data-met", "false");
    const critic = rows.find((r) => r.dataset.mode === "critic_t1");
    if (!critic) throw new Error("no critic row");
    expect(within(critic).getByTestId("target-bar")).toHaveAttribute("data-met", "true");
    expect(within(critic).getByTestId("target-bar")).toHaveTextContent("met");
    expect(within(critic).getByTestId("effort")).toHaveAttribute(
      "title",
      expect.stringContaining("offset applies"),
    );
    const voice = rows.find((r) => r.dataset.mode === "voice_chat");
    if (!voice) throw new Error("no voice row");
    expect(within(voice).getByTestId("target-bar")).toHaveTextContent("no sample");
    expect(within(voice).getByTestId("last")).toHaveTextContent("—");
    const coder = rows.find((r) => r.dataset.mode === "coder");
    if (!coder) throw new Error("no coder row");
    expect(within(coder).getByTestId("target-bar")).toHaveTextContent("by task");
    expect(within(coder).getByTestId("effort")).toHaveTextContent("medium; high from risk tier 2");
    expect(screen.getByTestId("performance-window")).toHaveTextContent("last 7 days");
    expect(screen.getByTestId("performance-recent")).toHaveTextContent("chat");
    expect(screen.getByTestId("estimates-overall")).toHaveTextContent("21.5%");
    expect(screen.getByTestId("estimates-overall")).toHaveTextContent("+8.2%");
    expect(screen.getByTestId("estimates-rows")).toHaveTextContent("researcher");
    // The daemon serves the route: no "route not available" state.
    expect(screen.queryByTestId("route-missing")).toBeNull();
  });

  it("asks the daemon for the window the human picks", async () => {
    const h = createHarness();
    renderApp("/performance", h);
    expect(await screen.findByTestId("performance-window")).toHaveTextContent("last 7 days");
    fireEvent.change(screen.getByTestId("performance-days"), { target: { value: "30" } });
    await waitFor(() =>
      expect(screen.getByTestId("performance-window")).toHaveTextContent("last 30 days"),
    );
    const view = await h.client.performance({ days: 30, projectId: "proj_atlas" });
    expect(view).toMatchObject({ days: 30, projectId: "proj_atlas" });
  });

  it("shows a daemon failure as an error with a retry, not as a missing route", async () => {
    renderApp(
      "/performance",
      createHarness({
        failing: { "/performance": { status: 503, code: "unavailable", message: "store down" } },
      }),
    );
    expect(await screen.findByTestId("error-banner")).toHaveTextContent("store down");
    expect(screen.queryByTestId("route-missing")).toBeNull();
    // Estimates still load: that route exists.
    expect(await screen.findByTestId("estimates-overall")).toHaveTextContent("12");
  });
});
