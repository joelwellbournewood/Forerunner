import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("reviews tab lists the critic's verdicts with findings and draws the grade trend", async ({
  page,
}) => {
  await page.goto("/projects/proj_atlas/reviews");
  // The tasks' reviews (design §3.5); the session's self-check is folded under Session checks.
  await expect(page.getByTestId("reviews-count")).toHaveText("2 reviews");
  await expect(page.getByTestId("open-findings")).toHaveText("1 open finding");
  await expect(page.getByTestId("grade-trend").locator("[data-testid=trend-point]")).toHaveCount(2);
  await expect(page.getByTestId("review")).toHaveCount(3);
  await expect(page.getByTestId("session-checks").getByTestId("review")).toHaveCount(1);
  const revise = page.getByTestId("review").filter({ hasText: "Add the search box" });
  await expect(revise.getByTestId("review-grade")).toHaveText("64 / 100");
  // The critic's call in plain words (U-074); its evidence under Details.
  await expect(revise.getByTestId("review-verdict")).toHaveText("sent back");
  await expect(revise.getByTestId("finding")).toHaveAttribute("data-severity", "high");
  await expect(revise.getByTestId("review-details")).toBeHidden();
  await revise.getByTestId("review-details-toggle").click();
  await expect(revise.getByTestId("review-details")).toContainText("confidence 80%");
  await page.getByTestId("filter-verdict").selectOption("accept");
  await expect(page.getByTestId("review").filter({ hasText: "Add the search box" })).toHaveCount(
    0,
  );
});

test("a review link (?review=) opens the review highlighted", async ({ page }) => {
  await page.goto("/projects/proj_atlas/reviews?review=rev_2");
  const wanted = page.locator('[data-testid="review"][data-review-id="rev_2"]');
  await expect(wanted).toHaveAttribute("data-highlighted", "true");
  await expect(wanted).toBeInViewport();
});
