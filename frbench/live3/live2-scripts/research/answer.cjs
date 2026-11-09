// Inbox: fill the answers of the questions card whose text has argv[2], then Send answers.
const { R, N, log, text, goto } = require("./h.cjs");
const [HAS, LABEL, ...ANSWERS] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/inbox");
    await page.waitForTimeout(1200);
    const card = page.getByTestId("person-questions").filter({ hasText: HAS }).first();
    const fields = card.getByTestId("person-answer");
    log("fields:", await fields.count());
    for (let i = 0; i < ANSWERS.length; i++) await fields.nth(i).fill(ANSWERS[i]);
    await R.step(page, `${LABEL}-filled`);
    await card.getByTestId("send-answers").click();
    await page.waitForTimeout(3000);
    const t = await R.step(page, `${LABEL}-sent`);
    console.log(t.split("\n").filter(Boolean).slice(12, 22).join("\n"));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
