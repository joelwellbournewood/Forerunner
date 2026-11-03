import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("the command palette switches the active project", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("active-project")).toContainText("Atlas");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-input").fill("switch beacon");
  await expect(page.getByTestId("command-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/proj_beacon\/summary$/);
  await expect(page.getByTestId("active-project")).toContainText("Beacon");

  // The choice survives a reload (persisted per install).
  await page.goto("/");
  await expect(page.getByTestId("active-project")).toContainText("Beacon");
});

test("keyboard shortcuts navigate and the theme override applies", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  // The fixture's 18 (U-078 added "When my first choice runs out mid-session" and "Code tasks
  // that need commands"), Beacon's autonomy (the daemon lists every project's rows) and Atlas's
  // Status pull request (a project on a host repository, C-57), less the three that change
  // nothing (design §6: not listed).
  await expect(page.getByTestId("setting-row")).toHaveCount(17);
  // Settings opens on Basics; the theme is under Advanced (design §6).
  await expect(page.getByTestId("settings-basics")).toBeVisible();
  await expect(page.getByTestId("theme-select")).toBeHidden();
  await page.getByTestId("settings-advanced-summary").click();
  await page.getByTestId("theme-select").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Shift+?");
  await expect(page.getByTestId("shortcuts-help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts-help")).toHaveCount(0);
});
