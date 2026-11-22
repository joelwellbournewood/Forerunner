// Walk: a fresh bench whose setup was never finished; the setup assistant with a GitHub token
// (the fake host's), then Start using Forerunner. Records what the page shows after the
// daemon's restart (exit 86), whether the daemon came back and what daemon.log says.
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-4/scripts/bench/recorder.cjs");
const NAME = process.argv[2] || "fix-bench";
const TOKEN = process.argv[3];
(async () => {
  const before = R.bench(NAME);
  const out = { pidBefore: before.pids.daemon, tokenBefore: before.token.slice(0, 4) };
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  await page.waitForTimeout(1500);
  await R.step(page, "setup welcome");
  await page.getByTestId("setup-name").fill("Bench Person");
  await page.getByTestId("setup-next").click();
  await page.waitForTimeout(800);
  await R.step(page, "setup claude");
  await page.getByTestId("setup-next").click();
  await page.waitForTimeout(800);
  await page.getByTestId("setup-github-input").fill(TOKEN);
  await page.getByTestId("setup-github-input").press("Enter");
  await page.waitForTimeout(3000);
  await R.step(page, "setup github checked");
  await page.getByTestId("setup-next").click();
  await page.waitForTimeout(800);
  await R.step(page, "setup done");
  await page.getByTestId("setup-finish").click();
  await page.waitForTimeout(3000);
  out.afterFinish = await R.step(page, "after start using forerunner");
  // Wait up to 60 s for the page to land on Home with data (or for nothing to happen).
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const t = await page.evaluate(() => document.body.innerText);
    if (/New project/.test(t) && !/Set up Forerunner/.test(t)) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  out.after60s = await R.step(page, "a minute later");
  const after = R.bench(NAME);
  out.pidAfter = after.pids.daemon;
  out.daemonAlive = await R.apiRaw(NAME, "GET", "/health").then(
    (r) => r.status,
    (e) => `no answer: ${e.message}`,
  );
  out.projects = await R.apiRaw(NAME, "GET", "/projects").then(
    (r) => r.status,
    (e) => `no answer: ${e.message}`,
  );
  out.daemonLogTail = fs
    .readFileSync(after.logs.daemon, "utf8")
    .split("\n")
    .filter((l) => /restart|exit|bench|listening/i.test(l))
    .slice(-12);
  out.problems = R.problems ? R.problems(NAME).slice(-8) : [];
  fs.writeFileSync(`${after.steps}/walk-setup.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
