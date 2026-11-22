// Undo my script's mistake: the bakery answers went to the Garden club Contact card; cancel that
// task from its Tasks row so it does not run (and spend) on wrong answers.
"use strict";
const fs = require("node:fs");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("cancel-contact-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    const row = page.getByTestId("task-row").filter({ has: page.getByTestId("task-title").getByText("Contact page in contact.html", { exact: true }) });
    log("row:", (await row.innerText()).replace(/\n/g, " | "));
    await row.getByTestId("action-cancel").click();
    await sleep(600);
    log("dialog:", (await page.getByRole("dialog").innerText()).replace(/\n/g, " | "));
    await page.getByTestId("confirm-action").click();
    await sleep(2500);
    log("line:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    await R.step(page, "cancel-contact-after");
  } catch (e) {
    log("ERROR", e.stack);
  } finally {
    await browser.close();
  }
})();
