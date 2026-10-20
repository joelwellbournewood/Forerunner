import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("inbox lists blocking requests first and posts the chosen answer", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("inbox-badge")).toHaveText("1");
  await page.getByTestId("main-nav").getByText("Inbox").click();
  const requests = page.getByTestId("request");
  await expect(requests).toHaveCount(2);
  await expect(requests.nth(0)).toHaveAttribute("data-blocking", "true");
  await expect(requests.nth(1)).toHaveAttribute("data-blocking", "false");
  await expect(requests.nth(0).getByTestId("option")).toHaveCount(3);

  await requests.nth(0).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("request")).toHaveCount(1);
  await expect(page.getByTestId("blocking-count")).toHaveText("0 blocking");
  await expect(page.getByTestId("inbox-badge")).toHaveCount(0);
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
