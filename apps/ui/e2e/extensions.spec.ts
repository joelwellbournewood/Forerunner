import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("extensions: add from the catalog, approve the grant, toggle it off and on", async ({
  page,
  request,
}) => {
  await page.goto("/extensions");
  await expect(page.getByTestId("extension")).toHaveCount(5);
  await expect(page.getByTestId("extensions-pending")).toHaveText("1 waiting for your approval");
  await page.getByTestId("add-extension").click();
  const dialog = page.getByTestId("add-extension-dialog");
  await expect(dialog.getByTestId("catalog-entry")).toHaveCount(4);
  await dialog.getByTestId("catalog-search").fill("linear");
  await expect(dialog.getByTestId("catalog-entry")).toHaveCount(1);
  await dialog.getByTestId("catalog-add").click();
  await expect(page.getByTestId("extensions-notice")).toContainText("waits for your approval");
  const linear = page.getByTestId("extension").filter({ hasText: "Linear" });
  await expect(linear).toHaveAttribute("data-status", "pending_approval");
  await expect(linear.getByTestId("extension-review")).toContainText("needs secret:linear_key");
  await linear.getByTestId("extension-approve").click();
  await expect(linear).toHaveAttribute("data-status", "enabled");
  await linear.getByTestId("extension-toggle").click();
  await expect(linear.getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "false");
  await linear.getByTestId("extension-toggle").click();
  await expect(linear.getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/extensions")?.body).toEqual({ catalogId: "linear" });
  expect(
    calls.filter((c) => /\/extensions\/ext_\d+\/toggle$/.test(c.path)).map((c) => c.body),
  ).toEqual([{ enabled: false }, { enabled: true }]);
  expect(calls.some((c) => /\/extensions\/ext_\d+\/approve$/.test(c.path))).toBe(true);
});

test("extensions: the daemon's extension.changed frame reloads the panel", async ({
  page,
  request,
}) => {
  await page.goto("/extensions");
  await expect(page.getByTestId("extension")).toHaveCount(5);
  await page
    .getByTestId("extension")
    .filter({ hasText: "Slack" })
    .getByTestId("extension-deny")
    .click();
  await expect(page.getByTestId("extension")).toHaveCount(4);
  const calls = await recordedCalls(request);
  expect(calls.some((c) => c.path === "/extensions/ext_slack/deny")).toBe(true);
});
