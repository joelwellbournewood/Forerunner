// V7: the Reviews tab (under More) of the Clamp lib project: no 'Doc drift: none' finding.
"use strict";
const fs = require("node:fs");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("reviews-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/clamp-pid.txt`, "utf8").trim();
(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await page.goto(`${ui()}/projects/${pid}`);
    await sleep(2000);
    await page.getByTestId("tab-more").locator("summary").click();
    await sleep(600);
    await page.getByTestId("tab-reviews").click();
    await sleep(2500);
    const t = await R.step(page, "reviews-clamp");
    log("url:", page.url());
    log("has 'Doc drift: none':", /Doc drift: none/i.test(t), "| has 'Doc drift':", /Doc drift/i.test(t));
    log("reviews text:", t.slice(t.indexOf("Overview")).replace(/\n/g, " | ").slice(0, 1500));
  } catch (e) {
    log("ERROR", e.stack);
  } finally {
    await browser.close();
  }
})();
