import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("opening a project shows the tabs; the tasks tab lists the tasks", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("project-card").first().getByRole("link", { name: "Atlas" }).click();
  await expect(page).toHaveURL(/\/projects\/proj_atlas\/summary$/);
  await expect(page.getByTestId("summary")).toContainText("Indexed the docs");
  await page.getByTestId("tab-tasks").click();
  await expect(page).toHaveURL(/\/projects\/proj_atlas\/tasks$/);
  await expect(page.getByTestId("task-row")).toHaveCount(3);
  await expect(page.getByTestId("task-row").nth(1)).toContainText(
    "Add the search box to the header",
  );
  await expect(page.getByTestId("task-row").nth(1)).toContainText("CHF 3.60");
  await page.getByTestId("filter-status").selectOption("ready");
  await expect(page.getByTestId("task-row")).toHaveCount(1);
});

test("a task transition asks for a reason and posts it", async ({ page, request }) => {
  await page.goto("/projects/proj_atlas/tasks");
  const ready = page.getByTestId("task-row").nth(2);
  await ready.getByTestId("transition-claimed").click();
  await page.getByTestId("transition-reason").fill("taking it myself");
  await page.getByTestId("confirm-transition").click();
  await expect(page.getByTestId("task-row").nth(2)).toHaveAttribute("data-status", "claimed");
  const calls = await recordedCalls(request);
  const move = calls.find((c) => c.path === "/tasks/task_3/transition");
  expect(move?.body).toEqual({ version: 1, to: "claimed", reason: "taking it myself" });
});

test("the plan tab shows the timeline, milestones and graph; the reviews tab is filled", async ({
  page,
}) => {
  await page.goto("/projects/proj_atlas/plan");
  await expect(page.getByTestId("milestone-list")).toContainText("Search works");
  await expect(page.getByTestId("milestone-timeline")).toBeVisible();
  await expect(page.getByTestId("dependency-graph")).toBeVisible();
  await page.getByTestId("tab-costs").click();
  await expect(page.getByTestId("cost-total")).toHaveText("CHF 25.00");
  await expect(page.getByTestId("cost-savings")).toContainText("Savings (not spend)");
  await page.getByTestId("tab-reviews").click();
  await expect(page.getByTestId("reviews-count")).toHaveText("3 reviews");
  await expect(page.getByTestId("placeholder")).toHaveCount(0);
});
