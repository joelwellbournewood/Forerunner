import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("extensions: add from the catalog, confirm the grant in the panel, toggle it off and on (U-026)", async ({
  page,
  request,
}) => {
  await page.goto("/extensions");
  await expect(page.getByTestId("extension")).toHaveCount(6);
  await expect(page.getByTestId("extensions-pending")).toHaveText("1 waiting for your approval");
  await page.getByTestId("add-extension").click();
  const dialog = page.getByTestId("add-extension-dialog");
  await expect(dialog.getByTestId("catalog-entry")).toHaveCount(4);
  await dialog.getByTestId("catalog-search").fill("linear");
  await expect(dialog.getByTestId("catalog-entry")).toHaveCount(1);
  await dialog.getByTestId("catalog-add").click();
  // The confirmation opens in the panel with the change card; nothing goes to the Inbox.
  const confirm = page.getByTestId("grant-dialog");
  await expect(confirm.getByTestId("grant-card")).toContainText("needs secret:linear_key");
  await expect(confirm.getByTestId("grant-card")).toContainText("high risk");
  await expect(confirm.getByTestId("grant-tools")).toContainText("linear.list_issues");
  await confirm.getByTestId("grant-confirm").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("extensions-notice")).toContainText("Linear is added and enabled.");
  const linear = page.getByTestId("extension").filter({ hasText: "Linear" });
  await expect(linear).toHaveAttribute("data-status", "enabled");
  await linear.getByTestId("extension-toggle").click();
  await expect(linear.getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "false");
  await linear.getByTestId("extension-toggle").click();
  await expect(linear.getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/extensions")?.body).toEqual({
    catalogId: "linear",
    confirmIn: "panel",
  });
  expect(
    calls.filter((c) => /\/extensions\/ext_\d+\/toggle$/.test(c.path)).map((c) => c.body),
  ).toEqual([{ enabled: false }, { enabled: true }]);
  expect(calls.find((c) => /\/extensions\/ext_\d+\/approve$/.test(c.path))?.body).toEqual({
    answer: "device",
    deviceId: "device_this_pc",
  });
});

test("extensions: Cancel in the panel's confirmation adds nothing (U-026)", async ({
  page,
  request,
}) => {
  await page.goto("/extensions");
  await expect(page.getByTestId("extension")).toHaveCount(6);
  await page.getByTestId("add-extension").click();
  const dialog = page.getByTestId("add-extension-dialog");
  await dialog.getByTestId("catalog-search").fill("linear");
  await dialog.getByTestId("catalog-add").click();
  const confirm = page.getByTestId("grant-dialog");
  await confirm.getByTestId("grant-cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("extensions-notice")).toContainText("Linear was not added");
  await expect(page.getByTestId("extension")).toHaveCount(6);
  const calls = await recordedCalls(request);
  expect(calls.some((c) => /\/extensions\/ext_\d+\/deny$/.test(c.path))).toBe(true);
  expect(calls.some((c) => c.path.endsWith("/approve"))).toBe(false);
});

test("extensions: the daemon's extension.changed frame reloads the panel", async ({
  page,
  request,
}) => {
  await page.goto("/extensions");
  await expect(page.getByTestId("extension")).toHaveCount(6);
  await page
    .getByTestId("extension")
    .filter({ hasText: "Slack" })
    .getByTestId("extension-deny")
    .click();
  await expect(page.getByTestId("extension")).toHaveCount(5);
  const calls = await recordedCalls(request);
  expect(calls.some((c) => c.path === "/extensions/ext_slack/deny")).toBe(true);
});
