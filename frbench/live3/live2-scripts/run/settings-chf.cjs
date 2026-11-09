const L = require("./lib.cjs");
const { R, goto, save } = L;
const NAME = process.argv[2] || "run-live";
(async () => {
  const { browser, page } = await R.openApp(NAME, { profile: false });
  const out = {};
  try {
    await goto(page, NAME, "/settings", 3000);
    const adv = page.getByTestId("settings-advanced-summary");
    if (await adv.count()) { await adv.first().click(); await page.waitForTimeout(1500); }
    for (const d of await page.locator("details:not([open]) > summary").all()) { await d.click().catch(() => undefined); }
    await page.waitForTimeout(1500);
    const shotDir = R.bench(NAME).steps + "/watch";
    await page.screenshot({ path: `${shotDir}/settings-all-open.png`, fullPage: true });
    const txt = await page.evaluate(() => document.body.innerText);
    require("fs").writeFileSync(`${shotDir}/settings-all-open.txt`, txt);
    out.usdLines = txt.split("\n").filter((l) => /USD|\$/.test(l));
    out.chfLines = txt.split("\n").filter((l) => /CHF/.test(l)).slice(0, 40);
  } finally { save(NAME, "settings-chf.json", out); await browser.close(); }
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
})();
