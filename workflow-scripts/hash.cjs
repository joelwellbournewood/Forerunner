// Where /settings#other-settings lands on a fresh load, measured over time; and the Overview's
// Change link clicked in the app.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
const N = "review-polish-screens";
const out = { fresh: [], click: [] };
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    const measure = () =>
      page.evaluate(() => {
        const el = document.getElementById("other-settings");
        return {
          t: Math.round(performance.now()),
          scrollY: Math.round(window.scrollY),
          top: el ? Math.round(el.getBoundingClientRect().top) : null,
          targeted: el?.getAttribute("data-targeted") ?? null,
          height: document.body.scrollHeight,
        };
      });
    for (let run = 0; run < 2; run++) {
      await page.goto(`${R.bench(N).uiUrl}/`);
      await page.waitForTimeout(1000);
      await page.goto(`${R.bench(N).uiUrl}/settings#other-settings`);
      const series = [];
      for (let i = 0; i < 12; i++) {
        series.push(await measure());
        await page.waitForTimeout(500);
      }
      out.fresh.push(series);
    }
    await R.step(page, "settings-hash-fresh-load-6s");
    // The Overview's Change link.
    const projects = await R.api(N, "GET", "/projects");
    const quote = projects.find((p) => p.name === "Quote page");
    await page.goto(`${R.bench(N).uiUrl}/projects/${quote.id}/summary`);
    await page.waitForTimeout(2000);
    const link = page.getByRole("link", { name: "Change" }).first();
    out.changeHref = await link.getAttribute("href");
    await link.click();
    for (let i = 0; i < 12; i++) {
      out.click.push(await measure());
      await page.waitForTimeout(500);
    }
    await R.step(page, "settings-from-overview-change");
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out));
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out));
  process.exit(1);
});
