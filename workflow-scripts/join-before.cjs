// Before (the base branch's code): two projects in one folder, and nothing on either Overview
// says so or offers to make one project.
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-1";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fix-d1109-onerepo-join";
const B = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));

(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${B().uiUrl}/`);
    await page.getByTestId("project-card").first().waitFor({ timeout: 30_000 });
    const home = await R.step(page, "before-01-home-two-projects-one-folder");
    console.log("home:", home.slice(0, 300).replace(/\n/g, " | "));
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    await page.getByTestId("summary-tab").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const site = await R.step(page, "before-02-site-overview-no-line");
    console.log("site mentions Kite:", /Kite club/.test(site), "Make one:", /Make one project/.test(site));
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    await page.getByTestId("summary-tab").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const kite = await R.step(page, "before-03-kite-overview-no-line");
    console.log("kite mentions Site:", /\bSite\b/.test(kite), "Make one:", /Make one project/.test(kite));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
