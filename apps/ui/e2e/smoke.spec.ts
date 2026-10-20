import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("home renders the shell, connects to the daemon and shows two projects", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("header")).toBeVisible();
  await expect(page.getByTestId("kill-switch")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveText(/connected/);
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("active-project")).toContainText("Atlas");
  await expect(page.getByTestId("inbox-badge")).toHaveText("1");
  const atlas = page.getByTestId("project-card").first();
  await expect(atlas.getByTestId("spend-bar")).toContainText("CHF 25.00 of CHF 100.00");
  await expect(atlas.getByTestId("critic-grade")).toHaveText("82 / 100");
});

test("kill switch stops everything, then resumes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await page.getByTestId("kill-switch").click();
  await expect(page.getByTestId("kill-switch")).toHaveText("Resume");
  await expect(page.getByTestId("kill-banner")).toBeVisible();
  await page.getByTestId("kill-switch").click();
  await expect(page.getByTestId("kill-switch")).toHaveText("Stop all");
});

test("the navigation collapses under 768px behind a menu button", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("main-nav")).toBeHidden();
  await page.getByTestId("menu-toggle").click();
  await expect(page.getByTestId("main-nav")).toBeVisible();
  await page.getByTestId("main-nav").getByText("Inbox").click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});
