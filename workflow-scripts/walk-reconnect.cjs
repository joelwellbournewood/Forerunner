// Regression probe: the pattern session-engine.cjs uses after restart-daemon.mjs
// (spawnSync restart, R.reconnect(page), page.goto) while openApp's followDaemon also reloads.
"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-8";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const NAME = "review-bench";
(async () => {
  const { browser, page } = await R.openApp(NAME);
  const errors = [];
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Todo list");
    for (let i = 0; i < 3; i++) {
      const b0 = R.bench(NAME);
      await page.goto(`${b0.uiUrl}/projects/${encodeURIComponent(p.id)}`);
      await page.waitForTimeout(1200);
      const r = spawnSync(
        process.execPath,
        [path.join(REPO, "scripts", "bench", "restart-daemon.mjs"), "--name", NAME, ...(i === 1 ? ["--hard"] : [])],
        { encoding: "utf8" },
      );
      console.log(`restart ${i}: ${r.status} ${r.stdout.trim().slice(-160)} ${r.stderr.trim().slice(-200)}`);
      try {
        await R.reconnect(page, NAME);
        await page.goto(`${R.bench(NAME).uiUrl}/projects/${encodeURIComponent(p.id)}/tasks`);
        await page.waitForTimeout(2500);
        const t = await R.step(page, `r0${i} after restart ${i}`);
        console.log(`round ${i}: connected=${/connected/.test(t) && !/not connected/.test(t)}; tasks tab=${/Build the first/.test(t)}`);
      } catch (e) {
        errors.push(String(e.message).split("\n")[0]);
        console.log(`round ${i}: ERROR ${String(e.message).split("\n")[0]}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log("errors:", JSON.stringify(errors));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
