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
  // Rows in run order, each status in words (design §2, §3.5).
  await expect(page.getByTestId("task-row").nth(2)).toContainText(
    "Add the search box to the header",
  );
  await expect(page.getByTestId("task-row").nth(2)).toContainText("Being reviewed");
  await expect(page.getByTestId("task-row").nth(2)).toContainText("CHF 3.60");
  await page.getByTestId("filter-status").selectOption({ label: "Ready" });
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  // The filter lives in the address.
  await expect(page).toHaveURL(/status=ready/);
});

test("Redo says what it does, posts the action with the note, and Undo puts it back (design §3.5)", async ({
  page,
  request,
}) => {
  await page.goto("/projects/proj_atlas/tasks");
  const row = page.locator('[data-testid="task-row"][data-task-id="task_1"]');
  // A done task offers Redo only; none of the removed state-graph moves anywhere.
  await expect(row.getByTestId(/^action-/)).toHaveText(["Redo"]);
  await expect(page.getByTestId("task-table")).not.toContainText("Mark failed");
  await expect(page.getByTestId("task-table")).not.toContainText("Needs me");
  await row.getByTestId("action-redo").click();
  const dialog = page.getByTestId("action-dialog");
  await expect(dialog).toContainText('Redo "Index the documentation pages"?');
  await expect(dialog.getByTestId("action-explain")).toHaveText(
    "Reopens it; say what is wrong and the next attempt fixes it.",
  );
  await dialog.getByTestId("action-note").fill("The index misses the FAQ page");
  await dialog.getByTestId("confirm-action").click();
  await expect(row.getByTestId("task-status")).toHaveText("Ready");
  const calls = await recordedCalls(request);
  const redo = calls.find((c) => c.path === "/tasks/task_1/action");
  expect(redo?.body).toMatchObject({ action: "redo", note: "The index misses the FAQ page" });
  await page.getByTestId("task-moved-undo").click();
  await expect(row.getByTestId("task-status")).toHaveText("Done");
});

test("a task's title opens its drawer with what it asks for", async ({ page }) => {
  await page.goto("/projects/proj_atlas/tasks");
  await page
    .locator('[data-testid="task-row"][data-task-id="task_2"]')
    .getByTestId("task-title")
    .click();
  const drawer = page.getByTestId("task-drawer");
  await expect(drawer.getByTestId("drawer-asks")).toContainText(
    "Typing in the header searches the index.",
  );
  await expect(drawer.getByTestId("drawer-review")).toContainText(
    "The critic sent it back for changes.",
  );
  await expect(page).toHaveURL(/task=task_2/);
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
