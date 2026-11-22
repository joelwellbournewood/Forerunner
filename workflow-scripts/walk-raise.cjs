// Raise the budget on the paused guide's card (today's card), then watch the resumed run.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");
const NAME = "review-budget-stop";
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const projects = await R.api(NAME, "GET", "/projects");
  const p = projects.find((x) => /Review budget \(a\)/.test(x.name));
  const before = await R.api(NAME, "GET", `/sessions?projectId=${enc(p.id)}`);
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    const title = page.getByText('"Write the guide" stopped at its budget of CHF 0.04').first();
    const card = title.locator("xpath=ancestor::*[.//button[normalize-space()='Raise the budget']][1]");
    await card.getByRole("button", { name: "Raise the budget", exact: true }).click();
    await page.waitForTimeout(3000);
    await R.step(page, "x inbox after raise");
    const s = await R.until(
      async () => {
        const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(p.id)}`);
        const fresh = list.filter((x) => !before.some((y) => y.id === x.id));
        return fresh.length && fresh.every((x) => !["running", "planned", "paused"].includes(x.status))
          ? fresh
          : null;
      },
      300_000,
      2000,
      "the raised session to end",
    );
    console.log(JSON.stringify(s.map((x) => ({ status: x.status, summary: x.summary }))));
    await page.goto(`${b.uiUrl}/projects/${enc(p.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, "x tasks after raise");
    await page.getByTestId("task-title").filter({ hasText: "Write the guide" }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "x drawer guide after raise");
    await page.goto(`${b.uiUrl}/sessions/${enc(s[0].id)}`);
    await page.waitForTimeout(2000);
    await R.step(page, "x session after raise");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
