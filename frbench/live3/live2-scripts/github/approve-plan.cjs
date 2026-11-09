// usage: node approve-plan.cjs <plan title substring> <label>
const { R, N, log, text, goto } = require("./h.cjs");
const [SUB, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    const card = page.getByTestId("request").filter({ hasText: SUB });
    log("cards", await card.count());
    await card.first().getByRole("button", { name: "Approve and start" }).click();
    await page.waitForTimeout(6000);
    await goto(page, "/inbox");
    await page.waitForTimeout(3000);
    const t = await R.step(page, LABEL);
    const i = t.indexOf("Needs you");
    log(t.slice(i, i + 1200));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
