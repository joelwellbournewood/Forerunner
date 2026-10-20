import { expect, test } from "@playwright/test";

test("home renders the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("header")).toBeVisible();
  await expect(page.getByTestId("kill-switch")).toBeVisible();
});
