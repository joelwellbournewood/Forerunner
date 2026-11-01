import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("home renders the shell, connects to the daemon and shows two projects", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("header")).toBeVisible();
  // Design §3.1: no red Stop all while nothing runs.
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("kill-switch")).toHaveCount(0);
  await expect(page.getByTestId("connection-status")).toHaveText(/connected/);
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("active-project")).toContainText("Atlas");
  // Design §3.8: the badge counts every card that needs you (the fixtures have two open).
  await expect(page.getByTestId("inbox-badge")).toHaveText("2");
  // Design §3.2: one row per project with its status sentence and progress; no spend bar,
  // no critic grade.
  const atlas = page.getByTestId("project-card").first();
  await expect(atlas.getByTestId("project-status")).toHaveText("Waiting for you: 2 questions");
  await expect(atlas.getByTestId("progress")).toHaveText("1 of 3 done");
  await expect(atlas.getByTestId("spend-bar")).toHaveCount(0);
  await expect(page.getByTestId("home-card")).toHaveCount(2);
});

test("sessions stopped: the bar says so, and Allow sessions again lets them start (design §3.1)", async ({
  page,
  request,
}) => {
  await request.post(`http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_PORT}/kill`, {
    headers: { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` },
    data: { scope: "all", reason: "browser test" },
  });
  await page.goto("/");
  const bar = page.getByTestId("kill-banner");
  await expect(bar).toContainText("Sessions are stopped.");
  await expect(page.getByTestId("kill-switch")).toHaveCount(0);
  await bar.getByTestId("kill-resume").click();
  await expect(page.getByTestId("kill-banner")).toHaveCount(0);
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
