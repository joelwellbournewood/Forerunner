import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("updates: the available release shows its changelog; Update and restart applies it", async ({
  page,
  request,
}) => {
  await page.goto("/updates");
  await expect(page.getByTestId("app-state")).toHaveText("available");
  await expect(page.getByTestId("available-update")).toContainText("Update available: 0.2.0");
  await expect(page.getByTestId("changelog")).toContainText("Reviews tab with the grade trend");
  await expect(page.getByTestId("connector-update")).toContainText("GitHub");
  await expect(page.getByTestId("model-update")).toContainText("haiku-5.6");
  await page.getByTestId("update-and-restart").click();
  // The restart.requested frame arrives over the real SSE stream and shows in the header.
  await expect(page.getByTestId("restart-banner")).toContainText("0.1.0-fake → 0.2.0");
  await expect(page.getByTestId("updates-note")).toContainText("Staged 0.2.0");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/updates/apply")?.body).toEqual({ version: "0.2.0" });
  // The fake comes back on the new version at once; the next heartbeat clears the banner.
  await expect(page.getByTestId("restart-banner")).toHaveCount(0, { timeout: 10_000 });
  await page.reload();
  await expect(page.getByTestId("app-version")).toContainText("running 0.2.0");
});

test("updates: the model watch recommendation can be adopted", async ({ page, request }) => {
  await page.goto("/updates");
  await expect(page.getByTestId("model-watch-latest")).toHaveAttribute("data-decision", "pending");
  await page.getByTestId("model-watch-adopt").click();
  await expect(page.getByTestId("updates-note")).toContainText("Model watch: adopted");
  await expect(page.getByTestId("model-watch-latest")).toHaveAttribute("data-decision", "adopted");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/model-watch/reports/mw_2/answer")?.body).toEqual({
    decision: "adopt",
    by: "human_alice",
    adopt: ["rec_1", "rec_2"],
  });
});
