const { R, N, log, text, goto, save } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.waitForTimeout(500);
    const d = page.getByTestId("new-project-dialog");
    await d.locator('input[name="name"]').fill("Kite club");
    await d.locator('textarea[name="brief"]').fill(
      "Add a kite club page to this repository in three tasks that build on each other, and nothing else.\n" +
      "1. Write kite/index.html: a small page with the heading \"Kite club\" and one paragraph about our Sunday flying.\n" +
      "2. Then add a footer to kite/index.html with the text \"Kite club, since 2026\" (this task depends on task 1).\n" +
      "3. Then add a test, kite/footer.test.mjs, using node:test and no dependencies, that reads kite/index.html and checks the footer text is there (this task depends on task 2)."
    );
    await d.locator('input[name="repo"]').fill("https://github.com/joelwellbournewood/forerunner-sandbox");
    await R.step(page, "p1-new-project-dialog");
    await page.getByTestId("create-project").click();
    await page.waitForTimeout(3000);
    log("url", page.url());
    await R.step(page, "p1-created");
    await R.until(async () => /Approve and start|Planning failed|could not/i.test(await text(page)), 240000, 3000, "plan card");
    const t = await R.step(page, "p1-plan-card");
    log(t.slice(0, 3000));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
