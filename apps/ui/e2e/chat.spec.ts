import { expect, test } from "@playwright/test";
import { nextChatTurn, recordedCalls, resetDaemon } from "./helpers.ts";

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
  // Design §3.9: no "first token" badge under a reply.
  await expect(firstReply).not.toContainText("first token");

  await input.fill("please start a session");
  await page.getByTestId("chat-send").click();
  const confirmation = page.getByTestId("pending-confirmation");
  await expect(confirmation).toContainText(
    "You want to start a session with a budget of CHF 4.00.",
  );
  await confirmation.getByTestId("confirm-yes").click();
  await expect(page.getByTestId("pending-confirmation")).toHaveCount(0);
  await expect(page.getByTestId("chat-agent").nth(2)).toContainText(
    "Started a session on Atlas (up to CHF 5.00).",
  );
  // The turn links the session the start began (phase E), as the daemon's conversation does.
  await expect(page.getByTestId("chat-session-link")).toHaveText("Open the session");
  await expect(page.getByTestId("chat-session-link")).toHaveAttribute("href", /^\/sessions\/sess_/);
  const calls = (await recordedCalls(request)).filter((c) => c.path === "/chat/stream");
  expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
    "what happened last session?",
    "please start a session",
    "yes",
  ]);

  await page.getByTestId("chat-human").first().getByTestId("make-task").click();
  const dialog = page.getByTestId("new-task-dialog");
  await expect(dialog.getByTestId("task-title")).toHaveValue("what happened last session?");
  await dialog.getByTestId("create-task").click();
  await expect(page.getByTestId("task-created")).toContainText("Task created");
  await expect(page.getByTestId("task-created")).not.toContainText("Draft");
  // "Make this a task" makes a ready task, which the next session works on (U-016, ADR 0093).
  const created = (await recordedCalls(request)).find(
    (c) => c.path === "/projects/proj_atlas/tasks",
  );
  expect(created?.body).toMatchObject({ status: "ready" });
});

// d1109-chat-depth: while an answer is made the bubble says what chat is doing, Send is Stop, and
// Stop ends the answer with what it cost (the owner's words: "There should be something
// indicating what the chat is doing when waiting").
test("the waiting line names the step, Send becomes Stop, and Stop ends the answer", async ({
  page,
  request,
}) => {
  await page.goto("/projects/proj_atlas/chat");
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await nextChatTurn(request, { steps: [{ text: "Reading the last session…" }], hold: true });
  await input.fill("what did the last session do?");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-waiting")).toContainText("Reading the last session…");
  const stop = page.getByTestId("chat-stop");
  await expect(stop).toHaveAttribute(
    "title",
    "Stops this answer. Changes it already made stay, each with Undo.",
  );
  await expect(page.getByTestId("chat-send")).toHaveCount(0);
  await expect(page.getByTestId("chat-waiting")).toContainText(/ · \d+ s$/, { timeout: 10_000 });
  await stop.click();
  await expect(page.getByTestId("chat-footer")).toHaveText(
    "You stopped this answer: under CHF 0.01 spent.",
  );
  await expect(page.getByTestId("chat-send")).toBeVisible();
  const stops = (await recordedCalls(request)).filter((c) =>
    /^\/chat\/turns\/[^/]+\/stop$/.test(c.path),
  );
  expect(stops).toHaveLength(1);
});
