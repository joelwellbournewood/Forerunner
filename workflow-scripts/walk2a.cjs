// W15-27 on the bench: a review refused at the project's budget, then the person raises it.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "review-w15-review";
const enc = encodeURIComponent;
const out = {};
(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: "Budget review",
    goal: "A review page within a tiny budget",
  });
  out.projectId = project.id;
  let set = await R.api(NAME, "POST", "/commands/execute", {
    commands: [{ name: "budget.set", params: { scope: "project", amountChf: 0.01, project: project.id } }],
    wordsUsed: "Settings: Project budget to 0.01",
    source: "ui",
    projectId: project.id,
  });
  if (set.status === "pending")
    set = await R.api(NAME, "POST", `/commands/${enc(set.pendingId)}/confirm`, { answer: "tap" });
  out.set = set.status;
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the review page in review.html",
    outcome: "review.html shows the club's review",
    acceptanceCriteria: ["review.html exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
    riskTier: 1,
  });
  out.taskId = task.id;
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "budget review walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  out.session1 = { id: session.id, status: session.status, summary: session.summary };
  out.task1 = await R.api(NAME, "GET", `/tasks/${enc(task.id)}`);
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2500);
    out.s1Text = await R.step(page, "w2 session 1");
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    out.inboxText = await R.step(page, "w2 inbox review waits");
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/settings`);
    await page.waitForTimeout(2500);
    out.settingsText = await R.step(page, "w2 project settings");
  } finally {
    await browser.close();
  }
  fs.writeFileSync("/tmp/frbench/review-w15-review/steps/walk2a.json", JSON.stringify(out, null, 1));
  console.log("done", JSON.stringify(out.session1));
})().catch((e) => {
  console.error(e);
  fs.writeFileSync("/tmp/frbench/review-w15-review/steps/walk2a-error.json", JSON.stringify({ error: String(e?.stack ?? e), out }, null, 1));
  process.exit(1);
});
