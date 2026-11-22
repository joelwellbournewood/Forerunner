const { execFileSync } = require("node:child_process");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-3/scripts/bench/recorder.cjs");
const n = "fix-d1109-sessions";
const repo = "/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-3";
const home = "/tmp/frbench/fix-d1109-sessions/home";
const UI = "http://127.0.0.1:2182";
const ended = (s) => ["completed", "stopped", "failed", "killed"].includes(s.status);

async function addTask(projectId, title, priority = "medium") {
  return R.api(n, "POST", `/projects/${projectId}/tasks`, {
    title,
    outcome: `${title} is written`,
    acceptanceCriteria: ["the file exists"],
    priority,
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 1,
  });
}

async function startAndWaitRunning(projectId) {
  const started = await R.startSession(n, projectId);
  const id = started.session?.id;
  await R.until(
    async () => {
      const s = await R.api(n, "GET", `/sessions/${id}`);
      return s.currentTask ? s : null;
    },
    60_000,
    300,
    "the session to run a task",
  );
  return id;
}

(async () => {
  if (process.env.RESUME_PROJECT) return resume(process.env.RESUME_PROJECT, process.env.RESUME_DEAD);
  const { projectId } = await R.createPlannedProject(n, {
    project: "Quote page",
    goal: "A page that shows a quote",
    brief: "A page that shows a quote.",
  });
  console.log("project", projectId);
  // Approve and start's session: wait for it to end.
  await R.until(
    async () => {
      const s = await R.api(n, "GET", `/sessions?projectId=${projectId}`);
      return s.length >= 2 && s.every(ended) ? s : null;
    },
    300_000,
    1000,
    "Approve and start's session to end",
  );
  // A session the person stops mid-task.
  await addTask(projectId, "Write the notes in notes.md");
  const stopId = await startAndWaitRunning(projectId);
  await R.api(n, "POST", `/sessions/${stopId}/stop`, { reason: "stopped from the bench walk" });
  await R.waitForSession(n, stopId, 60_000);
  console.log("stopped", stopId);
  // A session Forerunner closes during: the daemon is killed, then starts again.
  await addTask(projectId, "Write the guide in guide.md");
  const deadId = await startAndWaitRunning(projectId);
  execFileSync("node", [`${repo}/scripts/bench/restart-daemon.mjs`, "--name", n, "--hard"], {
    stdio: "inherit",
  });
  await R.until(
    async () => {
      const s = await R.api(n, "GET", `/sessions/${deadId}`);
      return ended(s) ? s : null;
    },
    60_000,
    1000,
    "the interrupted session to be ended by the recovery",
  );
  console.log("interrupted", deadId, JSON.stringify((await R.api(n, "GET", `/sessions/${deadId}`)).statusText));
  return resume(projectId, deadId);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function resume(projectId, deadId) {
  // Older sessions to page through.
  execFileSync(
    "npx",
    [
      "tsx",
      "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/seed-sessions.mts",
      home,
      projectId,
      "21",
    ],
    { stdio: "inherit", cwd: repo },
  );
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  await R.skipSetup(page).catch(() => {});
  // The Overview's link.
  await page.goto(`${UI}/projects/${projectId}/summary`);
  await page.waitForTimeout(2500);
  console.log(await R.step(page, "after-overview-all-sessions"));
  // More ▾ lists Sessions first.
  await page.getByTestId("tab-more").locator("summary").click();
  await page.waitForTimeout(500);
  console.log(await R.step(page, "after-more-menu"));
  // A working session, live, while the list is open.
  await addTask(projectId, "Write the summary in summary.md", "high");
  const liveId = await startAndWaitRunning(projectId);
  await page.goto(`${UI}/projects/${projectId}/sessions`);
  await page.getByTestId("sessions-working").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  console.log(await R.step(page, "after-sessions-tab-working"));
  await R.waitForSession(n, liveId, 120_000);
  await page.waitForTimeout(6000);
  console.log(await R.step(page, "after-sessions-tab-ended"));
  // Show older sessions.
  await page.getByTestId("sessions-older").click();
  await page.waitForTimeout(1500);
  await page.getByTestId("sessions-older").scrollIntoViewIfNeeded().catch(() => {});
  console.log(await R.step(page, "after-sessions-older"));
  // A session page with its tasks: the plan's own session.
  const all = await R.api(n, "GET", `/projects/${projectId}/sessions?limit=50`);
  const planned = all.rows.find((r) => /^Did \d tasks?: /.test(r.gist) && r.countsWords && !r.gist.includes("page-"));
  if (planned) {
    await page.goto(`${UI}/sessions/${planned.id}`);
    await page.waitForTimeout(2500);
    console.log(await R.step(page, "after-session-page-tasks"));
  }
  const planning = all.rows.find((r) => r.planning);
  if (planning) {
    await page.goto(`${UI}/sessions/${planning.id}`);
    await page.waitForTimeout(2500);
    console.log(await R.step(page, "after-planning-session-page"));
  }
  await page.goto(`${UI}/sessions/${deadId}`);
  await page.waitForTimeout(2500);
  console.log(await R.step(page, "after-interrupted-session-page"));
  console.log(JSON.stringify(all.rows.slice(0, 6).map((r) => [r.gist, r.countsWords, r.endedWords, r.durationMs, r.spentWords]), null, 1));
  await browser.close();
}
