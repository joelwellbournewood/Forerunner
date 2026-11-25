// node shot.cjs <bench> <path> <label>
const R = require(process.env.REPO + "/scripts/bench/recorder.cjs");
(async () => {
  const [name, p, label] = process.argv.slice(2);
  const { browser, page } = await R.openApp(name);
  try {
    await page.goto(`${R.bench(name).uiUrl}${p}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await R.skipSetup(page).catch(() => undefined);
    const text = await R.step(page, label, { settleMs: 3000 });
    console.log(text.slice(0, 2500));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
