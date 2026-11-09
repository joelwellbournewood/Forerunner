// One more Talk try with the setting's own name; the line is watched without reload.
const { R, N, log, text, goto, enc, save, sleep } = require("./h.cjs");
const [PID, WORDS, WANT, LABEL] = process.argv.slice(2);
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const lineNow = async () => (await page.getByTestId("research-reads-line").textContent()).trim();
  try {
    await goto(page, `/projects/${enc(PID)}/summary`);
    await page.waitForTimeout(1200);
    out.start = await lineNow();
    await page.getByTestId("talk-open").click();
    await page.waitForTimeout(800);
    await page.getByTestId("conversation-input").fill(WORDS);
    await page.getByTestId("conversation-send").click();
    const card = page.getByTestId("pending-confirmation").last();
    out.card = await card.waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(800);
    const t = await R.step(page, `${LABEL}-talk`);
    out.talk = t.slice(t.lastIndexOf(WORDS.slice(0, 20)), t.lastIndexOf(WORDS.slice(0, 20)) + 900);
    log("card", out.card, "|", out.talk.replace(/\n+/g, " / ").slice(0, 700));
    if (out.card) {
      await card.getByTestId("confirm-yes").click();
      const t0 = Date.now(); let seen = await lineNow();
      while (Date.now() - t0 < 20000 && seen !== WANT) { await sleep(500); seen = await lineNow(); }
      out.after = seen; out.ok = seen === WANT; out.afterMs = Date.now() - t0;
      log("line after confirm |", seen, out.afterMs + " ms");
      await R.step(page, `${LABEL}-after`);
    }
  } finally { await browser.close(); save(`${LABEL}.json`, out); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
