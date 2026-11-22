// Walk B: both credentials, 'Subscription first, ask before API key', the subscription at its
// limit for an hour (failure injection: limits.restingUntil, as Claude Code's limit leaves it).
// The person in Zurich presses Start; the ask card and its notification; answer Wait (or Use API
// key with argv[2] = "use") in the Inbox UI; then the session page, the Overview's Last result
// and the Inbox read what is true now. Phase 2 (argv[3] = "after-restart") reads them again.
const L = require("./walk-lib.cjs");
const { R, N, enc } = L;
const mode = process.argv[2] || "wait";
const phase = process.argv[3] || "first";
const file = `walk-b-${mode}-${phase}.json`;
const out = { at: new Date().toISOString(), mode, phase };
(async () => {
  const { browser, page } = await R.openApp(N, { path: "/" });
  let projectId;
  if (phase === "first") {
    out.tz = (await R.api(N, "POST", "/setup/profile", { timezone: "Europe/Zurich" })).timezone;
    // The plan is drafted on the key first (the bench has no Claude Code), then the person picks
    // 'ask' and the subscription is at its limit for an hour (failure injection).
    await L.cmd([{ name: "settings.set", params: { key: "credential_policy", value: "key_only" } }]);
    const planned = await R.createPlannedProject(N, {
      project: `Pond notes ${mode}`,
      goal: "Pond notes",
      brief: "Write a short markdown note about the pond in notes/pond.md.",
      approve: false,
    });
    projectId = planned.projectId;
    out.policy = (await L.cmd([
      { name: "settings.set", params: { key: "credential_policy", value: "subscription_then_ask" } },
    ])).status;
    const until = new Date(Date.now() + 60 * 60_000);
    until.setUTCSeconds(0, 0);
    out.restingUntil = until.toISOString();
    L.patchLimits("subscription", (l) => ({ ...l, restingUntil: out.restingUntil }));
    await L.goto(page, "/inbox", 2500);
    out.planCard = await R.step(page, `b ${mode} plan card`);
    const plan = page.getByTestId("request").filter({ hasText: /Pond notes/ }).first();
    await plan.getByRole("button", { name: /^Approve and start/ }).first().click();
    await page.waitForTimeout(10000);
    await L.goto(page, "/inbox", 2500);
    out.inboxBefore = await R.step(page, `b ${mode} inbox ask card`);
    const inbox = await R.api(N, "GET", "/inbox");
    const card = (inbox.requests ?? []).find((r) => /^Use your API key/.test(r.title ?? ""));
    out.card = card ? { title: card.title, body: card.body, choices: (card.choices ?? []).map((c) => [c.label, c.explain]) } : null;
    out.notifications = ((await R.api(N, "GET", "/notifications/recent?limit=50")).notifications ?? []).map((n) => ({ kind: n.kind, title: n.title, body: n.body, link: n.link }));
    out.sessionsBefore = L.q("select id, status, summary from session where project_id = ?", projectId);
    // The person answers on the card.
    const cardEl = page.getByTestId("request").filter({ hasText: /Use your API key/ }).first();
    const label = mode === "use" ? "Use API key" : "Wait";
    await cardEl.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForTimeout(1500);
    const confirm = page.getByRole("button", { name: /^(Confirm|Yes)/ });
    if (await confirm.count()) await confirm.first().click();
    await page.waitForTimeout(10000);
    out.inboxAfterAnswer = await R.step(page, `b ${mode} inbox after answer`);
    L.save(`walk-b-${mode}-project.json`, { projectId });
  } else {
    projectId = JSON.parse(L.fs.readFileSync(L.path.join(R.bench(N).home, "..", "evidence", `walk-b-${mode}-project.json`), "utf8")).projectId;
  }
  const inbox2 = await R.api(N, "GET", "/inbox");
  out.inboxMessages = (inbox2.messages ?? []).map((m) => ({ title: m.title, body: m.body }));
  out.inboxRequests = (inbox2.requests ?? []).map((r) => ({ title: r.title, status: r.status, done: r.done ?? r.doneLine ?? null }));
  out.sessions = L.q("select id, status, summary, started_at from session where project_id = ? order by started_at", projectId);
  const first = out.sessions[out.sessions.length - 1];
  if (first) {
    out.sessionView = (await R.api(N, "GET", `/sessions/${enc(first.id)}`)).summary;
    await L.goto(page, `/sessions/${enc(first.id)}`, 2000);
    out.sessionPage = await R.step(page, `b ${mode} ${phase} session page`);
  }
  out.lastResult = (await R.api(N, "GET", `/projects/${enc(projectId)}/summary`)).lastSession?.summary ?? null;
  await L.goto(page, `/projects/${enc(projectId)}`, 2000);
  out.overview = await R.step(page, `b ${mode} ${phase} overview`);
  out.rows = (await R.api(N, "GET", `/projects/${enc(projectId)}/tasks`)).map((t) => ({ status: t.status, label: t.display?.label }));
  out.running = await R.api(N, "GET", "/running");
  out.apiRequests = L.fs.existsSync(R.bench(N).apiRequestLog)
    ? L.fs.readFileSync(R.bench(N).apiRequestLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => ({ path: r.path, status: r.status, answer: r.answer }))
    : [];
  out.problems = R.problems(N);
  console.log(L.save(file, out));
  await browser.close();
})().catch((e) => {
  out.error = String(e.stack || e);
  console.log(L.save(file, out));
  process.exit(1);
});
