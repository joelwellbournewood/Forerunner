// C-73: FORERUNNER_BENCH_PLAN=research with FORERUNNER_WEB_FETCH=off: the plan card's chip.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-8/scripts/bench/recorder.cjs");
const NAME = "review-bench";
(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(b.uiUrl);
    await page.waitForTimeout(2000);
    await R.skipSetup(page);
    await page.getByRole("button", { name: "New project" }).first().click();
    const dlg = page.getByTestId("new-project-dialog");
    await dlg.locator('input[name="name"]').fill("Research notes");
    await dlg.locator('textarea[name="brief"]').fill("A short page about tea");
    await dlg.getByTestId("create-project").click();
    await R.until(
      async () => /approve the plan/i.test(await page.evaluate(() => document.body.innerText)),
      60_000,
    );
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    const lines = await page.getByTestId("intake-task").allInnerTexts();
    console.log(JSON.stringify(lines, null, 1));
    console.log("cannot-run chips:", JSON.stringify(await page.getByTestId("intake-task-cannot-run").allInnerTexts()));
    await R.step(page, "r01 research plan card");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
