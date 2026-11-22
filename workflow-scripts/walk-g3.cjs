// Review walk: (g') the stand-in's own attempt fails too: whom do the person lines name? and C-54 (Mark done anyway -> Overview).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const run = async (projectId) => {
    await R.api(N, "POST", "/sessions", { agentId: me.agent.id, projectId, trigger: "manual", reason: "review walk" });
    const s = await R.until(async () => {
      const ss = await R.api(N, "GET", `/sessions?projectId=${projectId}`);
      return ss[0] || null;
    }, 30000, 300, "session");
    return R.waitForSession(N, s.id, 300000);
  };
  // g'
  const p = await R.api(N, "POST", "/projects", { name: "Third ladder walk", goal: "Notes" });
  const t = await R.api(N, "POST", `/projects/${p.id}/tasks`, {
    title: "Third ladder: write notes/third.md",
    outcome: "notes/third.md lists the steps",
    riskTier: 1,
    specialist: "coder",
  });
  const s = await run(p.id);
  await page.goto(`${ui}/sessions/${s.id}`);
  await page.waitForTimeout(2500);
  out.gSession = await R.step(page, "rv-g3-session-page");
  const ev = await R.api(N, "GET", `/sessions/${s.id}/events`);
  out.gEvents = ev.filter((e) => e.audience === "person").map((e) => [e.type, e.payload && e.payload.specialist, e.text]);
  const d = await R.api(N, "GET", `/tasks/${t.id}`);
  out.gRuns = d.runs.map((r) => [r.kind, r.specialist, r.outcome]);
  // C-54
  const p2 = await R.api(N, "POST", "/projects", { name: "Since walk", goal: "True now" });
  const t2 = await R.api(N, "POST", `/projects/${p2.id}/tasks`, {
    title: "Since then: write docs/plan.md",
    outcome: "docs/plan.md lists the steps",
    riskTier: 1,
    specialist: "writer",
  });
  await run(p2.id);
  await page.goto(`${ui}/projects/${p2.id}`);
  await page.waitForTimeout(2500);
  out.c54Before = await R.step(page, "rv-c54-overview-before");
  // Answer the card in the Inbox with Mark done anyway
  await page.goto(`${ui}/inbox`);
  await page.waitForTimeout(2500);
  const card = page.getByTestId("request").filter({ hasText: "Since then" }).first();
  out.card = await card.innerText().catch(() => null);
  await R.step(page, "rv-c54-inbox-card");
  const btn = card.getByRole("button", { name: "Mark done anyway", exact: true });
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(800);
    const yes = page.getByTestId("choice-confirm-yes");
    if (await yes.count()) await yes.first().click();
    await page.waitForTimeout(2500);
    await R.step(page, "rv-c54-inbox-after");
  }
  await page.goto(`${ui}/projects/${p2.id}`);
  await page.waitForTimeout(2500);
  out.c54After = await R.step(page, "rv-c54-overview-after");
  out.c54Since = await page.getByTestId("last-result-since").innerText().catch(() => null);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1); });
