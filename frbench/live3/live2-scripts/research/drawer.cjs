// Tasks tab: open the drawer of the task whose title matches argv[3]; also the session page with Details.
const { R, N, log, text, goto, enc, save } = require("./h.cjs");
const [PID, TITLE, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, `/projects/${enc(PID)}/tasks`);
    await page.waitForTimeout(1200);
    const rows = await R.step(page, `${LABEL}-tasks`);
    console.log("=== TASKS\n" + rows.split("\n").filter(Boolean).slice(15, 45).join("\n"));
    await page.getByTestId("task-row").filter({ hasText: TITLE }).first().getByTestId("task-title").click();
    await page.waitForTimeout(1500);
    const d = await R.step(page, `${LABEL}-drawer`, { fullPage: true });
    const i = d.indexOf(TITLE);
    const k = d.indexOf("Runs") > 0 ? d.indexOf(TITLE, d.indexOf("Actions") + 10) : 0; console.log("=== DRAWER\n" + d.slice(Math.max(0, k)).split("\n").filter(Boolean).join("\n").slice(0, 5000));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
