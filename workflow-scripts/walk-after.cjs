// AFTER walk of l4-selftasks-check on the stand-in (bench fix-l4-selftasks-check).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_801d579b-a17-1/scripts/bench/recorder.cjs");
const n = "fix-l4-selftasks-check";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    // LC-C29/LC-C18 shapes: a project at Standard, the report's lines planted on "Create the page".
    const project = await R.api(n, "POST", "/projects", {
      name: "Garden club",
      goal: "A page for the garden club",
      autonomyLevel: 2,
    });
    const page1 = await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Create the page in index.html",
      outcome: "index.html shows the garden club",
      acceptanceCriteria: ["index.html exists"],
      riskTier: 1,
      specialist: "coder",
    });
    await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the FAQ",
      outcome: "faq.html answers the club's questions",
      acceptanceCriteria: ["faq.html exists"],
      riskTier: 1,
      specialist: "coder",
      dependsOn: [page1.id],
    });
    const s = await R.startSession(n, project.id);
    const sid = s?.session?.id ?? s?.id;
    await R.waitForSession(n, sid);
    out.sessionId = sid;
    await page.goto(`${(R.bench(n)).uiUrl}/sessions/${sid}`).catch(() => {});
    await page.waitForTimeout(2500);
    out.session = await R.step(page, "after-01-session-page");
    await page.goto(`${(R.bench(n)).uiUrl}/inbox`).catch(() => {});
    await page.waitForTimeout(2500);
    out.inbox = await R.step(page, "after-02-inbox-suggestion-card");
    await page.goto(`${(R.bench(n)).uiUrl}/projects/${project.id}`).catch(() => {});
    await page.waitForTimeout(2500);
    out.overview = await R.step(page, "after-03-project-status-line");
    await page.goto(`${(R.bench(n)).uiUrl}/projects/${project.id}/tasks`).catch(() => {});
    await page.waitForTimeout(2500);
    out.tasks = await R.step(page, "after-04-tasks");
    await page.goto(`${(R.bench(n)).uiUrl}/projects/${project.id}/costs`).catch(() => {});
    await page.waitForTimeout(2500);
    out.costs = await R.step(page, "after-05-costs");
    out.events = (await R.api(n, "GET", `/sessions/${sid}/events`))
      .filter?.((e) => /task_check/.test(e.type))
      .map((e) => ({ type: e.type, audience: e.audience, text: e.text }));
  } finally {
    await browser.close();
  }
  require("node:fs").writeFileSync(
    "/tmp/frbench/fix-l4-selftasks-check/walk-after.json",
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out.events, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
