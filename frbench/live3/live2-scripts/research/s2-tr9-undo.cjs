// TR-9 (UI half): Overview open in one tab; the Overview change undone from Changes in a second tab.
const { R, N, log, text, goto, enc, save, sleep } = require("./h.cjs");
const PID = process.argv[2];
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const b = R.bench(N);
  const lineNow = async () => (await page.getByTestId("research-reads-line").textContent()).trim();
  try {
    await goto(page, `/projects/${enc(PID)}/summary`);
    await page.waitForTimeout(1200);
    out.start = await lineNow();
    log("start |", out.start);
    const page2 = await page.context().newPage();
    await page2.goto(`${b.uiUrl}/changes`, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(2000);
    const ch = page2.getByTestId("change").filter({ hasText: /settings\.set/ }).filter({ hasText: /Reading rules/ }).filter({ hasText: /facebook/ }).first();
    out.change = (await ch.textContent()).slice(0, 400);
    log("change row |", out.change);
    await page2.screenshot({ path: "/tmp/frbench/live2/research/evidence/s2-tr9-changes.png", fullPage: true });
    await ch.getByTestId("change-undo").click();
    await page2.waitForTimeout(1000);
    const pending = page2.getByTestId("changes-undo-pending");
    if (await pending.isVisible().catch(() => false)) {
      out.pending = await pending.textContent(); log("pending |", out.pending.slice(0, 300));
      await pending.getByTestId("command-yes").click();
    }
    await page2.waitForTimeout(1500);
    await page2.screenshot({ path: "/tmp/frbench/live2/research/evidence/s2-tr9-changes-after.png", fullPage: true }); out.note = await page2.getByTestId("changes-note").textContent().catch(() => null); log("changes note |", out.note);
    await page.bringToFront();
    const t0 = Date.now();
    let seen = await lineNow();
    while (Date.now() - t0 < 20000 && seen === out.start) { await sleep(500); seen = await lineNow(); }
    out.after = seen; out.afterMs = Date.now() - t0;
    log("overview after undo |", seen, out.afterMs + " ms");
    await R.step(page, "s2-tr9-overview-after-undo");
  } finally { await browser.close(); save("s2-tr9-undo.json", out); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
