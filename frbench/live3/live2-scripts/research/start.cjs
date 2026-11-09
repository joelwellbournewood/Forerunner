// usage: node start.cjs <projectId> <label>
const { R, N, log, text, goto } = require("./h.cjs");
const [P, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P + "/summary");
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2000);
    let t = await R.step(page, LABEL + "-start-dialog");
    const d = page.getByRole("dialog");
    log((await d.innerText()).slice(0, 1500));
    const b = page.getByTestId("confirm-start-session");
    if (!(await b.isEnabled())) { log("Start disabled"); return; }
    await b.click();
    await page.waitForTimeout(3000);
    t = await R.step(page, LABEL + "-started");
    log("url", page.url());
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
