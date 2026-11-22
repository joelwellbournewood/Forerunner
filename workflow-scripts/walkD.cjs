// Review walk D (R-failopen): a stored "only" rule written past the clean-up (as another install or
// the state DB would), then what the Overview line, the Settings row and a research task see.
const [NAME, LABEL, ROOT] = process.argv.slice(2);
const R = require(`${ROOT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const enc = encodeURIComponent;
const out = {};
(async () => {
  const b = R.bench(NAME);
  const db = new DatabaseSync(`${b.home}/data/state.sqlite`);
  const make = async (name, rule) => {
    const p = await R.api(NAME, "POST", "/projects", { name, goal: "Read the web" });
    const row = db.prepare("SELECT settings FROM project WHERE id = ?").get(p.id);
    const settings = { ...JSON.parse(row.settings || "{}"), web_access: rule };
    db.prepare("UPDATE project SET settings = ? WHERE id = ?").run(JSON.stringify(settings), p.id);
    return p.id;
  };
  out.suffix = await make(`Suffix ${Date.now() % 100000}`, { mode: "only", only: ["github.io"], never: [] });
  out.empty = await make(`Empty ${Date.now() % 100000}`, { mode: "only", only: [], never: [] });
  out.ip = await make(`IP ${Date.now() % 100000}`, { mode: "only", only: ["10.1.2.3"], never: [] });
  const { browser, page } = await R.openApp(NAME);
  try {
    for (const k of ["suffix", "empty", "ip"]) {
      const card = await R.api(NAME, "GET", `/projects/${enc(out[k])}`);
      out[`${k}Card`] = card.researchReads;
      await page.goto(`${b.uiUrl}/projects/${enc(out[k])}/summary`);
      await page.waitForTimeout(1500);
      out[`${k}Line`] = await page.getByTestId("research-reads-line").textContent().catch((e) => String(e));
      await R.step(page, `${LABEL}-${k}-overview`);
      await page.getByTestId("research-reads-change").click();
      await page.getByTestId("setting-dialog").waitFor();
      await page.waitForTimeout(800);
      out[`${k}Dialog`] = await R.step(page, `${LABEL}-${k}-change-dialog`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      const rows = await R.api(NAME, "GET", `/settings?scope=project&scopeId=${enc(out[k])}`).catch(
        (e) => String(e),
      );
      out[`${k}Row`] = Array.isArray(rows)
        ? rows.find((r) => r.key === "project.web_access")?.value
        : rows;
    }
  } finally {
    await browser.close();
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-walkD.json`, JSON.stringify(out, null, 2));
    const { suffixDialog, emptyDialog, ipDialog, ...rest } = out;
    console.log(JSON.stringify(rest, null, 2));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
