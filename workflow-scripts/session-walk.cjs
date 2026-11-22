// A session-budget pause on the bench (W6-21): FORERUNNER_BENCH_USAGE="Long report:1200000" makes
// each call of "Long report" cost about USD 1.20, so a session of CHF 2.00 pauses it at the first
// stop with one card; Continue starts the next session at once.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-1/scripts/bench/recorder.cjs");
const NAME = "fix-budget-resume";
const LABEL = process.argv[2] || "session";
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Session pause (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: "The club's annual report",
  });
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Long report in report.md",
    outcome: "report.md holds the annual report",
    acceptanceCriteria: ["report.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 50_000_000,
    specialist: "coder",
    riskTier: 1,
  });
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    budgetUsdMicro: 2_500_000,
  });
  const s1 = await R.waitForSession(NAME, started.session.id, 300_000);
  console.log("session 1:", s1.status, "|", s1.summary);
  const inbox = await R.api(NAME, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.taskId === task.id && r.status === "open");
  console.log("card:", card?.title, "|", card?.body, "|", (card?.choices ?? []).map((c) => `${c.label}: ${c.explain}`).join(" / "));
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} session-budget card`);
    await page.goto(`${b.uiUrl}/sessions/${enc(s1.id)}`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} session ended at its budget`);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    const item = page.getByTestId("request").filter({ hasText: card.title }).first();
    const before = (await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`)).length;
    await item.getByTestId("option").filter({ hasText: "Continue" }).first().click();
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} continue pressed`);
    const after = await R.until(
      async () => {
        const all = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
        return all.length > before ? all : null;
      },
      15_000,
      250,
      "a session after Continue",
    );
    const newest = after.find((x) => x.id !== s1.id);
    console.log("Continue started a session:", !!newest, "budget", newest?.budgetCap ?? newest?.budget);
    const s2 = await R.waitForSession(NAME, newest.id, 300_000);
    console.log("session 2:", s2.status, "|", s2.summary);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
