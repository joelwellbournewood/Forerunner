const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.waitForTimeout(500);
    const d = page.getByTestId("new-project-dialog");
    await d.locator('input[name="name"]').fill("Kite shop");
    await d.locator('input[name="goal"]').fill("A small kite shop page in the sandbox repository");
    await d.locator('input[name="repo"]').fill("https://github.com/joelwellbournewood/forerunner-sandbox");
    await R.step(page, "p2-new-project-dialog");
    await page.getByTestId("create-project").click();
    await page.waitForTimeout(8000);
    log("url", page.url());
    const t = await R.step(page, "p2-created-overview");
    log(t.slice(t.indexOf("Kite shop\n"), t.indexOf("Kite shop\n") + 1500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
