import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("quick chat streams a reply, confirms an action with Yes and turns a message into a task", async ({
  page,
  request,
}) => {
  await page.goto("/projects/proj_atlas/chat");
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill("what happened last session?");
  await page.getByTestId("chat-send").click();
  const firstReply = page.getByTestId("chat-agent").first();
  await expect(firstReply).toHaveAttribute("data-streaming", "false");
  await expect(firstReply).toContainText('Atlas: you asked "what happened last session?"');
  await expect(firstReply).toContainText("first token 420 ms");

  await input.fill("please start a session");
  await page.getByTestId("chat-send").click();
  const confirmation = page.getByTestId("pending-confirmation");
  await expect(confirmation).toContainText(
    "You want to start a session with a budget of CHF 4.00.",
  );
  await confirmation.getByTestId("confirm-yes").click();
  await expect(page.getByTestId("pending-confirmation")).toHaveCount(0);
  await expect(page.getByTestId("chat-agent").nth(2)).toContainText(
    "Confirmed. Starting the session now.",
  );
  const calls = (await recordedCalls(request)).filter((c) => c.path === "/chat/stream");
  expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
    "what happened last session?",
    "please start a session",
    "yes",
  ]);

  await page.getByTestId("chat-human").first().getByTestId("make-task").click();
  const dialog = page.getByTestId("new-task-dialog");
  await expect(dialog.getByTestId("task-title")).toHaveValue("what happened last session?");
  await expect(dialog.getByTestId("task-status")).toHaveValue("draft");
  await dialog.getByTestId("create-task").click();
  await expect(page.getByTestId("task-created")).toContainText("Draft task created");
});
