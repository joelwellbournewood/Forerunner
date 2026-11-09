// Drawer: open "See what was checked" and print it.
const { R, N, log, text, goto, enc } = require("./h.cjs");
const [PID, TITLE, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, `/projects/${enc(PID)}/tasks`);
    await page.waitForTimeout(1200);
    await page.getByTestId("task-row").filter({ hasText: TITLE }).first().getByTestId("task-title").click();
    await page.waitForTimeout(1200);
    await page.getByText("See what was checked").first().click();
    await page.waitForTimeout(1000);
    const t = await R.step(page, LABEL, { fullPage: true });
    const k = t.indexOf("See what was checked");
    console.log(t.slice(k, k + 2500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
