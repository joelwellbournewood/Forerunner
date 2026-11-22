"use strict";
const fs = require("node:fs");
const L = require("./lc.cjs");
const { R, N, sleep } = L;
const log = L.logTo("c2b-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    for (const b of ["1.50", "1.20", "2.00"]) {
      const dlg = await L.openStart(page, pid, b);
      const text = await dlg.innerText();
      await R.step(page, `club-05-start-dialog-${b}`);
      log(`start dialog (budget ${b}):`, text.replace(/\n/g, " | ").slice(0, 1200));
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await sleep(800);
    }
  } catch (e) {
    log("ERROR", e.stack);
  } finally {
    await browser.close();
  }
})();
