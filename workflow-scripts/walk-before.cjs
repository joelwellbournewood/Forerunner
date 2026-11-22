// BEFORE walk (d1109-starts-engine): an answer with nothing running starts a session by itself.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-1/scripts/bench/recorder.cjs");
const n = process.argv[2] ?? "fix-d1109-starts-engine";
const label = process.argv[3] ?? "before";
(async () => {
  const me = await R.api(n, "GET", "/health").catch(() => ({}));
  const agents = await R.api(n, "GET", "/agents");
  const agentId = (agents.agents ?? agents)[0].id;
  const p = await R.api(n, "POST", "/projects", { name: `Quote page ${label}`, goal: "A quote page" });
  const pid = p.id;
  const t1 = await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Ask me about the quote wording",
    outcome: "notes/quote.md says which quote to use",
    acceptanceCriteria: ["notes/quote.md exists"],
    specialist: "writer",
    budgetUsdMicro: 300_000,
  });
  const t2 = await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Write the intro in intro.md",
    outcome: "intro.md has an intro",
    acceptanceCriteria: ["intro.md exists"],
    specialist: "writer",
    budgetUsdMicro: 300_000,
  });
  const s = await R.startSession(n, pid);
  const sid = s.session?.id;
  if (sid) await R.waitForSession(n, sid);
  const { browser, page } = await R.openApp(n);
  await R.skipSetup(page).catch(() => undefined);
  await page.goto(`${(await R.api(n, "GET", "/health").then(() => require(`/tmp/frbench/${n}/bench.json`).uiUrl))}/#/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-inbox-question`);
  const before = await R.api(n, "GET", `/projects/${pid}/sessions`).catch(() => null);
  // Answer with "Go ahead without" as a person does (the card's own button).
  const btn = page.getByRole("button", { name: "Go ahead without" }).first();
  await btn.click();
  await page.waitForTimeout(4000);
  await R.step(page, `${label}-inbox-after-answer`);
  const sessions = await R.api(n, "GET", "/sessions");
  const list = (sessions.sessions ?? sessions).filter((x) => x.projectId === pid);
  console.log(JSON.stringify({ pid, agentId, sessionsOfProject: list.length, statuses: list.map((x) => x.status), before: before && (before.rows ?? before.sessions ?? []).length }, null, 1));
  await page.goto(`${require(`/tmp/frbench/${n}/bench.json`).uiUrl}/#/projects/${pid}`);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-project-after-answer`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
