// Neighbour: Undo of a chat start while its session runs; then Stop all elsewhere and Continue where it stopped.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const mk = async (name) => {
    const p = await R.api(N, "POST", "/projects", { name, goal: "Notes" });
    await R.api(N, "POST", `/projects/${p.id}/tasks`, { title: `Write notes/${name.split(" ")[0].toLowerCase()}.md`, outcome: "exists", riskTier: 1, specialist: "coder" });
    return p;
  };
  const u = await mk("Undone start");
  const v = await mk("Victor notes");
  const asked = await R.api(N, "POST", "/commands/execute", {
    commands: [{ name: "session.start", params: { project: u.id, budgetChf: 1 } }],
    wordsUsed: "start a session",
    source: "text",
    projectId: u.id,
  });
  out.asked = asked.status;
  const started = asked.status === "pending" ? await R.api(N, "POST", `/commands/${asked.pendingId}/confirm`, { answer: "tap" }).catch((e) => ({ err: String(e) })) : asked;
  out.started = started.status || started;
  const sU = await R.until(async () => (await R.api(N, "GET", `/sessions?projectId=${u.id}`)).find((x) => x.status === "running") || null, 30000, 300, "U running");
  await page.goto(`${ui}/changes`);
  await page.waitForTimeout(2000);
  const row = page.getByTestId("change").filter({ hasText: "Started a session on Undone start" }).first();
  out.rowWhileRunning = await row.innerText();
  await R.step(page, "rv-undo-changes-while-running");
  await row.getByTestId("change-undo").click();
  await page.waitForTimeout(2500);
  out.note = await page.getByTestId("changes-note").innerText().catch(() => null);
  await R.waitForSession(N, sU.id, 60000);
  out.sU = (await R.api(N, "GET", `/sessions/${sU.id}`)).stopReason;
  await R.step(page, "rv-undo-changes-after-undo");
  // V runs, Stop all, Continue where it stopped
  await R.api(N, "POST", "/sessions", { agentId: me.agent.id, projectId: v.id, trigger: "manual", reason: "walk" });
  const sV = await R.until(async () => (await R.api(N, "GET", `/sessions?projectId=${v.id}`)).find((x) => x.status === "running") || null, 30000, 300, "V running");
  await page.goto(`${ui}/`);
  await page.waitForTimeout(1500);
  await page.getByTestId("kill-switch").click();
  await page.getByTestId("kill-confirm-stop").click();
  await page.getByTestId("kill-banner").waitFor({ timeout: 15000 });
  await R.waitForSession(N, sV.id, 60000);
  const before = (await R.api(N, "GET", "/sessions")).map((s) => s.id);
  await page.getByTestId("kill-continue").click();
  await page.waitForTimeout(5000);
  const after = await R.api(N, "GET", "/sessions");
  out.newSessions = after.filter((s) => !before.includes(s.id)).map((s) => [s.projectId === u.id ? "U (undone start)" : s.projectId === v.id ? "V" : s.projectId, s.status]);
  await R.step(page, "rv-undo-home-after-continue");
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1); });
