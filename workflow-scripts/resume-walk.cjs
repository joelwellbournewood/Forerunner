// Live learner vs. the fold after a restart, for a task that stopped at its budget and was then
// raised and finished (cost area: "a task with a paused or budget_exceeded run is no sample").
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_dbd51cc4-c3a-7/scripts/bench/recorder.cjs");
const N = "review-cost";
const enc = encodeURIComponent;
const CHF = Number(process.argv[2] || 0.004);
const usdMicro = (chf) => Math.round((chf / 0.8) * 1_000_000);
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/resume-walk.json";
const result = {};

(async () => {
  const project = await R.api(N, "POST", "/projects", { name: "Raise walk", goal: "Notes within a budget" });
  const task = await R.api(N, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the notes",
    outcome: "notes.md lists the meetings",
    acceptanceCriteria: ["notes.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: usdMicro(CHF),
    specialist: "coder",
    riskTier: 1,
  });
  result.taskId = task.id;
  const s1 = await R.startSession(N, project.id, "first try");
  const sid1 = s1.session?.id ?? s1.id ?? s1.sessionId;
  await R.waitForSession(N, sid1, 600_000);
  const runs1 = await R.api(N, "GET", `/tasks/${enc(task.id)}/runs`).catch((e) => e.message);
  result.afterFirst = { task: await R.api(N, "GET", `/tasks/${enc(task.id)}`).catch((e) => e.message), runs: runs1 };
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await page.waitForTimeout(1500);
    const t0 = await page.evaluate(() => document.body.innerText);
    if (/Set up later/.test(t0)) await R.skipSetup(page);
    await page.getByRole("link", { name: /^Inbox/ }).first().click();
    await page.waitForTimeout(1500);
    result.inboxText = await R.step(page, "inbox with the budget card");
    await page.getByRole("button", { name: "Raise the budget", exact: true }).first().click();
    await page.waitForTimeout(2500);
    await R.step(page, "after raise the budget");
  } finally {
    await browser.close();
  }
  // Wait for the task to finish its second try.
  await R.until(async () => {
    const tasks = await R.api(N, "GET", `/projects/${enc(project.id)}/tasks`);
    const t = tasks.find((x) => x.id === task.id);
    return t && ["done", "failed", "cancelled"].includes(t.status) ? t : null;
  }, 600_000, 2000, "the task to finish");
  const sessions = await R.api(N, "GET", `/sessions?projectId=${enc(project.id)}`);
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!["completed", "stopped", "failed", "killed"].includes(s.status)) await R.waitForSession(N, s.id, 600_000);
  }
  const tasks = await R.api(N, "GET", `/projects/${enc(project.id)}/tasks`);
  result.finalTask = tasks.find((x) => x.id === task.id);
  const live = await R.api(N, "GET", "/costs/estimates");
  result.liveRecent = live.recent;
  result.liveRows = live.rows;
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log("final status", result.finalTask?.status);
  console.log("LIVE recent", JSON.stringify(live.recent.map((r) => [r.task_id === task.id ? "THIS TASK" : r.task_id, r.estimate_usd_micro, r.actual_usd_micro])));
  console.log("LIVE rows", JSON.stringify(live.rows));
})().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ ...result, error: String(e && e.stack) }, null, 1));
  console.error(e);
  process.exit(1);
});
