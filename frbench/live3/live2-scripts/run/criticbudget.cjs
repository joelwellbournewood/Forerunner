// R-criticbudget, R-sessreview, TR-14 with the real model: a project budget that fits the run but not its review.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const PB = process.argv[2] || "0.06";
const TITLE = "Write the club motto in motto.txt";
(async () => {
  const out = { pb: PB };
  const { browser, page } = await R.openApp(NAME);
  try {
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Club motto");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Club motto", goal: "A motto for the chess club" });
    out.pid = pid;
    if (!(await L.tasks(NAME, pid)).length)
      await L.newTask(page, NAME, pid, { title: TITLE, outcome: "motto.txt holds a one-line motto for the chess club, at most eight words", criteria: ["motto.txt has one line of at most eight words"], who: "writer-marketing" });
    out.set1 = await L.setProjectSetting(page, NAME, "Club motto", "project.budget", PB, "cb01 project budget");
    await goto(page, NAME, `/projects/${enc(pid)}`);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog = await R.step(page, "cb02 start dialog club motto");
    await page.getByTestId("confirm-start-session").click();
    const t0 = Date.now();
    await page.waitForTimeout(2000);
    const sess = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((s) => Date.parse(s.startedAt) >= t0 - 3000); }, 60000, 1000, "session");
    const s = await R.waitForSession(NAME, sess.id, 600000);
    out.sid = s.id;
    out.session = { status: s.status, statusText: s.statusText, summary: s.summary };
    const ev = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    log("events", out.events.join(" | "));
    const calls = R.modelCalls(NAME).filter((c) => c.sessionId === s.id);
    out.calls = calls.map((c) => `${c.role}:${c.max_tokens}:${c.usd}`);
    const t = (await L.tasks(NAME, pid))[0];
    out.row = { status: t.status, display: t.display, reason: t.reason };
    const inbox = await R.api(NAME, "GET", "/inbox");
    out.cards = (inbox.requests ?? []).filter((r) => r.status === "open" && r.projectId === pid).map((r) => ({ title: r.title, body: r.body, options: r.options }));
    await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2500);
    out.drawer = await R.step(page, "cb03 drawer paused at project budget");
    await goto(page, NAME, "/inbox", 2500);
    out.inbox = await R.step(page, "cb04 inbox project budget card");
    await goto(page, NAME, `/sessions/${enc(s.id)}`, 2500);
    out.sessionPage = await R.step(page, "cb05 session page");
    const det = page.getByLabel("Details");
    if (await det.count()) { await det.first().check().catch(() => undefined); await page.waitForTimeout(1000); }
    const sr = page.getByText("Session review").first();
    if (await sr.count()) { await sr.click().catch(() => undefined); await page.waitForTimeout(1000); }
    out.sessionDetails = await R.step(page, "cb06 session details review");
    if (process.argv.includes("--raise")) {
      out.set2 = await L.setProjectSetting(page, NAME, "Club motto", "project.budget", "1", "cb07 raise project budget");
      const t1 = Date.now();
      const s2 = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t1 - 3000); }, 120000, 2000, "a session after raising").catch(() => null);
      out.autoStarted = !!s2;
      if (s2) {
        const d2 = await R.waitForSession(NAME, s2.id, 600000);
        out.session2 = { status: d2.status, summary: d2.summary, trigger: s2.trigger };
        out.calls2 = R.modelCalls(NAME).filter((c) => c.sessionId === s2.id).map((c) => `${c.role}:${c.usd}`);
        const ev2 = await R.api(NAME, "GET", `/sessions/${enc(s2.id)}/events`);
        out.events2 = (ev2.events ?? ev2).map((e) => e.text).filter(Boolean);
      }
      const t2 = (await L.tasks(NAME, pid))[0];
      out.row2 = { status: t2.status, display: t2.display?.label };
      const inbox2 = await R.api(NAME, "GET", "/inbox");
      out.cards2 = (inbox2.requests ?? []).filter((r) => r.status === "open" && r.projectId === pid).map((r) => r.title);
    }
  } finally { save(NAME, "criticbudget.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
