// Review walk B2 (TR-9): the Overview stays open in one tab while the change is undone in another.
const [NAME, ROOT] = process.argv.slice(2);
const R = require(`${ROOT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const enc = encodeURIComponent;
const out = {};

(async () => {
  const b = R.bench(NAME);
  const p = await R.api(NAME, "POST", "/projects", { name: "Reads", goal: "Research reads" });
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(p.id)}/summary`);
    await page.waitForTimeout(1500);
    out.before = await page.getByTestId("research-reads-line").textContent();
    await page.getByTestId("research-reads-change").click();
    const s = page.getByTestId("setting-dialog");
    await s.waitFor();
    await s.getByTestId("web-access-never").fill("facebook.com");
    await s.getByTestId("setting-apply").click();
    await s.getByTestId("command-done").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await s.getByTestId("command-close").click().catch(() => undefined);
    await page.waitForTimeout(1500);
    out.afterChange = await page.getByTestId("research-reads-line").textContent();
    await R.step(page, "b2-01-overview-after-change");
    // A second tab: Changes, Undo, Yes.
    const other = await page.context().newPage();
    await other.goto(`${b.uiUrl}/changes`);
    await other.waitForTimeout(2000);
    await other.getByTestId("change-undo").first().click();
    await other.waitForTimeout(800);
    await other.getByRole("button", { name: "Yes", exact: true }).first().click();
    await other.waitForTimeout(2000);
    out.settingAfterUndo = (await R.api(NAME, "GET", `/settings?scope=project&scopeId=${enc(p.id)}`)).find((r) => /web_access/.test(r.key ?? r.name ?? ""))?.value ?? null;
    await other.close();
    // The first tab, untouched: its line follows the card.
    await page.waitForTimeout(4000);
    out.afterUndoOpenTab = await page.getByTestId("research-reads-line").textContent();
    await R.step(page, "b2-02-overview-after-undo-elsewhere");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`/tmp/frbench/${NAME}/steps/walk-b2.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
