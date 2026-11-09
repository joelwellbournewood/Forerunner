// Overview: type a note for the next session and Save note.
const { R, N, log, text, goto, enc } = require("./h.cjs");
const [PID, NOTE, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, `/projects/${enc(PID)}/summary`);
    await page.waitForTimeout(1200);
    const box = page.getByTestId("queue-text");
    await box.fill(NOTE);
    await page.getByTestId("queue-add").click();
    await page.waitForTimeout(1500);
    const t = await R.step(page, LABEL);
    console.log(t.split("\n").filter(Boolean).slice(-12).join("\n"));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
