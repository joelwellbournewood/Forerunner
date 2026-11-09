// R-researchreads + TR-9: Overview change, then two changes made in Talk, the line watched without reload.
const { R, N, log, text, goto, enc, save, sleep } = require("./h.cjs");
const out = { lines: [] };
(async () => {
  const p = await R.api(N, "POST", "/projects", { name: "Reading rules", goal: "Check the research reads line" });
  out.project = p.id;
  const { browser, page } = await R.openApp(N);
  const lineNow = async () => (await page.getByTestId("research-reads-line").textContent()).trim();
  const watch = async (label, want, ms = 20000) => {
    const t0 = Date.now();
    let seen = await lineNow();
    while (Date.now() - t0 < ms && seen !== want) { await sleep(500); seen = await lineNow(); }
    out.lines.push({ label, want, seen, ok: seen === want, afterMs: Date.now() - t0 });
    log(label, "|", seen, seen === want ? "OK" : "!= " + want);
    await R.step(page, `s2-rr-${label}`);
  };
  const talk = async (label, words) => {
    const input = page.getByTestId("conversation-input");
    if (!(await input.isVisible().catch(() => false))) { await page.getByTestId("talk-open").click(); await page.waitForTimeout(800); }
    await input.fill(words);
    await page.getByTestId("conversation-send").click();
    const card = page.getByTestId("pending-confirmation").last();
    const got = await card.waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(500);
    const t = await R.step(page, `s2-rr-${label}-talk`);
    const k = t.lastIndexOf(words.slice(0, 20));
    out[label] = t.slice(k, k + 900);
    log(label, "card:", got, "|", t.slice(k, k + 500).replace(/\n+/g, " / "));
    if (got) {
      await card.getByTestId("confirm-yes").click();
      await page.waitForTimeout(1500);
      const t2 = await R.step(page, `s2-rr-${label}-confirmed`);
      out[label + "Confirmed"] = t2.slice(t2.lastIndexOf(words.slice(0, 20))).slice(0, 900);
    }
    return got;
  };
  try {
    await goto(page, `/projects/${enc(p.id)}/summary`);
    await page.waitForTimeout(1200);
    out.start = await lineNow();
    log("start |", out.start);
    await page.getByTestId("research-reads-change").click();
    const dialog = page.getByTestId("setting-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("web-access-never").fill("facebook.com");
    await dialog.getByTestId("setting-apply").click();
    await dialog.getByTestId("command-done").waitFor({ timeout: 15000 });
    await dialog.getByTestId("command-close").click();
    await watch("01-after-overview-change", "Research reads: any public website, never facebook.com");
    await talk("02-only", "only read developer.mozilla.org for research");
    await watch("03-after-talk-only", "Research reads: only developer.mozilla.org");
    await talk("04-any", "research may read any public website again");
    await watch("05-after-talk-any", "Research reads: any public website");
    await page.reload();
    await page.waitForTimeout(2000);
    out.afterReload = await lineNow();
    log("after reload |", out.afterReload);
  } finally {
    await browser.close();
    save("s2-researchreads.json", out);
  }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
