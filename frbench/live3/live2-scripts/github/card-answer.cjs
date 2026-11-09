// usage: node card-answer.cjs <label> <card text substring> <button name>
const { R, N, log, text, goto, save } = require("./h.cjs");
const [LABEL, SUB, BTN] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    const card = page.getByTestId("request").filter({ hasText: SUB });
    let n = await card.count();
    let target = card;
    if (!n) { target = page.locator("article, li, section > div").filter({ hasText: SUB }).filter({ has: page.getByRole("button", { name: BTN, exact: true }) }).last(); n = await target.count(); }
    log("cards matched", n);
    const respP = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60000 }).catch(() => null);
    await target.last().getByRole("button", { name: BTN, exact: true }).click();
    await page.waitForTimeout(500);
    // a confirm dialog?
    const d = page.getByRole("dialog");
    if (await d.count()) { log("dialog:", (await d.first().innerText()).slice(0, 600)); }
    const resp = await respP;
    if (resp) { const b = await resp.json().catch(() => null); log("answer", resp.url().replace(/^.*48900/, ""), resp.status(), JSON.stringify(b).slice(0, 700)); save(LABEL + "-answer.json", b); }
    await page.waitForTimeout(3000);
    const t = await R.step(page, LABEL + "-after");
    const i = t.indexOf("Needs you");
    log(t.slice(i, i + 1500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
