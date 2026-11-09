// usage: node setting.cjs <project name> <setting label> <option label or value> <label> [dry]
const { R, N, log, text, goto, save } = require("./h.cjs");
const [PROJ, SETTING, OPTION, LABEL, DRY] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/settings#other-settings");
    await page.waitForTimeout(1500);
    const row = page.locator("tr").filter({ hasText: PROJ }).filter({ hasText: SETTING });
    log("rows", await row.count());
    await row.first().getByRole("button", { name: "Change" }).click();
    await page.waitForTimeout(1000);
    const d = page.getByRole("dialog").first();
    log("dialog:", (await d.innerText()).slice(0, 1500));
    const sel = d.locator("select");
    if (await sel.count()) {
      const opts = await sel.first().locator("option").allInnerTexts();
      log("options:", opts);
      const pick = opts.find((o) => o.includes(OPTION)) ;
      await sel.first().selectOption(pick ? { label: pick } : OPTION);
    } else {
      const inp = d.locator("input").first();
      if (await inp.count()) await inp.fill(OPTION);
    }
    await page.waitForTimeout(800);
    log("dialog after choice:", (await d.innerText()).slice(0, 1500));
    await R.step(page, LABEL + "-dialog");
    if (DRY) return;
    const btns = d.getByRole("button");
    log("buttons:", await btns.allInnerTexts());
    await d.getByRole("button", { name: "Preview and apply" }).click();
    await page.waitForTimeout(1500);
    const d2 = page.getByRole("dialog").last();
    log("preview:", (await d2.innerText()).slice(0, 1500));
    await R.step(page, LABEL + "-preview");
    log("buttons:", await d2.getByRole("button").allInnerTexts());
    const respP = page.waitForResponse((r) => r.request().method() !== "GET", { timeout: 30000 }).catch(() => null);
    await d2.getByRole("button", { name: /^(Apply|Yes|Confirm|Change)/ }).first().click();
    const resp = await respP;
    if (resp) { const b = await resp.json().catch(() => null); log("answer", resp.url().replace(/^.*48900/, ""), resp.status(), JSON.stringify(b).slice(0, 600)); }
    await page.waitForTimeout(2000);
    const t = await R.step(page, LABEL + "-after");
    const i = t.indexOf(PROJ + "\t" + SETTING);
    log(t.slice(i, i + 300));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
