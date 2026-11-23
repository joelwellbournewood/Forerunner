// Reviewer's walk: Settings, Advanced open; prints the Status pull request and Who merges rows.
const REPO = process.argv[2];
const NAME = process.argv[3];
const LABEL = process.argv[4];
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8"));
(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${bench.uiUrl}/settings`);
    await page.waitForTimeout(2500);
    await page.locator("summary", { hasText: "Advanced" }).first().click();
    await page.waitForTimeout(2000);
    const text = await R.step(page, LABEL);
    for (const k of ["Status pull request", "Who merges", "Merging"]) {
      let i = -1;
      const hits = [];
      while ((i = text.indexOf(k, i + 1)) >= 0)
        hits.push(text.slice(Math.max(0, i - 120), i + 260).replace(/\n/g, " | "));
      console.log(`### ${k}: ${hits.length}`);
      for (const h of hits) console.log(`${h}\n----`);
    }
  } finally {
    await browser.close();
  }
})();
