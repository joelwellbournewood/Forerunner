// Bench walk for l4-starts-sessions (run L4): the screens L4-money-202, 208, 209 and 213 change.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2baa1a48-8fe-1/scripts/bench/recorder.cjs");
const n = process.argv[2] || "fix-l4-starts-sessions";
const tag = process.argv[3] || "after";
const task = (title, specialist = "coder") => ({
  title,
  outcome: `${title} is written`,
  acceptanceCriteria: ["it is written"],
  priority: "medium",
  status: "ready",
  dependsOn: [],
  budgetUsdMicro: 0,
  specialist,
  riskTier: 0,
});
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    const agents = await R.api(n, "GET", "/agents");
    const agentId = agents[0].id;
    const club = await R.api(n, "POST", "/projects", { name: "Club site", goal: "A club page" });
    await R.api(n, "POST", `/projects/${club.id}/tasks`, task("Write the long club guide in guide.md"));
    await R.api(n, "POST", `/projects/${club.id}/tasks`, task("Write the club motto in motto.txt"));
    const birds = await R.api(n, "POST", "/projects", { name: "Bird notes", goal: "Notes" });
    await R.api(n, "POST", `/projects/${birds.id}/tasks`, task("Write notes/wren.md"));
    const first = await R.api(n, "POST", "/sessions", { agentId, projectId: club.id, trigger: "manual" });
    out.first = first.result;
    await R.until(async () => {
      const run = await R.api(n, "GET", "/running");
      return run.some((v) => v.state === "working");
    }, 60_000, 500, "the club session to work");
    await page.goto(`${R.bench(n).uiUrl.replace(/\?.*$/, "")}/projects/${club.id}/summary`).catch(() => {});
    await page.waitForTimeout(1500);
    out.overview = await R.step(page, `${tag}-208-overview-working`);
    // L4-money-209: Bird notes' start waits behind it.
    const second = await R.api(n, "POST", "/sessions", { agentId, projectId: birds.id, trigger: "manual" });
    out.second = second.result;
    const again = await R.api(n, "POST", "/sessions", { agentId, projectId: birds.id, trigger: "manual" });
    out.again = { result: again.result, sentence: again.sentence ?? null, same: again.startId === second.startId };
    await page.goto(`${R.bench(n).uiUrl.replace(/\?.*$/, "")}/projects/${birds.id}/summary`).catch(() => {});
    await page.waitForTimeout(1500);
    out.queued = await R.step(page, `${tag}-209-queued-header`);
    out.queuedStartButton = await page.getByTestId("start-session").count();
    await page.setViewportSize({ width: 375, height: 800 });
    await R.step(page, `${tag}-209-queued-header-375`);
    await page.setViewportSize({ width: 1280, height: 800 });
    // The session page while it runs.
    if (first.session?.id) {
      await page.goto(`${R.bench(n).uiUrl.replace(/\?.*$/, "")}/sessions/${first.session.id}`).catch(() => {});
      await page.waitForTimeout(1500);
      out.sessionPage = await R.step(page, `${tag}-208-session-page`);
    }
    console.log(JSON.stringify(out, null, 1).slice(0, 6000));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
