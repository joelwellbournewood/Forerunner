import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("inbox lists blocking requests first and posts the chosen answer", async ({
  page,
  request,
}) => {
  await page.goto("/");
  // Design §3.8: the badge counts every card that needs you, the non-blocking one too.
  await expect(page.getByTestId("inbox-badge")).toHaveText("2");
  await page.getByTestId("main-nav").getByText("Inbox").click();
  const requests = page.getByTestId("request");
  await expect(requests).toHaveCount(2);
  await expect(page.getByTestId("needs-you-heading")).toHaveText("Needs you (2)");
  await expect(requests.nth(0)).toHaveAttribute("data-blocking", "true");
  await expect(requests.nth(1)).toHaveAttribute("data-blocking", "false");
  await expect(requests.nth(0).getByTestId("option")).toHaveCount(3);

  await requests.nth(0).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("request")).toHaveCount(1);
  // The card is replaced by what happened; the counts follow.
  await expect(page.getByTestId("done-line")).toContainText('You answered "Approve".');
  await expect(page.getByTestId("needs-you-heading")).toHaveText("Needs you (1)");
  await expect(page.getByTestId("inbox-badge")).toHaveText("1");
  const calls = await recordedCalls(request);
  const answer = calls.find((c) => c.path === "/requests/req_1/answer");
  expect(answer?.body).toEqual({ version: 1, answer: "Approve" });

  await page.getByTestId("free-text").fill("Dates, please");
  await page.getByTestId("send-free-text").click();
  await expect(page.getByTestId("request")).toHaveCount(0);
  await expect(page.getByTestId("no-requests")).toBeVisible();

  await page.getByTestId("mark-read").first().click();
  await expect(page.getByTestId("message").first()).toHaveAttribute("data-read", "true");
});
