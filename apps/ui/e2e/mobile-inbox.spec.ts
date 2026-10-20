import { devices, expect, test } from "@playwright/test";
import {
  fakeState,
  injectAndroidShell,
  pairPhone,
  resetState,
  stateCalls,
} from "./mobile-helpers.ts";

test.use({ ...devices["Pixel 7"] });

test.beforeEach(async ({ page, request }) => {
  await resetState(request);
  await injectAndroidShell(page);
});

test("approve a request from the phone: blocking first, the answer is signed; high risk asks for biometrics", async ({
  page,
  request,
}) => {
  await pairPhone(page, request);
  await page.getByTestId("m-nav").getByText("Inbox").click();
  const requests = page.getByTestId("m-request");
  await expect(requests).toHaveCount(3);
  await expect(requests.nth(0)).toHaveAttribute("data-blocking", "true");
  await expect(requests.nth(0)).toHaveAttribute("data-request-id", "req_merge");
  await requests.nth(0).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("m-request")).toHaveCount(2);
  await expect(page.getByTestId("m-blocking-count")).toHaveText("0 blocking");
  let calls = await stateCalls(request);
  const approve = calls.find((c) => c.path === "/requests/req_merge/answer");
  expect(approve).toMatchObject({
    signed: true,
    biometric: false,
    body: { version: 1, answer: "Approve" },
  });

  // High risk: the simulated prompt stands in for the platform biometric; cancel sends nothing.
  const high = page.getByTestId("m-request").filter({ has: page.getByTestId("m-request-high") });
  await expect(high).toHaveCount(1);
  await high.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("m-biometric-dialog")).toBeVisible();
  await page.getByTestId("m-biometric-cancel").click();
  await expect(high.getByTestId("m-request-error")).toContainText("biometric confirmation");
  calls = await stateCalls(request);
  expect(calls.filter((c) => c.path === "/requests/req_cap/answer")).toHaveLength(0);

  await high.getByRole("button", { name: "Confirm" }).click();
  await page.getByTestId("m-biometric-confirm").click();
  await expect(page.getByTestId("m-request")).toHaveCount(1);
  calls = await stateCalls(request);
  const confirm = calls.find((c) => c.path === "/requests/req_cap/answer");
  expect(confirm).toMatchObject({
    signed: true,
    biometric: true,
    body: { version: 1, answer: "Confirm" },
  });
  const state = await fakeState(request);
  expect(state.requests.find((r) => r.id === "req_cap")).toMatchObject({
    status: "answered",
    answer: "Confirm",
  });

  // Messages: a signed read receipt.
  await page.getByTestId("m-mark-read").first().click();
  await expect(page.getByTestId("m-message").first()).toHaveAttribute("data-read", "true");
});
