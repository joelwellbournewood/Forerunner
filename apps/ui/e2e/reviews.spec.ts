import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("reviews tab lists the critic's verdicts with findings and draws the grade trend", async ({
  page,
}) => {
  await page.goto("/projects/proj_atlas/reviews");
  await expect(page.getByTestId("reviews-count")).toHaveText("3 reviews");
  await expect(page.getByTestId("open-findings")).toHaveText("1 open finding");
  await expect(page.getByTestId("grade-trend").locator("[data-testid=trend-point]")).toHaveCount(3);
  await expect(page.getByTestId("review")).toHaveCount(3);
  const revise = page.getByTestId("review").filter({ hasText: "Add the search box" });
  await expect(revise.getByTestId("review-grade")).toHaveText("64 / 100");
  // The critic's call in plain words (U-074).
  await expect(revise.getByTestId("review-verdict")).toHaveText("sent back");
  await expect(revise.getByTestId("finding")).toHaveAttribute("data-severity", "high");
  await page.getByTestId("filter-verdict").selectOption("accept");
  await expect(page.getByTestId("review")).toHaveCount(2);
});
