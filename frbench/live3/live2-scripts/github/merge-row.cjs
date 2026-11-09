// usage: node merge-row.cjs <projectId> <prNumber> <label>
const { R, N, log, text, goto, save } = require("./h.cjs");
const [P, NUM, LABEL] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P + "/summary");
    const btn = page.getByTestId("pr-waiting").filter({ hasText: new RegExp("pull request #" + NUM + "(?!\\d)") }).getByTestId("pr-merge");
    const cnt = await btn.count(); console.log("buttons found", cnt); if (cnt !== 1) throw new Error("merge button count " + cnt);
    const t0 = Date.now();
    const respP = page.waitForResponse((r) => r.url().includes("/pull-requests/" + NUM + "/merge"), { timeout: 120000 });
    await btn.click();
    const resp = await respP.catch((e) => { throw e; });
    const body = await resp.json().catch(() => null);
    log("merge answer in", Date.now() - t0, "ms", resp.status(), JSON.stringify(body).slice(0, 1000));
    save(LABEL + "-answer.json", { ms: Date.now() - t0, status: resp.status(), body });
    await page.waitForTimeout(700);
    let t = await R.step(page, LABEL + "-right-after");
    let i = t.indexOf("Waiting for you to merge");
    log(t.slice(i, i + 900));
    for (let k = 0; k < 3; k++) {
      await page.waitForTimeout(4000);
      t = await R.step(page, LABEL + "-after-" + (k + 1) * 4 + "s");
      i = t.indexOf("Your files");
      log(t.slice(i, i + 900));
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
