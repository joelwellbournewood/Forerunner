// C-41: a review stopped by Stop now, as the drawer shows it.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-9/scripts/bench/recorder.cjs");
const N = "fixup-screens";
const tag = process.argv[2] || "after";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const p = await R.api(N, "POST", "/projects", { name: `Review stop walk ${tag}`, goal: "Notes" });
  const t = await R.api(N, "POST", `/projects/${p.id}/tasks`, {
    title: "Write notes/review.md",
    outcome: "notes/review.md exists",
    riskTier: 1,
    specialist: "coder",
  });
  await R.api(N, "POST", "/sessions", { agentId: me.agent.id, projectId: p.id, trigger: "manual", reason: "walk" });
  const s = await R.until(async () => (await R.api(N, "GET", `/sessions?projectId=${p.id}`))[0] || null, 30000, 300, "s");
  await R.until(async () => {
    const tt = await R.api(N, "GET", `/projects/${p.id}/tasks`);
    return tt[0] && tt[0].status === "in_review" ? true : null;
  }, 60000, 300, "Being reviewed");
  await page.goto(`${ui}/sessions/${s.id}`);
  await page.waitForTimeout(3000);
  await R.step(page, `fx-c41-${tag}-session-in-review`);
  await page.getByTestId("stop-now").click();
  await page.waitForTimeout(500);
  await page.getByTestId("stop-session").click();
  await R.waitForSession(N, s.id, 60000);
  await page.waitForTimeout(1500);
  out.sessionAfter = await R.step(page, `fx-c41-${tag}-session-stopped`);
  await page.goto(`${ui}/projects/${p.id}/tasks?task=${t.id}`);
  await page.getByTestId("task-drawer").waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  out.runs = await page.getByTestId("drawer-run").allInnerTexts();
  out.drawer = await R.step(page, `fx-c41-${tag}-drawer`);
  out.taskStatus = (await R.api(N, "GET", `/projects/${p.id}/tasks`))[0].status;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1); });
