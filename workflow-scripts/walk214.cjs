// Bench walk for the review's blocking item 1 (L4-money-214): a session whose only task the
// person stopped from its drawer while it ran.
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[2];
const name = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const out = { steps: [] };
const note = (k, v) => {
  out.steps.push({ k, v });
  console.log(k, typeof v === "string" ? v : JSON.stringify(v));
};

(async () => {
  const me = await R.api(name, "GET", "/me");
  const project = await R.api(name, "POST", "/projects", { name: "About club two", goal: "An about page" });
  const task = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
    title: "About page in about.html",
    outcome: "about.html says what the club is",
    riskTier: 1,
    specialist: "coder",
  });
  const { browser, page } = await R.openApp(name, { path: `/projects/${project.id}` });
  await R.skipSetup(page);
  const started = await R.api(name, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
  });
  const sessionId = started.session.id;
  const row = async () =>
    (await R.api(name, "GET", `/projects/${project.id}/tasks`)).find((t) => t.id === task.id);
  await R.until(async () => (await row())?.status === "in_progress", 60_000, 200, "the run to work");
  // The drawer's Stop, pressed in the app.
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/tasks?task=${task.id}`);
  await page.waitForTimeout(1200);
  const drawerText = await R.step(page, "214-drawer-while-running");
  note("drawer", drawerText.split("\n").filter((l) => /About page|Stop|Running|Working/.test(l)).slice(0, 8));
  const stopButton = page.getByTestId("drawer-action-stop");
  note("Stop buttons", await stopButton.count());
  if ((await stopButton.count()) > 0) {
    note("Stop line", await page.getByTestId("drawer-explain-stop").innerText());
    await stopButton.click();
    const confirm = page.getByTestId("confirm-action");
    if (await confirm.count()) {
      note("confirm", await page.getByTestId("action-explain").innerText());
      await R.step(page, "214-stop-confirm");
      await confirm.click();
    }
  } else {
    const shown = await R.api(name, "GET", `/tasks/${task.id}`);
    await R.api(name, "POST", `/tasks/${task.id}/action`, { version: shown.task.version, action: "stop" });
    note("stopped through the route", true);
  }
  const ended = await R.waitForSession(name, sessionId, 90_000);
  note("session", { status: ended.status, statusText: ended.statusText, summary: ended.summary });
  note("task", { status: (await row()).status, label: (await row()).display?.label });
  const inbox = await R.api(name, "GET", "/inbox");
  note("Updates of the project", inbox.messages.filter((m) => m.projectId === project.id).map((m) => m.body));
  const list = await R.api(name, "GET", `/projects/${project.id}/sessions`);
  const r = list.rows.find((x) => x.id === sessionId);
  note("Sessions row", { gist: r?.gist, countsWords: r?.countsWords, endedWords: r?.endedWords, startedBy: r?.startedBy });
  const tasks = await R.api(name, "GET", `/sessions/${sessionId}/tasks`);
  note("session tasks", tasks.tasks.map((t) => [t.title, t.here, t.now]));
  const statusFile = path.join(R.workspaceOf(name, project.id), "docs", "status.md");
  note("status note", fs.existsSync(statusFile) ? fs.readFileSync(statusFile, "utf8").split("\n").filter((l) => /Note/.test(l)) : "no status.md");
  await page.goto(`${R.bench(name).uiUrl}/sessions/${sessionId}`);
  await page.waitForTimeout(1500);
  note("session page", (await R.step(page, "214-session-page")).split("\n").filter((l) => /paused|Paused|Done|CHF|nothing/.test(l)).slice(0, 12));
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}`);
  await page.waitForTimeout(1500);
  note("overview", (await R.step(page, "214-overview")).split("\n").filter((l) => /paused|Since then|CHF|nothing/.test(l)).slice(0, 8));
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/sessions`);
  await page.waitForTimeout(1500);
  note("sessions tab", (await R.step(page, "214-sessions-tab")).split("\n").filter((l) => /paused|Nothing|session|CHF/.test(l)).slice(0, 10));
  await browser.close();
  fs.writeFileSync(path.join(R.bench(name).home, "..", "walk214.json"), JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
