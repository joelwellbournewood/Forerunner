// Review walk A2: Approve and start the research plan; the work runs; where did each task run?
const R = require("/home/user/Forerunner/.claude/worktrees/wf_dbd51cc4-c3a-6/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const n = "review-credential-chooser";
const projectId = process.argv[2];
const label = process.argv[3] || "A2";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(n);
  await page.goto(`${R.bench(n).uiUrl}/inbox`);
  await page.waitForSelector('[data-testid="intake-card"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Approve and start", exact: true }).first().click();
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-approved`);
  // Wait for the session to end.
  const sessions = await R.until(
    async () => {
      const s = await R.api(n, "GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
      const list = (Array.isArray(s) ? s : []).filter((x) => x.projectId === projectId);
      return list.length && list.every((x) => !["running", "queued", "starting"].includes(x.status))
        ? list
        : null;
    },
    300000,
    2000,
    "the session to end",
  );
  out.sessions = sessions.map((s) => ({ status: s.status, summary: s.summary }));
  await page.goto(`${R.bench(n).uiUrl}/projects/${projectId}/tasks`);
  await page.waitForTimeout(2000);
  out.tasksText = await R.step(page, `${label}-tasks`);
  await page.goto(`${R.bench(n).uiUrl}/projects/${projectId}`);
  await page.waitForTimeout(2000);
  out.overview = await R.step(page, `${label}-overview`);
  await page.goto(`${R.bench(n).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  out.inbox = await R.step(page, `${label}-inbox`);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.sessions, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}.json`, JSON.stringify(out, null, 1));
  process.exit(1);
});
