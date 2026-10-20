import { devices, expect, test } from "@playwright/test";
import {
  fakeState,
  injectAndroidShell,
  pairPhone,
  resetState,
  startPairing,
} from "./mobile-helpers.ts";

test.use({ ...devices["Pixel 7"] });

test.beforeEach(async ({ page, request }) => {
  await resetState(request);
  await injectAndroidShell(page);
});

test("the Android shell lands on pairing; a typed code pairs the phone and Home shows the projects", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pair this phone" })).toBeVisible();
  await expect(page.getByTestId("m-pair-no-scanner")).toBeVisible();
  await expect(page.getByTestId("m-pair-url")).toHaveValue(/127\.0\.0\.1/);
  await page.getByTestId("m-pair-code").fill("ZZZZ9999");
  await page.getByTestId("m-pair-submit").click();
  await expect(page.getByTestId("m-pair-error")).toContainText("Pairing failed");

  const code = await startPairing(request);
  await page.getByTestId("m-pair-code").fill(code.toLowerCase());
  await page.getByTestId("m-pair-name").fill("Pixel of J");
  await page.getByTestId("m-pair-submit").click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByTestId("m-project-card")).toHaveCount(3);
  await expect(page.getByTestId("m-waiting").first()).toHaveText("2 waiting on you");
  await expect(page.getByTestId("m-active-project")).toHaveText("PharmaWatch");
  await expect(page.getByTestId("m-inbox-badge")).toHaveText("1");
  await expect(page.getByTestId("m-sync")).toHaveText(/live|polling/);
  const state = await fakeState(request);
  expect(state.devices).toHaveLength(1);
  expect(state.devices[0]?.name).toBe("Pixel of J");

  // The session survives a reload (token in the secure store, config in storage).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
});

test("settings shows the sync status and the push stand-in; forgetting the device returns to pairing", async ({
  page,
  request,
}) => {
  await pairPhone(page, request);
  await page.getByTestId("m-nav").getByText("Settings").click();
  await expect(page.getByTestId("m-sync-status")).toHaveText(/live|polling/);
  await expect(page.getByTestId("m-push-mode")).toContainText("FCM not configured");
  await expect(page.getByTestId("m-device-id")).toContainText("dev_");
  await page.getByTestId("m-forget").click();
  await page.getByTestId("m-forget-confirm").click();
  await expect(page.getByRole("heading", { name: "Pair this phone" })).toBeVisible();
  const state = await fakeState(request);
  expect(state.devices[0]?.revoked).toBe(false);
});
