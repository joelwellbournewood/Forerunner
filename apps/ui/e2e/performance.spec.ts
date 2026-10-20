import { expect, test } from "@playwright/test";
import { resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("performance view shows every mode against its target", async ({ page }) => {
  await page.goto("/performance");
  await expect(page.getByTestId("performance-mode")).toHaveCount(8);
  const text = page.getByTestId("performance-mode").filter({ hasText: "Text chat" });
  await expect(text).toContainText("first token under 1.0 s");
  await expect(text.getByTestId("ttft")).toHaveText("420 ms / 1.4 s");
  await expect(text.getByTestId("target-bar")).toHaveAttribute("data-met", "false");
  const critic = page.getByTestId("performance-mode").filter({ hasText: "Critic tier 1" });
  await expect(critic.getByTestId("target-bar")).toHaveAttribute("data-met", "true");
  await expect(page.getByTestId("estimates-overall")).toContainText("21.5%");
  await page.getByTestId("performance-project").selectOption("proj_atlas");
  await expect(page.getByTestId("performance-mode")).toHaveCount(8);
});
