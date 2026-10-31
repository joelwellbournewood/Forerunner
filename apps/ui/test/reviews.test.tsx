import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { gradeTone, trendPoints, verdictTone } from "../src/pages/project/ReviewsTab.tsx";
import { createHarness, renderApp } from "./helpers.tsx";

describe("Reviews tab", () => {
  it("tones grades and verdicts and maps the trend", () => {
    expect(gradeTone(82)).toBe("good");
    expect(gradeTone(64)).toBe("warn");
    expect(gradeTone(30)).toBe("bad");
    expect(verdictTone("accept")).toBe("good");
    expect(verdictTone("revise")).toBe("warn");
    expect(verdictTone("human")).toBe("bad");
    expect(
      trendPoints([
        {
          at: "2026-10-19T19:50:00.000Z",
          grade: 82,
          reviewId: "a",
          taskId: null,
          verdict: "accept",
        },
        {
          at: "2026-10-19T21:00:00.000Z",
          grade: 64,
          reviewId: "b",
          taskId: null,
          verdict: "revise",
        },
      ]).map((p) => p.value),
    ).toEqual([82, 64]);
  });

  it("shows the reviews newest first with findings, the counts and the grade trend", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/reviews");
    const panel = await screen.findByTestId("reviews");
    expect(within(panel).getByTestId("reviews-count")).toHaveTextContent("3 reviews");
    expect(within(panel).getByTestId("open-findings")).toHaveTextContent("1 open finding");
    expect(within(panel).getByTestId("average-grade")).toHaveTextContent("average 73.7");
    const trend = within(panel).getByTestId("grade-trend");
    expect(within(trend).getAllByTestId("trend-point")).toHaveLength(3);
    expect(within(trend).getByTestId("trend-target")).toHaveTextContent("accept line 70");
    const rows = within(panel).getAllByTestId("review");
    expect(rows.map((r) => r.dataset.reviewId)).toEqual(["rev_0", "rev_2", "rev_1"]);
    const revise = rows[1];
    if (!revise) throw new Error("no review");
    expect(within(revise).getByTestId("review-grade")).toHaveTextContent("64 / 100");
    // Plain words for the verdict and the tier (U-074).
    expect(within(revise).getByTestId("review-verdict")).toHaveTextContent("sent back");
    expect(revise).toHaveTextContent("confidence 80%");
    expect(revise).toHaveTextContent("Add the search box to the header");
    const finding = within(revise).getByTestId("finding");
    expect(finding).toHaveAttribute("data-severity", "high");
    expect(finding).toHaveAttribute("data-status", "open");
    expect(finding).toHaveTextContent("Debounce the input");
    await user.selectOptions(within(panel).getByTestId("filter-verdict"), "accept");
    await waitFor(() => expect(within(panel).getAllByTestId("review")).toHaveLength(2));
  });

  it("degrades to the route-missing state on a daemon without reviews", async () => {
    renderApp(
      "/projects/proj_atlas/reviews",
      createHarness({ missingRoutes: ["/projects/proj_atlas/reviews"] }),
    );
    const missing = await screen.findByTestId("route-missing");
    expect(missing).toHaveAttribute("data-route", "reviews");
    expect(missing).toHaveTextContent("GET /projects/:id/reviews");
  });
});
