// Where /settings#other-settings lands: five fresh loads and five clicks on the Overview's
// "Change" link, each measured 6 s later (the page scrolls inside its main pane, not the window).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
const N = "review-polish-screens";
const out = { fresh: [], click: [], viewport: null };
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    const measure = () =>
      page.evaluate(() => {
        const el = document.getElementById("other-settings");
        return {
          top: el ? Math.round(el.getBoundingClientRect().top) : null,
          targeted: el?.getAttribute("data-targeted") ?? null,
          inner: window.innerHeight,
        };
      });
    for (let run = 0; run < 4; run++) {
      await page.goto(`${R.bench(N).uiUrl}/`);
      await page.waitForTimeout(800);
      await page.goto(`${R.bench(N).uiUrl}/settings#other-settings`);
      await page.waitForTimeout(6000);
      out.fresh.push(await measure());
    }
    await R.step(page, "settings-hash-fresh-load");
    const projects = await R.api(N, "GET", "/projects");
    const quote = projects.find((p) => p.name === "Seeded site");
    for (let run = 0; run < 4; run++) {
      await page.goto(`${R.bench(N).uiUrl}/projects/${quote.id}/summary`);
      const link = page.locator('a[href="/settings#other-settings"]').first();
      await link.waitFor({ timeout: 15_000 });
      await link.click();
      await page.waitForTimeout(6000);
      out.click.push(await measure());
      if (run === 0) await R.step(page, "settings-from-overview-change");
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out));
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out));
  process.exit(1);
});
