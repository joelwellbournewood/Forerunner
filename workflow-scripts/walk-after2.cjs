// AFTER walk 2: a check that changes nothing quotes the left-out line (LC-C29 shape), and a small
// task with a CHF 0.08 budget gets its review (LC-C30 shape).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_801d579b-a17-1/scripts/bench/recorder.cjs");
const n = "fix-l4-selftasks-check";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(n);
  try {
    const ui = R.bench(n).uiUrl;
    const project = await R.api(n, "POST", "/projects", {
      name: "Tea room",
      goal: "A page for the tea room",
      autonomyLevel: 2,
    });
    await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Build the page in index.html",
      outcome: "index.html shows the tea room",
      acceptanceCriteria: ["index.html exists"],
      riskTier: 1,
      specialist: "coder",
    });
    // A README task with a budget of USD 0.10 (CHF 0.08), as live check 4's LC-C30.
    const readme = await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the README in README.md",
      outcome: "README.md says what the page is",
      acceptanceCriteria: ["README.md exists"],
      riskTier: 1,
      specialist: "coder",
      budgetUsdMicro: 100000,
    });
    const s = await R.startSession(n, project.id);
    const sid = s?.session?.id ?? s?.id;
    await R.waitForSession(n, sid);
    out.sessionId = sid;
    await page.goto(`${ui}/sessions/${sid}`).catch(() => {});
    await page.waitForTimeout(2500);
    out.session = await R.step(page, "after-06-session-no-change-quote");
    await page.goto(`${ui}/projects/${project.id}/tasks?task=${readme.id}`).catch(() => {});
    await page.waitForTimeout(2500);
    out.readme = await R.step(page, "after-07-small-task-reviewed");
    out.tasks = (await R.api(n, "GET", `/projects/${project.id}/tasks`)).map?.((t) => [
      t.title,
      t.status,
    ]);
    out.events = (await R.api(n, "GET", `/sessions/${sid}/events`))
      .filter?.((e) => /task_check|review/.test(e.type))
      .map((e) => ({ type: e.type, audience: e.audience, text: e.text }));
  } finally {
    await browser.close();
  }
  require("node:fs").writeFileSync(
    "/tmp/frbench/fix-l4-selftasks-check/walk-after2.json",
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify({ tasks: out.tasks, events: out.events }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
