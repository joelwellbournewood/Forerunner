// Screens of one project's work session(s): person-level, Details, tasks, changes, inbox.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5/scripts/bench/recorder.cjs");
const N = "review-d1109-selftasks-run";
const projectId = process.argv[2];
const label = process.argv[3] ?? "s";
(async () => {
  const { browser, page } = await R.openApp(N);
  const list = await R.api(N, "GET", `/projects/${projectId}/sessions`);
  const rows = (list.rows ?? []).filter((r) => !r.planning);
  console.log(JSON.stringify(rows.map((r) => [r.id, r.working, r.gist, r.endedWords])));
  for (const r of rows) {
    if (r.working) await R.waitForSession(N, r.id, 600_000);
    await page.goto(`${R.bench(N).uiUrl}/sessions/${r.id}`);
    await page.waitForTimeout(2500);
    const t = await R.step(page, `${label}-session-${r.id.slice(-4)}`);
    console.log("--- person level:", t.split("\n").filter((l) => /Split|Added|Dropped|Checked the task list|Changed \d|Left for|Left out|Undo/.test(l)));
    console.log("undo buttons on session page:", await page.getByRole("button", { name: /Undo/ }).count());
    const details = page.getByRole("button", { name: "Details" }).or(page.getByLabel("Details")).or(page.getByText("Details", { exact: true }));
    if (await details.count()) {
      await details.first().click();
      await page.waitForTimeout(1500);
    }
    const d = await R.step(page, `${label}-session-${r.id.slice(-4)}-details`);
    console.log("--- details:", d.split("\n").filter((l) => /Split|Added|Dropped|Checked the task list|Changed \d|Left for|Left out|task check/.test(l)));
  }
  await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/tasks`);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-tasks`);
  await page.goto(`${R.bench(N).uiUrl}/changes`);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-changes`);
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  const ib = await R.step(page, `${label}-inbox`);
  console.log("--- inbox:", ib.split("\n").slice(0, 60).join(" | "));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
