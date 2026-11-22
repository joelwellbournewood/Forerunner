// Open a session's log with Details on and take a screenshot. node details.cjs <bench> <label> <sessionId>
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-2/scripts/bench/recorder.cjs");
const [NAME, LABEL, SESSION] = process.argv.slice(2);
(async () => {
  const b = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", NAME, "bench.json"), "utf8"));
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  await page.goto(`${b.uiUrl}/sessions/${encodeURIComponent(SESSION)}`);
  await page.waitForTimeout(1500);
  const box = page.getByLabel("Details");
  if (await box.count()) await box.first().check().catch(() => undefined);
  await page.waitForTimeout(1000);
  const follow = page.getByLabel("Follow");
  if (await follow.count()) await follow.first().uncheck().catch(() => undefined);
  const line = page.getByText(process.env.LINE ? new RegExp(process.env.LINE) : /^searched the web for/).first();
  if (await line.count()) await line.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(b.steps, `${LABEL}-search-line.png`) });
  const text = await R.step(page, `${LABEL} session log details`);
  console.log(text.split("\n").filter((l) => /search|web page|Web/i.test(l)).join("\n"));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
