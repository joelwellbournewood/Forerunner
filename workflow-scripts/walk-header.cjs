const path = require("node:path");
const repo = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const n = process.argv[2];
(async () => {
  const { browser, page } = await R.openApp(n);
  try {
    await page.goto(`${R.bench(n).uiUrl}/projects/01a20000-0000-7000-8000-000000000000/summary`);
    await page.waitForTimeout(3000);
    const text = await R.step(page, "header-unknown-project");
    console.log(text.slice(0, 400));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
