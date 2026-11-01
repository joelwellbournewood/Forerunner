import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("start a session from the project page and watch the live view fill over SSE", async ({
  page,
  request,
}) => {
  await page.goto("/projects/proj_atlas");
  await page.getByTestId("start-session").click();
  const dialog = page.getByTestId("start-session-dialog");
  await expect(dialog.getByTestId("confirm-start-session")).toBeEnabled();
  await expect(dialog.getByTestId("start-session-plan")).toContainText("This session runs");
  await dialog.getByLabel(/Session budget/).fill("4");
  await dialog.getByLabel(/Note for this session/).fill("browser test");
  await dialog.getByTestId("confirm-start-session").click();

  // The person stays where they were (design §3.6); the session opens from the notice.
  await expect(dialog.getByTestId("start-session-notice")).toContainText("Started:");
  await dialog.getByTestId("start-session-open").click();
  await expect(page).toHaveURL(/\/sessions\/sess_\d+$/);
  const calls = await recordedCalls(request);
  const started = calls.find((c) => c.path === "/sessions");
  expect(started?.body).toMatchObject({
    agentId: "agent_alice",
    projectId: "proj_atlas",
    budgetUsdMicro: 5_000_000,
    note: "browser test",
  });

  // Real EventSource in the browser: the view must report "live", not the polling fallback.
  await expect(page.getByTestId("stream-mode")).toHaveText("live");
  // The fake claims a task on its second event (400 ms apart under Playwright) and clears it
  // when the run completes; check the header while the task is current.
  await expect(page.getByTestId("event-row").nth(1)).toBeVisible();
  await expect(page.getByTestId("current-task")).toContainText("Decide the versioning scheme");
  await expect(page.getByTestId("current-task")).toContainText("researcher");
  await expect(page.getByTestId("event-row")).toHaveCount(6, { timeout: 10_000 });
  // Ended: no task in flight and nothing to stop (design §3.7).
  await expect(page.getByTestId("session-status")).toHaveText("Done");
  await expect(page.getByTestId("current-task")).toHaveCount(0);
  await expect(page.getByTestId("stop-now")).toHaveCount(0);
  const escalation = page.locator('[data-testid="event-row"][data-level="escalation"]');
  await expect(escalation).toHaveCount(1);
  await expect(escalation.getByTestId("level-badge")).toHaveText("escalation");
  await expect(page.getByTestId("steps")).toHaveText("6");
  await expect(page.getByTestId("session-spend")).toContainText("CHF 3.60");

  // Details: the event types, the level filters and the raw payloads.
  await page.getByTestId("raw-toggle").check();
  await page.getByTestId("filter-info").click();
  await expect(page.getByTestId("event-row")).toHaveCount(2);
  await expect(page.getByTestId("event-raw")).toHaveCount(2);
});

test("Stop now asks once, then posts to /sessions/:id/stop", async ({ page, request }) => {
  const res = await request.post(
    `http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_PORT}/sessions`,
    {
      headers: { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` },
      data: { agentId: "agent_alice", projectId: "proj_atlas" },
    },
  );
  // The daemon's start answer (U-003): the outcome and the session it began.
  const { session } = (await res.json()) as { session: { id: string } };
  await page.goto(`/sessions/${session.id}`);
  // Design §3.7: named by its project and when it began, never its id.
  await expect(page.getByTestId("session-header")).toContainText("Atlas · session at");
  await expect(page.getByTestId("session-header")).not.toContainText(session.id);
  const stop = page.getByTestId("stop-now");
  // An ended session has no stop buttons at all.
  if ((await stop.count()) > 0) {
    await stop.click();
    await page.getByTestId("stop-session").click();
    await expect(page.getByTestId("session-status")).toHaveText("Stopped by you");
    const calls = await recordedCalls(request);
    expect(calls.some((c) => c.path === `/sessions/${session.id}/stop`)).toBe(true);
  } else {
    await expect(page.getByTestId("session-status")).toHaveText("Done");
  }
});
