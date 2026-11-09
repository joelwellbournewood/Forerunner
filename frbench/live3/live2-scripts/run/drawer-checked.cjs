const L = require("./lib.cjs");
const { R, goto, enc, save } = L;
const NAME = process.argv[2] || "run-live", PROJECT = process.argv[3] || "Quote page", TPFX = process.argv[4] || "Build";
(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === PROJECT);
    const t = (await L.tasks(NAME, p.id)).find((x) => x.title.startsWith(TPFX));
    await goto(page, NAME, `/projects/${enc(p.id)}/tasks?task=${enc(t.id)}`, 2500);
    const s = page.getByText("See what was checked").first();
    if (await s.count()) { await s.click(); await page.waitForTimeout(1500); }
    const txt = await R.step(page, `drawer checked ${TPFX}`);
    const i = txt.indexOf("See what was checked");
    console.log(txt.slice(i, i + 2500));
  } finally { await browser.close(); }
})();
