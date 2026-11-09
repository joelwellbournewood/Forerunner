// Step 2, case 3 (tiny budget CHF 0.02) with a dependent (for case 4), in a folder project "Chess tools".
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const WRAP = "About a fifth of this task's budget is left";
const textOf = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) : "").join("\n");
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Chess tools");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Chess tools", goal: "Small tools and notes for the chess club" });
    out.pid = pid;
    const have = await L.tasks(NAME, pid);
    if (!have.find((t) => t.title === "Write the meeting notes in notes.md")) {
      out.t1 = await L.newTask(page, NAME, pid, {
        title: "Write the meeting notes in notes.md",
        outcome: "notes.md lists the chess club's next six Tuesday meetings (from 10 November 2026, 19:00) with a one-line topic each",
        criteria: ["notes.md lists six meetings with dates and topics"],
        who: "coder", budget: "0.02", shotLabel: "b01 new task tiny budget",
      });
      out.d1 = await L.newTask(page, NAME, pid, {
        title: "Write the summary in summary.md",
        outcome: "summary.md sums up notes.md in two sentences",
        criteria: ["summary.md has two sentences about the meetings in notes.md"],
        who: "coder", waitsFor: ["Write the meeting notes in notes.md"], shotLabel: "b02 new task dependent",
      });
    }
    out.tasksBefore = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label, dependsOn: t.dependsOn }));
    // TR-12 / R-planningstart: a New project with a brief starts planning; at once Start on Chess tools.
    const bakery = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Bakery Bern");
    out.bakeryId = bakery ? bakery.id : await L.newProject(page, NAME, { project: "Bakery Bern", brief: "A one-page website for a small bakery in Bern; I will give you the real menu, hours and address." });
    out.bakeryCreatedAt = new Date().toISOString();
    await goto(page, NAME, `/projects/${enc(pid)}`, 500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.intakeAtDialog = (await R.api(NAME, "GET", `/projects/${enc(out.bakeryId)}/intake`)).state;
    out.startDialog = await R.step(page, "b03 start dialog chess tools while bakery plan drafted");
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    out.intakeAtStart = (await R.api(NAME, "GET", `/projects/${enc(out.bakeryId)}/intake`)).state;
    out.afterStart = await R.step(page, "b03b after start while drafting");
    const notice = page.getByTestId("start-session-notice");
    out.startNotice = (await notice.count()) ? await notice.first().innerText() : null;
    log("intake at dialog", out.intakeAtDialog, "notice:", out.startNotice);
    const sid = await R.until(async () => {
      const arr = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`);
      const a = Array.isArray(arr) ? arr : arr.sessions ?? [];
      return a[0]?.id;
    }, 400000, 2000, "session");
    out.sessionSeenAt = new Date().toISOString();
    out.intakeWhenSessionSeen = (await R.api(NAME, "GET", `/projects/${enc(out.bakeryId)}/intake`)).state;
    out.sid = sid;
    const s = await R.waitForSession(NAME, sid, 600000);
    out.session = { status: s.status, statusText: s.statusText, summary: s.summary };
    log("session", JSON.stringify(out.session));
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
    out.tasksTab = await R.step(page, "b04 tasks after tiny pause");
    const rows = await L.tasks(NAME, pid);
    out.rows = rows.map((t) => ({ id: t.id, title: t.title, status: t.status, display: t.display, reason: t.reason }));
    for (const t of rows) {
      await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2000);
      await R.step(page, `b05 drawer ${t.title}`);
    }
    await goto(page, NAME, "/inbox", 2500);
    out.inbox = await R.step(page, "b06 inbox tiny pause card");
    const inbox = await R.api(NAME, "GET", "/inbox");
    out.cards = (inbox.requests ?? []).filter((r) => r.status === "open").map((r) => ({ id: r.id, title: r.title, body: r.body, options: r.options, kind: r.kind, taskId: r.taskId }));
    await goto(page, NAME, `/sessions/${enc(sid)}`, 2500);
    out.sessionPage = await R.step(page, "b07 session tiny");
    const det = page.getByLabel("Details");
    if (await det.count()) { await det.first().check().catch(() => undefined); await page.waitForTimeout(1000); out.sessionDetails = await R.step(page, "b08 session tiny details"); }
    const ev = await R.api(NAME, "GET", `/sessions/${enc(sid)}/events`).catch(() => null);
    out.events = (ev?.events ?? ev ?? []).map((e) => e.text ?? "").filter(Boolean);
    const t1 = rows.find((t) => t.title.startsWith("Write the meeting notes"));
    const calls = R.modelCalls(NAME).filter((c) => c.sessionId === sid);
    const mine = calls.filter((c) => (c.label ?? "").includes(t1.title) || (c.label ?? "").includes(t1.id));
    out.t1Calls = mine.map((c) => ({ role: c.role, usd: c.usd, wrap: (c.messages ?? []).some((m) => m.role === "user" && textOf(m).includes(WRAP)), cacheRead: c.reply?.usage?.cache_read_input_tokens, input: c.reply?.usage?.input_tokens, output: c.reply?.usage?.output_tokens }));
    out.anyWrapInSession = calls.some((c) => (c.messages ?? []).some((m) => m.role === "user" && textOf(m).includes(WRAP)));
    out.t1Detail = await R.api(NAME, "GET", `/tasks/${enc(t1.id)}`);
    out.files = require("child_process").execSync(`cd ${R.workspaceOf(NAME, pid)} && git log --oneline -5 && git status --short && ls -la`, { encoding: "utf8" });
  } finally { save(NAME, "budget1.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
