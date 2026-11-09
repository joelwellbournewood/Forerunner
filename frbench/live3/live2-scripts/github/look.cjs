// usage: node look.cjs <path> <label> [chars]
const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, process.argv[2]);
    await page.waitForTimeout(Number(process.env.WAIT || 1500));
    const t = await R.step(page, process.argv[3]);
    const s = t.indexOf("Ctrl+K");
    console.log(t.slice(s > 0 ? s + 8 : 0, (s > 0 ? s : 0) + Number(process.argv[4] || 4000)));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
