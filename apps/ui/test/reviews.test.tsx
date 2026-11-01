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

  it("shows the tasks' reviews newest first with findings, the counts and the grade trend; the session check folded away", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/reviews");
    const panel = await screen.findByTestId("reviews");
    // Design §3.5: the tasks' reviews; the session's self-check is no grade of the work.
    expect(within(panel).getByTestId("reviews-count")).toHaveTextContent("2 reviews");
    expect(within(panel).getByTestId("open-findings")).toHaveTextContent("1 open finding");
    expect(within(panel).getByTestId("average-grade")).toHaveTextContent("average 73");
    const trend = within(panel).getByTestId("grade-trend");
    expect(within(trend).getAllByTestId("trend-point")).toHaveLength(2);
    expect(within(trend).getByTestId("trend-target")).toHaveTextContent("accept line 70");
    const rows = within(panel).getAllByTestId("review");
    expect(rows.map((r) => r.dataset.reviewId)).toEqual(["rev_2", "rev_1", "rev_0"]);
    expect(within(panel).getByTestId("session-checks")).toContainElement(rows[2] as HTMLElement);
    expect(within(panel).getByTestId("session-checks")).not.toHaveAttribute("open");
    const revise = rows[0];
    if (!revise) throw new Error("no review");
    expect(within(revise).getByTestId("review-grade")).toHaveTextContent("64 / 100");
    // Plain words for the verdict and the level (U-074); the grade in the verdict's colour.
    expect(within(revise).getByTestId("review-verdict")).toHaveTextContent("sent back");
    expect(within(revise).getByTestId("review-grade").className).not.toMatch(/emerald/);
    expect(revise).toHaveTextContent("Add the search box to the header");
    const finding = within(revise).getByTestId("finding");
    expect(finding).toHaveAttribute("data-severity", "high");
    expect(finding).toHaveAttribute("data-status", "open");
    expect(within(finding).getByTestId("finding-state")).toHaveTextContent("to fix");
    expect(finding).toHaveTextContent("Debounce the input");
    // The critic's confidence, model and evidence are under Details.
    const details = within(revise).getByTestId("review-details");
    expect(details).toHaveTextContent("confidence 80%");
    expect(details).toHaveTextContent("light review; confidence 80%; sonnet-5.5");
    expect(details.closest("details")).not.toHaveAttribute("open");
    expect(revise).not.toHaveTextContent("tier");
    await user.selectOptions(within(panel).getByTestId("filter-verdict"), "accept");
    await waitFor(() =>
      expect(
        within(panel)
          .getAllByTestId("review")
          .map((r) => r.dataset.reviewId),
      ).toEqual(["rev_1", "rev_0"]),
    );
  });

  it("opens the review a link names (?review=), highlighted; a done task's finding is not open work", async () => {
    renderApp("/projects/proj_atlas/reviews?review=rev_1");
    const panel = await screen.findByTestId("reviews");
    const rows = within(panel).getAllByTestId("review");
    const wanted = rows.find((r) => r.dataset.reviewId === "rev_1") as HTMLElement;
    expect(wanted).toHaveAttribute("data-highlighted", "true");
    expect(rows.filter((r) => r.dataset.highlighted === "true")).toHaveLength(1);
    expect(within(wanted).getByTestId("review-grade").className).toMatch(/emerald/);
    expect(within(wanted).getByTestId("finding-state")).toHaveTextContent("accepted as it is");
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
