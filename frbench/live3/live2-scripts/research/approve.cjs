// Inbox: press Approve and start on the first plan card (optionally matching argv[2]).
const { R, N, log, text, goto } = require("./h.cjs");
const LABEL = process.argv[3] || "approve";
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    await page.waitForTimeout(1000);
    const btn = page.getByRole("button", { name: "Approve and start" }).first();
    await btn.click();
    await page.waitForTimeout(4000);
    const t = await R.step(page, LABEL);
    console.log(t.slice(0, 1500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
