// Step 2 case 1: wrap-up in a folder project (Chess tools), then Continue.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const BUDGET = process.argv[2] || "0.20";
const TITLE = "Write the Swiss pairing tool with tests";
const WRAP = "About a fifth of this task's budget is left";
const ut = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) : "").join("\n");
(async () => {
  const out = { budget: BUDGET };
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Chess tools");
    const pid = p.id; out.pid = pid;
    if (!(await L.tasks(NAME, pid)).find((t) => t.title === TITLE)) {
      out.newTask = await L.newTask(page, NAME, pid, {
        title: TITLE,
        outcome: "A Node.js command line tool for the club's Swiss-system tournaments, in four files plus a README: src/elo.js (Elo ratings, K=20), src/swiss.js (pairs players by score then rating, no rematches, a bye for an odd count), test/elo.test.js and test/swiss.test.js (node:test, at least six cases each), and README.md with usage examples. Usage: node src/swiss.js players.json",
        criteria: ["src/elo.js, src/swiss.js, test/elo.test.js and test/swiss.test.js exist", "node --test passes", "README.md shows how to run it with an example players.json"],
        who: "coder", budget: BUDGET, shotLabel: "w01 new task wrap-up budget",
      });
    }
    const t = (await L.tasks(NAME, pid)).find((x) => x.title === TITLE);
    out.taskId = t.id;
    await goto(page, NAME, `/projects/${enc(pid)}`);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(3000);
    out.startDialog = await R.step(page, "w02 start dialog wrap-up task");
    await page.getByTestId("confirm-start-session").click();
    const t0 = Date.now();
    await page.waitForTimeout(2000);
    const sess = await R.until(async () => {
      const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`);
      const arr = Array.isArray(a) ? a : a.sessions ?? [];
      return arr.find((s) => Date.parse(s.startedAt) >= t0 - 3000);
    }, 60000, 1000, "session");
    out.sid = sess.id;
    const s = await R.waitForSession(NAME, sess.id, 900000);
    out.session = { status: s.status, statusText: s.statusText, summary: s.summary };
    log("session", JSON.stringify(out.session));
    const ev = await R.api(NAME, "GET", `/sessions/${enc(sess.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    const calls = R.modelCalls(NAME).filter((c) => c.sessionId === sess.id);
    const spec = calls.filter((c) => c.role === "specialist");
    out.calls = spec.map((c) => ({ usd: c.usd, tools: (c.reply?.toolCalls ?? []).map((x) => x.name), cacheRead: c.reply?.usage?.cache_read_input_tokens }));
    out.criticCalls = calls.filter((c) => c.role === "critic").length;
    const wrapIdx = spec.findIndex((c) => c.messages.some((m) => m.role === "user" && ut(m).includes(WRAP)));
    out.wrapRequests = spec.filter((c) => c.messages.some((m) => m.role === "user" && ut(m).includes(WRAP))).length;
    if (wrapIdx >= 0) {
      const last = spec[wrapIdx].messages.at(-1);
      out.wrapRequestLastMessage = Array.isArray(last.content) ? last.content.map((b) => b.type === "text" ? { type: "text", text: b.text } : { type: b.type }) : [{ type: "string", text: String(last.content).slice(0, 300) }];
      out.wrapBlocksInFirst = spec[wrapIdx].messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "text" && b.text.includes(WRAP)).length : 0), 0);
      out.wrapCallIndex = wrapIdx;
    }
    out.lastReply = spec.at(-1)?.reply?.text?.slice(-1500);
    const rows = await L.tasks(NAME, pid);
    const tr = rows.find((x) => x.id === t.id);
    out.row = { status: tr.status, display: tr.display, reason: tr.reason };
    const inbox = await R.api(NAME, "GET", "/inbox");
    const card = (inbox.requests ?? []).find((r) => r.status === "open" && r.taskId === t.id);
    out.card = card ? { title: card.title, body: card.body, options: card.options } : null;
    out.git = require("child_process").execSync(`git log --oneline -6 && git status --short && ls -R src test 2>/dev/null | head -20`, { cwd: R.workspaceOf(NAME, pid), encoding: "utf8" });
    await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2500);
    out.drawer = await R.step(page, "w03 drawer paused wrap-up");
    await goto(page, NAME, "/inbox", 2500);
    out.inboxShot = await R.step(page, "w04 inbox wrap-up card");
    await goto(page, NAME, `/sessions/${enc(sess.id)}`, 2500);
    out.sessionPage = await R.step(page, "w05 session wrap-up");
  } finally { save(NAME, "budget2.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
