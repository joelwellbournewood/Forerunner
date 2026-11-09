// usage: node merge-mode.cjs <projectId> <you|after_review> <label>
const { R, N, log, text, goto, save } = require("./h.cjs");
const [P, MODE, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P + "/summary");
    await page.getByTestId("merge-mode-change").click();
    await page.waitForTimeout(1200);
    let t = await R.step(page, LABEL + "-change-open");
    const d = page.getByRole("dialog");
    if (await d.count()) log("dialog:", (await d.first().innerText()).slice(0, 1500));
    const sel = (await d.count()) ? d.first().locator("select") : page.locator("select");
    if (await sel.count()) { await sel.first().selectOption(MODE); await page.waitForTimeout(800); }
    else { const lbl = MODE === "you" ? "You press Merge" : "Merge automatically after review"; await page.getByLabel(lbl).check().catch(async () => page.getByText(lbl).click()); }
    t = await R.step(page, LABEL + "-chosen");
    if (await d.count()) log("dialog after choice:", (await d.first().innerText()).slice(0, 1500));
    const btn = (await d.count() ? d.first() : page).getByRole("button", { name: /^(Apply|Save|Change|Yes|Confirm)/ });
    log("buttons:", await btn.allInnerTexts());
    await btn.first().click();
    await page.waitForTimeout(2500);
    t = await R.step(page, LABEL + "-applied");
    const i = t.indexOf("Merging:");
    log(t.slice(i, i + 300));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
