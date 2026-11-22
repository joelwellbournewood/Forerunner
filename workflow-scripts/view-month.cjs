const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");
const NAME = "review-budget-stop";
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const projects = await R.api(NAME, "GET", "/projects");
  const p = projects.find((x) => /Review month cap \(n\)/.test(x.name));
  const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(p.id)}`);
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(p.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, "v tasks month");
    await page.getByText("Write the manual").first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "v drawer month");
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, "v inbox month");
    await page.goto(`${b.uiUrl}/sessions/${enc(sessions[0].id)}`);
    await page.waitForTimeout(2000);
    await R.step(page, "v session month");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
