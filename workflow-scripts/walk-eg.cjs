// Review walk (e) the planning session's page; (g) the ladder hand-over on the session page and drawer.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  // (e)
  const sessions = await R.api(N, "GET", "/sessions");
  const intake = sessions.find((s) => /^intake:/.test(s.summary || ""));
  await page.goto(`${ui}/sessions/${intake.id}`);
  await page.waitForTimeout(2500);
  out.planningText = await R.step(page, "rv-e-planning-session");
  out.planningEmpty = await page.getByTestId("event-log-empty").innerText().catch(() => null);
  const det = page.getByTestId("details-toggle");
  if (await det.count()) {
    await det.click();
    await page.waitForTimeout(800);
    out.planningDetails = (await page.getByTestId("event-row").allInnerTexts()).slice(0, 6);
    await R.step(page, "rv-e-planning-session-details");
  }
  // a finished normal session's page too (neighbour)
  const normal = sessions.find((s) => !/^intake:/.test(s.summary || "") && s.status === "completed");
  await page.goto(`${ui}/sessions/${normal.id}`);
  await page.waitForTimeout(2500);
  out.normalEmpty = await page.getByTestId("event-log-empty").innerText().catch(() => null);
  await R.step(page, "rv-e-normal-ended-session");

  // (g)
  const project = await R.api(N, "POST", "/projects", { name: "Ladder walk", goal: "Notes on the ladder" });
  const task = await R.api(N, "POST", `/projects/${project.id}/tasks`, {
    title: "Ladder notes: write notes/ladder.md",
    outcome: "notes/ladder.md lists the steps",
    riskTier: 1,
    specialist: "coder",
  });
  out.ladderProject = project.id;
  out.ladderTask = task.id;
  await page.goto(`${ui}/projects/${project.id}`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv-g-project-before-start");
  await page.getByRole("button", { name: /^(Start session|Start|Continue)$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  out.dialogText = await dialog.innerText();
  await R.step(page, "rv-g-start-dialog");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForTimeout(2000);
  const s = await R.until(async () => {
    const ss = await R.api(N, "GET", `/sessions?projectId=${project.id}`);
    return ss[0] || null;
  }, 30000, 500, "the ladder session");
  out.ladderSession = s.id;
  await R.waitForSession(N, s.id, 300000);
  await page.goto(`${ui}/sessions/${s.id}`);
  await page.waitForTimeout(2500);
  out.sessionText = await R.step(page, "rv-g-session-page");
  out.personLines = await page.getByTestId("event-row").allInnerTexts();
  const events = await R.api(N, "GET", `/sessions/${s.id}/events`);
  out.taskEvents = events
    .filter((e) => /^task\.(started|finished)$|critic/.test(e.type))
    .map((e) => [e.type, e.payload && e.payload.specialist, e.payload && e.payload.handedFrom, e.text]);
  out.warnings = events.filter((e) => e.type === "warning").map((e) => e.text);
  await page.goto(`${ui}/projects/${project.id}/tasks?task=${task.id}`);
  await page.getByTestId("task-drawer").waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  out.drawerRuns = await page.getByTestId("drawer-run").allInnerTexts();
  await R.step(page, "rv-g-drawer");
  const detail = await R.api(N, "GET", `/tasks/${task.id}`);
  out.detailRuns = detail.runs.map((r) => [r.kind, r.specialist, r.outcome]);
  out.taskStatus = detail.task ? detail.task.status : undefined;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
