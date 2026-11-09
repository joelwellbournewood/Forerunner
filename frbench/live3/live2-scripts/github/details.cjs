// usage: node details.cjs <label> <card title substring>...  -> opens Details on matching cards
const { R, N, log, text, goto } = require("./h.cjs");
const [LABEL, ...subs] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    for (const s of subs) {
      const card = page.getByTestId("request").filter({ hasText: s }).last();
      await card.getByText("Details", { exact: true }).first().click();
      await page.waitForTimeout(600);
      log("=== " + s + "\n" + (await card.innerText()).slice(0, 1500));
    }
    await R.step(page, LABEL);
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
