// Review walk: Add to on a project with tasks; 'Waiting for you: approve the plan' once (L4c-left-4).
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const n = process.argv[2];
const out = {};
(async () => {
  const { browser, page } = await R.openApp(n);
  const ui = R.bench(n).uiUrl;
  try {
    await page.goto(`${ui}/`);
    await page.getByTestId("new-project").click();
    await page.locator('input[name="name"]').fill("Kite club pages");
    await page.locator('[name="goal"]').fill("More pages for the club");
    await page.locator('[name="brief"]').fill("Add a page with the club's meeting times.");
    await page.locator('input[name="repo"]').fill("https://github.com/bench/seeded");
    await page.getByTestId("create-project").click();
    await page.getByTestId("link-offer").waitFor({ timeout: 30_000 });
    out.offer = await R.step(page, "addto-01-offer");
    const t0 = Date.now();
    await page.getByTestId("offer-add").click();
    await page.waitForTimeout(300);
    out.adding = await R.step(page, "addto-02-adding");
    await page.waitForURL(/\/projects\//, { timeout: 90_000 });
    out.navigatedAfterMs = Date.now() - t0;
    await page.getByTestId("intake-banner").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    out.page = await R.step(page, "addto-03-project-page");
    const text = await page.locator("body").innerText();
    out.count = text.split("Waiting for you: approve the plan").length - 1;
    out.bannerState = await page.getByTestId("intake-banner").getAttribute("data-state");
    out.statusShown = await page.getByTestId("project-status").count();
    fs.writeFileSync(path.join(`/tmp/frbench/${n}`, "steps", "walk-addto.json"), JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
