// Screenshot pages as a person sees them. Usage: node shot.cjs <repo> <bench> <label> <path> [<path> ...]
// A path may end with "#details" to press Details on the page first, or "#answered" to open the
// Inbox's Answered list.
const path = require("node:path");
const [repo, n, label, ...paths] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    let i = 0;
    for (const p of paths) {
      i++;
      const [route, hash] = p.split("#");
      await page.goto(`${R.bench(n).uiUrl}${route}`);
      await sleep(3000);
      if (hash === "details") {
        await page.getByRole("button", { name: "Details" }).first().click().catch(() => {});
        await sleep(1500);
      }
      if (hash === "answered") {
        await page.getByText(/^Answered \(/).first().click().catch(() => {});
        await sleep(1000);
      }
      const text = await R.step(page, `${label}-${i}`);
      console.log(`===== ${p}\n${text}`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
