import { expect, test } from "@playwright/test";
import { daemonUrl, holdSessions, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("home renders the shell, connects to the daemon and shows two projects", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("header")).toBeVisible();
  // Design §3.1: no red Stop all while nothing runs.
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("kill-switch")).toHaveCount(0);
  await expect(page.getByTestId("connection-status")).toHaveText(/connected/);
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("active-project")).toContainText("Atlas");
  // Design §3.8: the badge counts every card that needs you (the fixtures have two open).
  await expect(page.getByTestId("inbox-badge")).toHaveText("2");
  // Design §3.2: one row per project with its status sentence and progress; no spend bar,
  // no critic grade.
  const atlas = page.getByTestId("project-card").first();
  await expect(atlas.getByTestId("project-status")).toHaveText("Waiting for you: 2 questions");
  await expect(atlas.getByTestId("progress")).toHaveText("1 of 3 done");
  await expect(atlas.getByTestId("spend-bar")).toHaveCount(0);
  await expect(page.getByTestId("home-card")).toHaveCount(2);
});

test("sessions stopped: the bar says so, and Allow sessions again lets them start (design §3.1)", async ({
  page,
  request,
}) => {
  await request.post(`http://127.0.0.1:${process.env.FORERUNNER_UI_FAKE_PORT}/kill`, {
    headers: { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` },
    data: { scope: "all", reason: "browser test" },
  });
  await page.goto("/");
  const bar = page.getByTestId("kill-banner");
  await expect(bar).toContainText("Sessions are stopped.");
  await expect(page.getByTestId("kill-switch")).toHaveCount(0);
  await bar.getByTestId("kill-resume").click();
  await expect(page.getByTestId("kill-banner")).toHaveCount(0);
});

test("the navigation collapses under 768px behind a menu button", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("main-nav")).toBeHidden();
  await page.getByTestId("menu-toggle").click();
  await expect(page.getByTestId("main-nav")).toBeVisible();
  await page.getByTestId("main-nav").getByText("Inbox").click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

// d1109-run-visible (V-2, D8): while a session runs, the run indicator's bar is directly under
// the header on every page and at every width, outside the menu that collapses on a narrow
// window; the tab's title says it runs. Before: a small chip at the header's end and a red
// 'Stop all (1 running)' at the other.
for (const width of [1280, 375])
  test(`a running session shows under the header at ${width} px on Home, the Inbox and Settings`, async ({
    page,
    request,
  }) => {
    await holdSessions(request, true);
    try {
      await request.post(`${daemonUrl()}/sessions`, {
        headers: { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` },
        data: { agentId: "agent_alice", projectId: "proj_atlas" },
      });
      await page.setViewportSize({ width, height: 800 });
      for (const route of ["/", "/inbox", "/settings"]) {
        await page.goto(route);
        const bar = page.getByTestId("run-indicator-bar");
        await expect(bar).toBeVisible();
        await expect(bar.getByTestId("run-text")).toContainText("Atlas · ");
        await expect(bar.getByTestId("run-stop")).toBeVisible();
        await expect(page.getByTestId("running-chip")).toHaveCount(0);
        await expect(page).toHaveTitle("● Atlas · Forerunner");
        if (width < 768) await expect(page.getByTestId("main-nav")).toBeHidden();
      }
    } finally {
      await holdSessions(request, false);
    }
  });

// l4-starts-sessions (L4-money-208; D8, design §5 rule 10): a person's session waiting to go on
// is said once beside the bar. Live check 4 (LC-C31) showed 'waiting until' three times and
// Cancel three times on the Overview at 1280 and 375 px (the bar, Working now and the header).
for (const width of [1280, 375])
  test(`a waiting session's Overview has one Cancel outside the bar at ${width} px, with no sideways scroll`, async ({
    page,
    request,
  }) => {
    const res = await request.post(`${daemonUrl()}/__test/waiting`, {
      headers: { Authorization: `Bearer ${process.env.FORERUNNER_UI_FAKE_TOKEN ?? ""}` },
      data: {
        projectId: "proj_beacon",
        head: "Waiting until 15:40 (your subscription's limit)",
        view: {
          key: "wait:proj_beacon",
          sessionId: "sess_1",
          projectId: "proj_beacon",
          projectName: "Beacon",
          state: "waiting",
          what: "waiting until 15:40, then it goes on",
          text: "Beacon · waiting until 15:40, then it goes on",
          since: new Date().toISOString(),
          stop: [],
          cancel: true,
          nextProject: null,
          explain: null,
        },
      },
    });
    expect(res.ok()).toBe(true);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/projects/proj_beacon");
    await expect(page.getByTestId("project-status").first()).toHaveText(
      "Waiting until 15:40 (your subscription's limit), then it goes on",
    );
    const bar = page.getByTestId("run-indicator-bar");
    await expect(bar.getByTestId("run-text")).toHaveText(
      "Beacon · waiting until 15:40, then it goes on",
    );
    await expect(bar.getByTestId("run-cancel")).toBeVisible();
    const working = page.getByTestId("overview-working");
    await expect(working.getByTestId("run-cancel")).toBeVisible();
    await expect(working.getByTestId("run-cancel-explain")).toHaveText(
      "Cancel: nothing starts when Claude is back; its tasks wait for your Start.",
    );
    // Every Cancel on the page: the bar's and Working now's, none on the header's line.
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(2);
    await expect(
      page.getByTestId("project-header").getByRole("button", { name: "Cancel" }),
    ).toHaveCount(0);
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll.width).toBeLessThanOrEqual(scroll.client);
  });
