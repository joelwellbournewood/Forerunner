"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-7/scripts/bench/recorder.cjs");
const NAME = "review-noise";
const PID = process.argv[2];
const TITLE = process.argv[3];
(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(PID)}/tasks`);
    await page.waitForTimeout(2500);
    await page.getByText(TITLE, { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "c20 drawer");
    const see = page.getByText(/See what was checked/).first();
    if (await see.count()) {
      await see.click();
      await page.waitForTimeout(2000);
    }
    const t = await R.step(page, "c20 drawer evidence");
    const imgs = await page.locator("img").evaluateAll((els) => els.map((e) => ({ src: e.getAttribute("src")?.slice(0, 40), w: e.naturalWidth, alt: e.alt })));
    console.log(JSON.stringify(imgs));
    console.log(t.slice(-1500));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
