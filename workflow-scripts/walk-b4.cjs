// Chat cancel, phrased as the live walk did: 'Skip the <title> task', then Yes.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
const fs = require("fs");
const path = require("path");
const N = "review-continuity";
const UI = "http://127.0.0.1:1671";
const OUT = "/tmp/frbench/review-continuity/steps";
const projectId = process.argv[2];
const phrase = process.argv[3];
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const res = {};
  try {
    await R.skipSetup(page);
    const ws = R.workspaceOf(N, projectId);
    const tasks = await R.api(N, "GET", `/projects/${projectId}/tasks`);
    const logic = tasks.find((t) => /script\.js/.test(t.title) && !/Check/.test(t.title));
    res.statusBefore = logic.status;
    res.scriptBefore = fs.existsSync(path.join(ws, "script.js"));
    await page.goto(`${UI}/projects/${projectId}/chat`);
    await page.waitForTimeout(1200);
    const input = page.getByPlaceholder("Message your agent…");
    await input.fill(phrase);
    await input.press("Enter");
    await page.waitForTimeout(3000);
    res.afterSkip = (await R.step(page, "b4-chat-skip")).split("Make this a task").slice(-1)[0].slice(0, 600);
    const yes = page.getByRole("button", { name: "Yes", exact: true });
    if (await yes.count()) {
      await yes.last().click();
      await page.waitForTimeout(2500);
      res.afterYes = (await R.step(page, "b4-chat-yes")).split("Make this a task").slice(-1)[0].slice(0, 800);
    }
    const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === logic.id);
    res.statusAfter = t.status;
    const gone = await R.until(async () => (!fs.existsSync(path.join(ws, "script.js")) ? true : null), 20_000, 300, "script.js removed").catch(() => false);
    res.scriptGone = gone === true;
  } finally {
    fs.writeFileSync(`${OUT}/b4-result.json`, JSON.stringify(res, null, 1));
    console.log(JSON.stringify(res, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
