const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/setup");
    for (let i = 0; i < 6; i++) {
      const t = await text(page);
      if (/Start using Forerunner/.test(t)) break;
      const nm = page.getByLabel("Your name");
      if (await nm.count() && !(await nm.inputValue())) await nm.fill("Sam Tester");
      const c = page.getByRole("button", { name: /^(Continue)$/ });
      if (await c.count()) { await c.first().click(); await page.waitForTimeout(1000); } else break;
    }
    let t = await R.step(page, "setup-done-step");
    log(t.slice(t.indexOf("Set up Forerunner"), t.indexOf("Set up Forerunner") + 1200));
    const s = page.getByRole("button", { name: "Start using Forerunner" });
    if (await s.count()) await s.click();
    await page.waitForTimeout(8000);
    await R.until(async () => !/Set up Forerunner/.test(await text(page)), 120000, 2000, "setup gone").catch((e) => log(String(e)));
    await page.waitForTimeout(3000);
    t = await R.step(page, "home-after-setup");
    log(t.slice(0, 900));
    await goto(page, "/settings");
    t = await R.step(page, "settings-after-setup");
    const i = t.indexOf("GitHub:");
    log(t.slice(Math.max(0, i - 300), i + 300));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
