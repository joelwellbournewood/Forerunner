// Evidence on the current bench: where /settings#other-settings lands over five fresh loads
// (screenshot of each), and every Settings line holding "USD" with Advanced open.
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
const N = "review-polish-screens";
const DIR = "/tmp/frbench/review-polish-screens-evidence";
const out = { loads: [] };
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    for (let run = 0; run < 5; run++) {
      await page.goto(`${R.bench(N).uiUrl}/`);
      await page.waitForTimeout(800);
      await page.goto(`${R.bench(N).uiUrl}/settings#other-settings`);
      await page.waitForTimeout(6000);
      const m = await page.evaluate(() => {
        const el = document.getElementById("other-settings");
        return {
          top: el ? Math.round(el.getBoundingClientRect().top) : null,
          targeted: el?.getAttribute("data-targeted") ?? null,
          viewport: window.innerHeight,
        };
      });
      out.loads.push(m);
      await page.screenshot({ path: path.join(DIR, `hash-load-${run + 1}-top-${m.top}.png`) });
    }
    const text = await page.evaluate(() => document.body.innerText);
    out.usd = text
      .split("\n")
      .filter((l) => /USD/.test(l))
      .map((l) => l.slice(0, 220));
    fs.writeFileSync(path.join(DIR, "settings-usd-lines.txt"), out.usd.join("\n"));
    // The subscription allowance block, as a screenshot.
    const allowance = page.getByText(/stored as USD/).first();
    if (await allowance.count()) {
      await allowance.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(DIR, "settings-allowance-usd.png") });
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
