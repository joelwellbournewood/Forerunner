const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-3/scripts/bench/recorder.cjs");
const n = "fix-d1109-sessions";
(async () => {
  const { projectId, requestId } = await R.createPlannedProject(n, {
    project: "Quote page",
    goal: "A page that shows a quote",
    brief: "Make a small web page that shows a quote of the day, with a stylesheet and a script.",
  });
  console.log("project", projectId, requestId);
  // Approve and start started a session: wait for it.
  const sessions = await R.until(
    async () => {
      const s = await R.api(n, "GET", `/sessions?projectId=${projectId}`);
      return s.filter((x) => !/intake/.test(x.summary)).length >= 1 ? s : null;
    },
    60_000,
    1000,
    "the work session",
  );
  const work = sessions.find((s) => !/intake/.test(s.summary));
  if (work) await R.waitForSession(n, work.id, 300_000).catch((e) => console.log("wait", e.message));
  const all = await R.api(n, "GET", `/sessions?projectId=${projectId}`);
  console.log(
    JSON.stringify(
      all.map((s) => ({ id: s.id, status: s.status, summary: s.summary, statusText: s.statusText, spent: s.spent })),
      null,
      1,
    ),
  );
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  await R.skipSetup(page).catch(() => {});
  await page.goto(`http://127.0.0.1:2182/projects/${projectId}/summary`);
  await page.waitForTimeout(2500);
  console.log(await R.step(page, "before-overview"));
  await page.goto(`http://127.0.0.1:2182/projects/${projectId}/sessions`);
  await page.waitForTimeout(2500);
  console.log("URL after /sessions:", page.url());
  console.log(await R.step(page, "before-sessions-address"));
  await page.getByTestId("tab-more").locator("summary").click().catch(() => {});
  await page.waitForTimeout(500);
  console.log(await R.step(page, "before-more-menu"));
  const planning = all.find((s) => /intake/.test(s.summary));
  if (planning) {
    await page.goto(`http://127.0.0.1:2182/sessions/${planning.id}`);
    await page.waitForTimeout(2500);
    console.log(await R.step(page, "before-planning-session-page"));
  }
  if (work) {
    await page.goto(`http://127.0.0.1:2182/sessions/${work.id}`);
    await page.waitForTimeout(2500);
    console.log(await R.step(page, "before-work-session-page"));
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
