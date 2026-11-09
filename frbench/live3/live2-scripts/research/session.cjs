// Session page with Details on; prints log lines.
const { R, N, log, text, goto, enc, save } = require("./h.cjs");
const [SID, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, `/sessions/${enc(SID)}`);
    await page.waitForTimeout(1500);
    const a = await R.step(page, `${LABEL}-session`, { fullPage: true });
    console.log("=== SESSION\n" + a.split("\n").filter(Boolean).slice(12).join("\n").slice(0, 3000));
    const det = page.getByLabel("Details");
    if (await det.count()) { await det.check(); await page.waitForTimeout(1200); }
    const b = await R.step(page, `${LABEL}-session-details`, { fullPage: true });
    console.log("=== DETAILS\n" + b.split("\n").filter(Boolean).slice(12).join("\n").slice(0, 8000));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
