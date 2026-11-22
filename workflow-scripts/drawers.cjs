// Open each named task's drawer, expand 'See what was checked', record the step.
"use strict";
const L = require("./lc.cjs");
const { R, N, sleep } = L;
const [PID, prefix, ...titles] = process.argv.slice(2);
const log = L.logTo(`${prefix}-drawers-log.txt`);
(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    for (const [i, title] of titles.entries()) {
      await L.openDrawer(page, PID, title);
      const opened = await L.seeWhatWasChecked(page);
      const text = await R.step(page, `${prefix}-drawer-${i + 1}`);
      const shots = await page.getByTestId("evidence-screenshot").count();
      const imgs = await page.locator('[data-testid="evidence-screenshot"] img, img[data-testid="evidence-screenshot"]').count();
      const natural = await page
        .locator('[data-testid="evidence-screenshot"] img, img[data-testid="evidence-screenshot"]')
        .evaluateAll((els) => els.map((e) => `${e.naturalWidth}x${e.naturalHeight}`));
      if (shots) {
        await page.getByTestId("evidence-screenshot").first().scrollIntoViewIfNeeded();
        await sleep(800);
        await page.screenshot({ path: `${L.STEPS}/${prefix}-drawer-${i + 1}-screenshots-view.png` });
      }
      const i0 = text.indexOf("Review");
      log(`== ${title}: see-what-was-checked opened=${opened}, screenshots=${shots}, imgs=${imgs} ${natural.join(",")}`);
      log(text.slice(Math.max(0, i0 - 200), i0 + 2500).replace(/\n/g, " | "));
      await page.keyboard.press("Escape");
      await sleep(500);
    }
  } catch (e) {
    log("ERROR", e.stack);
  } finally {
    await browser.close();
  }
})();
