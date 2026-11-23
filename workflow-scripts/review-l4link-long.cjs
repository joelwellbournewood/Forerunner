// Reviewer's walk: New project on a repository whose marker name is long; the offer's lines.
const REPO = process.argv[2];
const NAME = process.argv[3];
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8"));
(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    for (const brief of [null, "A page that lists the club's kites."]) {
      await page.goto(bench.uiUrl);
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "New project", exact: true }).first().click();
      await page.waitForTimeout(600);
      await page.getByLabel("Name").fill("Long kites");
      await page.getByLabel(/^Goal/).fill("Fly kites together");
      if (brief) await page.getByLabel(/^Brief/).fill(brief);
      await page.getByLabel(/^Repository link/).fill("bench/longname");
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await page.waitForTimeout(3000);
      await R.step(page, brief ? "rv-l2-long-offer-brief" : "rv-l1-long-offer");
      const offer = page.getByTestId("link-offer");
      const lines = await offer.locator("p.text-xs").allTextContents();
      for (const l of lines) console.log(`${l.length}\t${l}`);
      const head = await offer.locator("p").first().textContent();
      console.log(`head ${head?.length}\t${head}`);
    }
  } finally {
    await browser.close();
  }
})();
