// New project through the UI without a brief.
const { R, N, log, text, goto } = require("./h.cjs");
const [NAME, LABEL, BRIEF] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.waitForTimeout(500);
    const d = page.getByTestId("new-project-dialog");
    await d.locator('input[name="name"]').fill(NAME);
    if (BRIEF) await d.locator('textarea[name="brief"]').fill(BRIEF);
    await page.getByTestId("create-project").click();
    await page.waitForTimeout(2500);
    log("url", page.url());
    await R.step(page, LABEL);
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
