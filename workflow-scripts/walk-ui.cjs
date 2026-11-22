// The fix-up's walk: Show older sessions, then a session that runs and ends while the tab is
// open (blocking 1), and the session page's running task CHF following the spend (blocking 2).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-8/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-d1109-sessions";
const OUT = "/tmp/frbench/fixup-d1109-sessions-evidence";
const seed = JSON.parse(fs.readFileSync(`${OUT}/seed.json`, "utf8"));
const pid = seed.projectId;
const result = { checks: {}, readings: [] };
const check = (name, ok, detail) => {
  result.checks[name] = { ok: !!ok, ...(detail !== undefined ? { detail } : {}) };
  console.log(ok ? "PASS" : "FAIL", name, detail !== undefined ? JSON.stringify(detail) : "");
};

const hrefs = (page) =>
  page.$$eval('[data-testid="session-row"]', (els) => els.map((e) => e.getAttribute("href")));
const heading = (page) =>
  page
    .locator('[data-testid="sessions-heading"]')
    .textContent()
    .catch(() => null);

(async () => {
  const { browser, page } = await R.openApp(N, {
    path: `/projects/${pid}/sessions`,
    freshProfile: true,
  });
  if (await R.skipSetup(page)) await page.goto(`${R.bench(N).uiUrl}/projects/${pid}/sessions`);
  await page.waitForSelector('[data-testid="sessions-heading"]', { timeout: 20_000 });
  const count0 = (await R.api(N, "GET", `/projects/${pid}/sessions`)).count;
  result.countBefore = count0;
  await R.until(async () => (await hrefs(page)).length === 20, 20_000, 500, "20 rows");
  await R.step(page, `sessions tab, 20 of ${count0} rows`);
  await page.click('[data-testid="sessions-older"]');
  await R.until(async () => (await hrefs(page)).length === count0, 20_000, 500, "every row");
  const before = await hrefs(page);
  check("every row after Show older", before.length === count0, { heading: await heading(page) });
  check("Show older gone on the last page", (await page.$('[data-testid="sessions-older"]')) === null);
  await R.step(page, `sessions tab, all ${count0} rows after Show older`);

  // A long session starts and runs while the tab with every row is open.
  const task = await R.api(N, "POST", `/projects/${pid}/tasks`, {
    title: "Long essay in essay.md",
    outcome: "essay.md exists",
    riskTier: 1,
    specialist: "writer",
  });
  const started = await R.startSession(N, pid);
  const sid = started.session?.id;
  result.sessionId = sid;
  await page.waitForSelector('[data-testid="session-row-working"]', { timeout: 20_000 });
  await R.step(page, `working row on top, ${count0} below`);

  // The session page, in a second browser, while the task runs.
  const second = await R.openApp(N, { path: `/sessions/${sid}`, profile: false });
  const sp = second.page;
  await sp.waitForSelector('[data-testid="session-tasks"]', { timeout: 30_000 });
  const read = async (label) => {
    const taskSpent = await sp
      .locator('[data-testid="session-task-spent"]')
      .first()
      .textContent()
      .catch(() => null);
    const here = await sp
      .locator('[data-testid="session-task-here"]')
      .first()
      .textContent()
      .catch(() => null);
    const meter = await sp
      .locator('[data-testid="session-spend"]')
      .textContent()
      .catch(() => null);
    const api = await R.api(N, "GET", `/sessions/${sid}/tasks`);
    const s = await R.api(N, "GET", `/sessions/${sid}`);
    const r = {
      label,
      at: new Date().toISOString(),
      here,
      taskSpent,
      meter,
      apiTask: api.tasks[0] ? { here: api.tasks[0].here, spentWords: api.tasks[0].spentWords, chfMicro: api.tasks[0].spent.chfMicro } : null,
      sessionChfMicro: s.spent.chfMicro,
      status: s.status,
    };
    result.readings.push(r);
    console.log(JSON.stringify(r));
    return r;
  };
  const first = await read("first");
  await R.step(sp, "session page, the running task's CHF at first");
  await sp.waitForTimeout(12_000);
  const later = await read("12 s later");
  await R.step(sp, "session page, the running task's CHF 12 s later");
  check("the task runs on both readings", first.here === "Running" && later.here === "Running", {
    first: first.here,
    later: later.here,
  });
  check(
    "the session's spend moved between the readings",
    later.sessionChfMicro > first.sessionChfMicro,
    { first: first.sessionChfMicro, later: later.sessionChfMicro },
  );
  check("the running task's CHF on screen moved", later.taskSpent !== "CHF 0.00" && later.taskSpent !== first.taskSpent || later.apiTask?.chfMicro > 0 && later.taskSpent !== "CHF 0.00", {
    first: first.taskSpent,
    later: later.taskSpent,
  });
  // While it runs, the row on screen says what the daemon said at most 1.5 s before.
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const a = (await R.api(N, "GET", `/sessions/${sid}/tasks`)).tasks[0]?.spentWords;
    await sp.waitForTimeout(1500);
    const row = await sp.locator('[data-testid="session-task-spent"]').first().textContent();
    const meter = await sp.locator('[data-testid="session-spend"]').textContent();
    const b = (await R.api(N, "GET", `/sessions/${sid}/tasks`)).tasks[0]?.spentWords;
    const st = (await R.api(N, "GET", `/sessions/${sid}`)).status;
    samples.push({ a, row, b, meter, status: st });
  }
  result.samples = samples;
  console.log(JSON.stringify(samples));
  const running = samples.filter((x) => x.status === "running");
  check(
    "the row on screen is never older than 1.5 s while the task runs",
    running.length > 0 && running.every((x) => x.row === x.a || x.row === x.b),
    { running: running.length },
  );
  // Stop now: the session ends while the tab with every row shown is open.
  await R.api(N, "POST", `/sessions/${sid}/stop`, { reason: "stopped by the fix-up's walk" });
  await R.waitForSession(N, sid);
  await R.until(async () => (await page.$('[data-testid="session-row-working"]')) === null, 30_000, 500, "the working row to go");
  await R.until(async () => (await hrefs(page)).length === count0 + 1, 30_000, 500, "one row more");
  const after = await hrefs(page);
  const head = await heading(page);
  check("the rows equal the heading after the session ended", after.length === count0 + 1 && head === `${count0 + 1} sessions`, { rows: after.length, head });
  check("each row once", new Set(after).size === after.length);
  check("the one that ended is on top", after[0] === `/sessions/${sid}`, after[0]);
  check("every row shown before is still shown, in order", JSON.stringify(after.slice(1)) === JSON.stringify(before));
  const oldTwentieth = before[19];
  check("the old first page's 20th row is still there", after.includes(oldTwentieth), oldTwentieth);
  check("no Show older comes back", (await page.$('[data-testid="sessions-older"]')) === null);
  await R.step(page, `sessions tab after the session ended, ${count0 + 1} rows`);
  // Its page after the end: the task's CHF equals the ledger's.
  await sp.waitForTimeout(1500);
  const end = await read("ended");
  check("after the end the task row equals the route", end.taskSpent === end.apiTask?.spentWords, end);
  await R.step(sp, "session page after Stop now");
  const listed = await R.api(N, "GET", `/projects/${pid}/sessions`);
  result.endedRow = listed.rows.find((r) => r.id === sid);
  console.log(JSON.stringify(result.endedRow));
  result.problems = R.problems(N);
  fs.writeFileSync(`${OUT}/${process.argv[2] || "walk"}.json`, JSON.stringify(result, null, 1));
  await second.browser.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/${process.argv[2] || "walk"}.json`, JSON.stringify({ ...result, error: String(e) }, null, 1));
  process.exit(1);
});
