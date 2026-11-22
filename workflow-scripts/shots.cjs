// Screenshots of the walk's tasks: the Tasks tab and the drawer with "See what was checked" open.
// Usage: node shots.cjs <bench name> <prefix>
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_7dea540b-2f3-4/scripts/bench/recorder.cjs");

const name = process.argv[2] ?? "fix-verification";
const prefix = process.argv[3] ?? "before";
const TITLES = {
  cli: "Write wc.js",
  api: "Write server.js",
  python: "Write src/mul.py",
  page: "Write index.html",
};

(async () => {
  const out = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", name, `walk-${prefix}.json`), "utf8"));
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page);
    const origin = new URL(page.url()).origin;
    for (const [key, o] of Object.entries(out)) {
      await page.goto(`${origin}/projects/${encodeURIComponent(o.projectId)}/tasks`);
      await page.waitForTimeout(1500);
      await R.step(page, `${prefix}-${key}-tasks`);
      await page.getByText(TITLES[key], { exact: true }).first().click().catch(() => undefined);
      await page.waitForTimeout(1200);
      const ev = page.getByText("See what was checked").first();
      if (await ev.count()) {
        await ev.click();
        await page.waitForTimeout(2000);
      }
      await R.step(page, `${prefix}-${key}-drawer`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
