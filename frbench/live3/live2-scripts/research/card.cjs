// Inbox: press a button (argv[2]) on the first card that has text argv[3].
const { R, N, log, text, goto } = require("./h.cjs");
const [BUTTON, HAS, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    await page.waitForTimeout(1200);
    const btn = page.getByRole("button", { name: new RegExp("^" + BUTTON) }).first();
    log("button text:", await btn.textContent());
    await btn.click();
    await page.waitForTimeout(3000);
    const t = await R.step(page, LABEL);
    console.log(t.split("\n").filter(Boolean).slice(12, 40).join("\n"));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
