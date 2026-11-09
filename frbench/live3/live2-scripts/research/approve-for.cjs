// Inbox: Approve and start on the plan card of project argv[2].
const { R, N, log, text, goto } = require("./h.cjs");
const [PNAME, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    await page.waitForTimeout(1000);
    const card = page.locator("li, article, section, div").filter({ hasText: `Plan for "${PNAME}"` }).filter({ has: page.getByRole("button", { name: "Approve and start" }) }).last();
    await card.getByRole("button", { name: "Approve and start" }).click();
    await page.waitForTimeout(3000);
    const t = await R.step(page, LABEL);
    console.log(t.split("\n").filter(Boolean).slice(12, 18).join("\n"));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
