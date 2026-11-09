// usage: node row-action.cjs <projectId> <task title> <button> <label> [confirmButton] [nth]
const { R, N, log, text, goto, save } = require("./h.cjs");
const [P, TITLE, BTN, LABEL, CONFIRM, NTH] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P + "/tasks");
    const rows = page.locator("tr").filter({ hasText: TITLE });
    log("rows", await rows.count());
    const row = rows.nth(Number(NTH || 0));
    await row.getByRole("button", { name: BTN, exact: true }).click();
    await page.waitForTimeout(1000);
    let t = await R.step(page, LABEL + "-dialog");
    const d = page.getByRole("dialog");
    if (await d.count()) log("dialog:", (await d.first().innerText()).slice(0, 1200));
    if (!CONFIRM) return;
    const respP = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60000 }).catch(() => null);
    await (await d.count() ? d.first() : page).getByRole("button", { name: CONFIRM, exact: true }).click();
    const resp = await respP;
    if (resp) { const b = await resp.json().catch(() => null); log("answer", resp.url().replace(/^.*48900/, ""), resp.status(), JSON.stringify(b).slice(0, 900)); save(LABEL + "-answer.json", b); }
    await page.waitForTimeout(2500);
    t = await R.step(page, LABEL + "-after");
    const i = t.indexOf("Task\tStatus");
    log(t.slice(i, i + 200));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
