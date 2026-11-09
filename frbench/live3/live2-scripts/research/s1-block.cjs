// Overview: Research reads · Change; Never: *.example.org; Apply.
const { R, N, log, text, goto, save, enc } = require("./h.cjs");
const PID = process.argv[2];
const NEVER = process.argv[3] || "*.example.org";
const LABEL = process.argv[4] || "s1-block";
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, `/projects/${enc(PID)}/summary`);
    await page.waitForTimeout(1500);
    log("line before:", await page.getByTestId("research-reads-line").textContent());
    await page.getByTestId("research-reads-change").click();
    const dialog = page.getByTestId("setting-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("web-access-never").fill(NEVER);
    await page.waitForTimeout(400);
    const t1 = await R.step(page, `${LABEL}-dialog`);
    log("saved as:", await dialog.getByTestId("web-access-saved-as").textContent());
    await dialog.getByTestId("setting-apply").click();
    await dialog.getByTestId("command-done").waitFor({ timeout: 15000 });
    await R.step(page, `${LABEL}-done`);
    await dialog.getByTestId("command-close").click();
    await page.waitForTimeout(1000);
    log("line after:", await page.getByTestId("research-reads-line").textContent());
    await R.step(page, `${LABEL}-overview`);
    const card = await R.api(N, "GET", `/projects/${enc(PID)}`);
    log("card researchReads:", card.researchReads, JSON.stringify(card.settings?.web_access ?? null));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
