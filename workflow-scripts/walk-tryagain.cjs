// Walk: a failed task's card "Try again" with nothing running. BEFORE: a session starts by itself.
// AFTER: nothing starts; the Done line says it runs at the next Start.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-1/scripts/bench/recorder.cjs");
const n = "fix-d1109-starts-engine";
const label = process.argv[2] ?? "before";
const ui = () => require(`/tmp/frbench/${n}/bench.json`).uiUrl;
(async () => {
  const p = await R.api(n, "POST", "/projects", { name: `Retry page ${label}`, goal: "A page" });
  const pid = p.id;
  await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Fail me: write the page in page.html",
    outcome: "page.html exists",
    acceptanceCriteria: ["page.html exists"],
    specialist: "writer",
    budgetUsdMicro: 300_000,
  });
  const s = await R.startSession(n, pid);
  if (s.session?.id) await R.waitForSession(n, s.session.id);
  await R.until(
    async () => (await R.api(n, "GET", "/inbox")).requests.some((r) => r.projectId === pid && r.status === "open"),
    60_000,
    1000,
    "the failed task's card",
  );
  const { browser, page } = await R.openApp(n);
  await page.waitForTimeout(2000);
  await page.goto(`${ui()}/inbox`).catch(() => undefined);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-retry-card`);
  const count = async () => {
    const all = await R.api(n, "GET", "/sessions");
    return (all.sessions ?? all).filter((x) => x.projectId === pid);
  };
  const before = (await count()).length;
  await page.getByRole("button", { name: "Try again" }).first().click();
  await page.waitForTimeout(6000);
  await R.step(page, `${label}-retry-after-answer`);
  const after = await count();
  console.log(JSON.stringify({ label, before, after: after.length, statuses: after.map((x) => [x.status, x.trigger]) }));
  await page.goto(`${ui()}/projects/${pid}/tasks`).catch(() => undefined);
  await page.waitForTimeout(2500);
  await R.step(page, `${label}-retry-tasks`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
