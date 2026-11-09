const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: false });
  try {
    let t = await R.step(page, "first-open");
    log(t.slice(0, 600));
    await goto(page, "/setup");
    t = await R.step(page, "setup-open");
    const nm = page.getByLabel("Your name");
    if (await nm.count()) { await nm.fill("Sam Tester"); }
    // walk forward to GitHub step
    for (let i = 0; i < 4 && !/GitHub token/.test(await text(page)); i++) {
      const c = page.getByRole("button", { name: /^(Continue|Next|Get started|Start)$/ });
      if (await c.count()) { await c.first().click(); await page.waitForTimeout(800); } else break;
    }
    t = await R.step(page, "setup-github-step");
    const input = page.getByPlaceholder("github_pat_…");
    await input.fill(process.env.FORERUNNER_TEST_GITHUB_TOKEN || "");
    await page.getByRole("button", { name: "Check and save" }).click();
    await R.until(async () => /Token works|could not|refused|did not/i.test(await text(page)), 60000, 1000, "token check");
    // clear field before screenshot (it should already be cleared after save)
    const v = await input.inputValue().catch(() => "");
    if (v) await input.fill("");
    t = await R.step(page, "setup-github-checked");
    log(t.slice(t.indexOf("GitHub token") - 200, t.indexOf("GitHub token") + 1500));
    const c = page.getByRole("button", { name: "Continue", exact: true });
    if (await c.count()) { await c.first().click(); await page.waitForTimeout(1000); }
    t = await R.step(page, "setup-done-step");
    log(t.slice(-800));
    const s = page.getByRole("button", { name: "Start using Forerunner" });
    if (await s.count()) { await s.click(); await page.waitForTimeout(3000); }
    await R.until(async () => !/Set up Forerunner/.test(await text(page)), 90000, 2000, "setup gone").catch(e => log(String(e)));
    await page.waitForTimeout(5000);
    t = await R.step(page, "home-after-setup");
    log(t.slice(0, 800));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
