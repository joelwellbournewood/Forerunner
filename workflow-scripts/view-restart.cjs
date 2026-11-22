const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");
const NAME = "review-budget-stop";
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const projects = await R.api(NAME, "GET", "/projects");
  const p = projects.find((x) => /Review budget \(a\)/.test(x.name));
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(p.id)}/tasks`);
    await page.waitForTimeout(3000);
    await R.step(page, "r tasks after restart");
    await page.getByTestId("task-title").filter({ hasText: "Write the guide" }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "r drawer guide after restart");
  } finally {
    await browser.close();
  }
  const tasks = await R.api(NAME, "GET", `/projects/${enc(p.id)}/tasks`);
  console.log(JSON.stringify(tasks.map((t) => ({ title: t.title, status: t.status, label: t.display?.label }))));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
