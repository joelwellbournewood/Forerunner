// Settings page: the project's "Web pages research may read" row -> Only these websites: <sites>.
const { R, N, log, text, goto, enc } = require("./h.cjs");
const [PNAME, ONLY, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/settings");
    await page.waitForTimeout(1500);
    await page.getByTestId("settings-advanced-summary").click();
    await page.waitForTimeout(800);
    let rows = page.locator('[data-testid="setting-row"][data-key="project.web_access"]').filter({ hasText: PNAME });
    if ((await rows.count()) === 0) {
      // Rows may sit behind an "Advanced" or "All settings" toggle.
      for (const name of ["Advanced", "All settings", "Show all"]) {
        const b = page.getByRole("button", { name }).first();
        if (await b.count()) { await b.click(); await page.waitForTimeout(800); }
        rows = page.locator('[data-testid="setting-row"][data-key="project.web_access"]').filter({ hasText: PNAME });
        if (await rows.count()) break;
      }
    }
    log("rows", await rows.count());
    const row = rows.first();
    await row.scrollIntoViewIfNeeded();
    log("row before:", (await row.textContent()).slice(0, 300));
    await R.step(page, `${LABEL}-row-before`);
    await row.getByTestId("setting-change").click();
    const dialog = page.getByTestId("setting-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("web-access-mode").selectOption("only");
    await dialog.getByTestId("web-access-only").fill(ONLY);
    await page.waitForTimeout(400);
    log("saved as:", await dialog.getByTestId("web-access-saved-as").textContent());
    await R.step(page, `${LABEL}-dialog`);
    await dialog.getByTestId("setting-apply").click();
    await dialog.getByTestId("command-done").waitFor({ timeout: 15000 });
    await R.step(page, `${LABEL}-done`);
    await dialog.getByTestId("command-close").click();
    await page.waitForTimeout(1200);
    log("row after:", (await row.textContent()).slice(0, 300));
    await R.step(page, `${LABEL}-row-after`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
