// R-failopen github.io line + TR-5: a project with an empty stored "only" list, then a research brief planned.
const { R, N, log, text, goto, enc, save, sleep } = require("./h.cjs");
const { DatabaseSync } = require("node:sqlite");
const out = {};
(async () => {
  const b = R.bench(N);
  const db = new DatabaseSync(`${b.home}/data/state.sqlite`);
  const make = async (name, rule) => {
    const p = await R.api(N, "POST", "/projects", { name, goal: "Research" });
    const row = db.prepare("SELECT settings FROM project WHERE id = ?").get(p.id);
    db.prepare("UPDATE project SET settings = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.settings || "{}"), web_access: rule }), p.id);
    return p.id;
  };
  out.suffix = await make("Suffix rule", { mode: "only", only: ["github.io"], never: [] });
  out.empty = await make("Hosting notes", { mode: "only", only: [], never: [] });
  db.close();
  const { browser, page } = await R.openApp(N);
  try {
    for (const k of ["suffix", "empty"]) {
      await goto(page, `/projects/${enc(out[k])}/summary`);
      await page.waitForTimeout(1200);
      out[k + "Line"] = (await page.getByTestId("research-reads-line").textContent()).trim();
      log(k, "|", out[k + "Line"]);
      await R.step(page, `s3-${k}-overview`);
    }
    // TR-5: the research brief planned under the empty list.
    const r = await R.apiRaw(N, "POST", `/projects/${enc(out.empty)}/intake`, { brief: "Compare the free tiers of three static site hosts, with sources" });
    out.intakeStatus = r.status;
    log("intake POST", r.status);
    await R.until(async () => {
      const s = await R.api(N, "GET", `/projects/${enc(out.empty)}/intake`);
      return s.state && s.state !== "drafting" ? s : null;
    }, 180000, 3000, "plan drafted");
    await goto(page, "/inbox");
    await page.waitForTimeout(1500);
    const t = await R.step(page, "s3-tr5-inbox");
    const k = t.indexOf('Plan for "Hosting notes"');
    out.card = t.slice(k, k + 1500);
    log(out.card);
  } finally { await browser.close(); save("s3-tr5.json", out); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
