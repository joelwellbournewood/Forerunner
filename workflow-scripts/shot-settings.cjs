// Screenshot Settings > Advanced at the Status pull request rows.
const R = require(`${process.argv[2]}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const NAME = process.argv[3];
const LABEL = process.argv[4];
(async () => {
  const { browser, page } = await R.openApp(NAME);
  const ui = JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8")).uiUrl;
  await page.goto(`${ui}/settings`);
  await page.waitForTimeout(2000);
  await page.getByText("Advanced", { exact: true }).first().click();
  await page.waitForTimeout(800);
  const row = page.getByText("Status pull request", { exact: true }).last();
  if (await row.count()) await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const t = await R.step(page, LABEL);
  const i = t.indexOf("Status pull request");
  console.log(i >= 0 ? t.slice(Math.max(0, i - 300), i + 900) : "no Status pull request row");
  await browser.close();
})();
