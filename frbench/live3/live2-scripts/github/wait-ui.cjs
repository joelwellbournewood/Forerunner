// usage: node wait-ui.cjs <path> <regex> <maxSec> <label>
const { R, N, log, text, goto } = require("./h.cjs");
const [P, RE, MAX, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    const t0 = Date.now(); const rx = new RegExp(RE);
    while (Date.now() - t0 < Number(MAX) * 1000) {
      await goto(page, P);
      await page.waitForTimeout(1500);
      const t = await text(page);
      if (rx.test(t)) { log("matched after", Math.round((Date.now() - t0) / 1000), "s:", (t.match(new RegExp(".{0,120}" + RE + ".{0,200}")) || [""])[0]); await R.step(page, LABEL); return; }
      await page.waitForTimeout(12000);
    }
    log("not matched in", MAX, "s"); await R.step(page, LABEL + "-timeout");
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
