// Open a project's Reviews tab, expand the review's Details and screenshot. node review.cjs <bench> <label> <projectId>
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-2/scripts/bench/recorder.cjs");
const [NAME, LABEL, PROJECT] = process.argv.slice(2);
(async () => {
  const b = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", NAME, "bench.json"), "utf8"));
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(PROJECT)}/reviews`);
  await page.waitForTimeout(1500);
  const details = page.getByText("Details", { exact: true }).first();
  if (await details.count()) await details.click().catch(() => undefined);
  await page.waitForTimeout(800);
  const text = await R.step(page, `${LABEL} review details`);
  console.log(text.split("\n").filter((l) => /search|web page|source|opened/i.test(l)).join("\n"));
  await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(PROJECT)}/costs`);
  await page.waitForTimeout(1500);
  await R.step(page, `${LABEL} project costs`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
