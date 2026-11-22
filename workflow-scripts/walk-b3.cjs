// Review walk (b3): cancel a running task from chat (the project's Chat tab), Yes on the
// read-back; the run stops, its file leaves the folder.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
const fs = require("fs");
const path = require("path");
const N = "review-continuity";
const UI = "http://127.0.0.1:1671";
const OUT = "/tmp/frbench/review-continuity/steps";
const log = (...a) => console.log("[b3]", ...a);
const projectId = process.argv[2];
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const res = {};
  try {
    await R.skipSetup(page);
    const ws = R.workspaceOf(N, projectId);
    const tasks = await R.api(N, "GET", `/projects/${projectId}/tasks`);
    const logic = tasks.find((t) => /script\.js/.test(t.title) && !/Check/.test(t.title));
    // script.js is back from the undo; remove it by hand? No: the run rewrites it. Wait until the
    // run writes again (mtime changes) while it runs.
    const before = fs.statSync(path.join(ws, "script.js")).mtimeMs;
    await page.goto(`${UI}/projects/${projectId}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Continue|Start session)$/ }).first().click();
    await page.waitForTimeout(1000);
    await R.step(page, "b3-start-dialog");
    const startBtn = page.getByRole("dialog").getByRole("button", { name: /^Start/ });
    await startBtn.first().click();
    await page.waitForTimeout(1000);
    await R.until(async () => {
      const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === logic.id);
      if (["in_review", "done"].includes(t.status)) throw new Error(`too late: ${t.status}`);
      if (!["claimed", "in_progress"].includes(t.status)) return null;
      return fs.statSync(path.join(ws, "script.js")).mtimeMs > before ? t : null;
    }, 200_000, 300, "logic running with script.js rewritten");
    await page.goto(`${UI}/projects/${projectId}/chat`);
    await page.waitForTimeout(1500);
    const input = page.getByPlaceholder("Message your agent…");
    await input.fill(`Skip the task "${logic.title}"`);
    await input.press("Enter");
    await page.waitForTimeout(3500);
    res.afterSkip = await R.step(page, "b3-chat-skip");
    const yes = page.getByRole("button", { name: "Yes", exact: true });
    if (await yes.count()) {
      await yes.last().click();
      await page.waitForTimeout(2500);
      res.afterYes = await R.step(page, "b3-chat-yes");
      res.path = "intent";
    } else {
      res.path = "none";
    }
    const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === logic.id);
    res.logicAfter = t.status;
    const gone = await R.until(async () => (!fs.existsSync(path.join(ws, "script.js")) ? true : null), 30_000, 300, "script.js removed").catch(() => false);
    res.scriptGone = gone === true;
    log(JSON.stringify({ path: res.path, logicAfter: res.logicAfter, scriptGone: res.scriptGone }));
  } finally {
    fs.writeFileSync(`${OUT}/b3-result.json`, JSON.stringify(res, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
