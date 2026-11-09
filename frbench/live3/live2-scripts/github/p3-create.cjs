const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.waitForTimeout(500);
    const d = page.getByTestId("new-project-dialog");
    await d.locator('input[name="name"]').fill("Kite timer");
    await d.locator('textarea[name="brief"]').fill("A small Node.js script, timer.js, that prints how many minutes a kite has been flying since a start time given on the command line.");
    await page.getByTestId("create-project").click();
    await page.waitForTimeout(3000);
    log("url", page.url());
    await R.until(async () => { await page.reload(); await page.waitForTimeout(2000); return /approve the plan|Planning failed/i.test(await text(page)); }, 240000, 5000, "plan card");
    const t = await R.step(page, "p3-plan-ready");
    log(t.slice(t.indexOf("Kite timer\n"), t.indexOf("Kite timer\n") + 600));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
