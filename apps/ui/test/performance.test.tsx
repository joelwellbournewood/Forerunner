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

  it("shows the project's slider in every mode it reaches, held at the registry's max_effort", async () => {
    const h = createHarness();
    // The slider at quality (+1), as Settings leaves it (settings-slider.test.tsx).
    h.daemon.state.speedQuality.proj_atlas = 1;
    const view = await h.client.performance({ projectId: "proj_atlas" });
    expect(RuntimePerformanceView.safeParse(view).success).toBe(true);
    expect(view.effortOffset).toBe(1);
    const mode = (name: string) => {
      const m = view.modes.find((x) => x.mode === name);
      if (!m) throw new Error(name);
      return m;
    };
    // Chat's low one step up; planning's high to xhigh; the critic's medium to high.
    expect(mode("text_chat")).toMatchObject({ effort: "medium", maxEffort: "medium" });
    expect(mode("planning")).toMatchObject({ effort: "xhigh", maxEffort: "max" });
    expect(mode("critic_t1")).toMatchObject({ effort: "high" });
    // The coder at medium goes to high; a risky task's high stays at the coder's cap, so it adds
    // nothing; the researcher's high is held at its cap.
    expect(mode("coder")).toMatchObject({ effort: "high", riskEffort: null, riskTierFrom: null });
    expect(mode("researcher")).toMatchObject({ effort: "high", maxEffort: "high" });
    // No run reads the slider for routing.
    expect(mode("routing")).toMatchObject({ effort: "low", offsetApplied: false });
    expect(effortLabel(mode("text_chat"))).toBe("medium (table low)");
    // All projects: no slider.
    expect((await h.client.performance()).effortOffset).toBe(0);

    renderApp("/performance", h);
    const table = await screen.findByTestId("performance-modes");
    const coder = within(table)
      .getAllByTestId("performance-mode")
      .find((r) => r.dataset.mode === "coder");
    if (!coder) throw new Error("no coder row");
    expect(within(coder).getByTestId("effort")).toHaveAttribute(
      "title",
      expect.stringContaining("held at high"),
    );
  });

  it("shows the principal's own effort setting (spec D.4) as the base the slider shifts", async () => {
    const h = createHarness();
    h.daemon.state.speedQuality.proj_atlas = 1;
    // What Settings writes through model.settings.set (settings-models.test.tsx).
    const alice = h.daemon.state.modelSettings.agents.find((a) => a.editable);
    const planning = alice?.modes.find((m) => m.mode === "planning");
    const coder = h.daemon.state.modelSettings.specialists.find((x) => x.name === "coder");
    if (!planning || !coder) throw new Error("fixture");
    planning.effort = { value: "low", default: "high", source: "agent", defaultSource: "table" };
    coder.settings.effort = {
      value: "low",
      default: "medium",
      source: "agent",
      defaultSource: "table",
    };
    const view = await h.client.performance({ projectId: "proj_atlas" });
    expect(RuntimePerformanceView.safeParse(view).success).toBe(true);
    const mode = (name: string) => {
      const m = view.modes.find((x) => x.mode === name);
      if (!m) throw new Error(name);
      return m;
    };
    // Planning: the principal's low, one step up medium.
    expect(mode("planning")).toMatchObject({
      baseEffort: "low",
      effortSource: "agent",
      effort: "medium",
    });
    // The coder's low one step up is medium; a risky task still runs at high (held at the cap).
    expect(mode("coder")).toMatchObject({
      baseEffort: "low",
      effortSource: "agent",
      effort: "medium",
      riskEffort: "high",
    });
    expect(mode("text_chat")).toMatchObject({ effortSource: "table", baseEffort: "low" });
    expect(effortLabel(mode("planning"))).toBe("medium (your setting low)");
    expect(effortLabel({ ...mode("planning"), effort: "low" })).toBe("low (your setting)");

    renderApp("/performance", h);
    const table = await screen.findByTestId("performance-modes");
    const row = within(table)
      .getAllByTestId("performance-mode")
      .find((r) => r.dataset.mode === "planning");
    if (!row) throw new Error("no planning row");
    // All projects (the page's default): no slider, the principal's low as set.
    await waitFor(() =>
      expect(within(row).getByTestId("effort")).toHaveTextContent("low (your setting)"),
    );
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
