import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatBytes, formatMs, formatShare } from "../src/lib/format.ts";
import { measuredAgainstTarget, targetLabel } from "../src/pages/PerformancePage.tsx";
import { PERFORMANCE } from "./fixtures.ts";
import { createHarness, renderApp } from "./helpers.tsx";

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

  it("compares the right percentile with each mode's target", () => {
    const [voice, text, routing, , coder] = PERFORMANCE.modes;
    if (!voice || !text || !routing || !coder) throw new Error("fixture");
    expect(targetLabel(voice)).toBe("first audio under 1.2 s");
    expect(targetLabel(text)).toBe("first token under 1.0 s");
    expect(targetLabel(routing)).toBe("under 3.0 s");
    expect(targetLabel(coder)).toBe("set by task budget and timeout");
    expect(measuredAgainstTarget(text)).toBe(1350);
    expect(measuredAgainstTarget(routing)).toBe(3400);
    expect(measuredAgainstTarget(coder)).toBeNull();
  });

  it("shows every mode against its target with the within-target share, and the estimate accuracy", async () => {
    renderApp("/performance");
    const table = await screen.findByTestId("performance-modes");
    const rows = within(table).getAllByTestId("performance-mode");
    expect(rows).toHaveLength(8);
    const text = rows.find((r) => r.dataset.mode === "text_chat");
    if (!text) throw new Error("no text chat row");
    expect(within(text).getByTestId("ttft")).toHaveTextContent("420 ms / 1.4 s");
    expect(within(text).getByTestId("total")).toHaveTextContent("2.1 s / 4.8 s");
    expect(text).toHaveTextContent("90%");
    expect(within(text).getByTestId("target-bar")).toHaveAttribute("data-met", "false");
    const critic = rows.find((r) => r.dataset.mode === "critic_t1");
    if (!critic) throw new Error("no critic row");
    expect(within(critic).getByTestId("target-bar")).toHaveAttribute("data-met", "true");
    expect(within(critic).getByTestId("target-bar")).toHaveTextContent("met");
    const voice = rows.find((r) => r.dataset.mode === "voice_chat");
    if (!voice) throw new Error("no voice row");
    expect(within(voice).getByTestId("target-bar")).toHaveTextContent("no sample");
    const coder = rows.find((r) => r.dataset.mode === "coder");
    if (!coder) throw new Error("no coder row");
    expect(within(coder).getByTestId("target-bar")).toHaveTextContent("by task");
    expect(screen.getByTestId("estimates-overall")).toHaveTextContent("21.5%");
    expect(screen.getByTestId("estimates-overall")).toHaveTextContent("+8.2%");
    expect(screen.getByTestId("estimates-rows")).toHaveTextContent("researcher");
  });

  it("names the missing route when the daemon has no performance view", async () => {
    renderApp("/performance", createHarness({ missingRoutes: ["/performance"] }));
    const missing = await screen.findByTestId("route-missing");
    expect(missing).toHaveTextContent("GET /performance");
    // Estimates still load: that route exists.
    expect(await screen.findByTestId("estimates-overall")).toHaveTextContent("12");
  });
});
