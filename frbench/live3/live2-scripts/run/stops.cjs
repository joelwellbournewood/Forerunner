// extra §4 stops (L-1, L-7, L-10, L-6, L-8) + R-recovery (kill -9 the daemon by its PID) on a folder project.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path");
const NAME = "run-live";
const A = "Build the recipe page in index.html", B = "Add a print stylesheet print.css and link it from index.html",
  C = "Add a footer with the club address to index.html", D = "Write the shopping list in list.md";
const STAGE = process.argv[2] || "all";
const out = { stages: {} };
const file = () => path.join(R.bench(NAME).steps, "stops.json");
if (fs.existsSync(file())) Object.assign(out, JSON.parse(fs.readFileSync(file(), "utf8")));
const persist = () => save(NAME, "stops.json", out);
const sh = (c) => execSync(c.replace(/^node scripts\/bench\/restart-daemon\.mjs/, 'ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node scripts/bench/restart-daemon.mjs'), { cwd: "/home/user/Forerunner", encoding: "utf8", shell: "/bin/bash", env: { ...process.env, FRBENCH_ROOT: "/tmp/frbench/live2/run" } });
const taskBy = async (pid, title) => (await L.tasks(NAME, pid)).find((t) => t.title === title);
async function startViaUi(page, pid, label) {
  await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
  await page.getByRole("button", { name: "Start session" }).first().click();
  await page.waitForTimeout(2500);
  const txt = await R.step(page, label);
  await page.getByTestId("confirm-start-session").click();
  const t0 = Date.now();
  const s = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t0 - 3000); }, 120000, 1000, "session");
  await page.keyboard.press("Escape").catch(() => undefined);
  return { sid: s.id, dialog: txt };
}
async function waitStatus(pid, title, statuses, ms = 600000, every = 500) {
  return R.until(async () => { const t = await taskBy(pid, title); return statuses.includes(t?.status) ? t : null; }, ms, every, `${title} -> ${statuses}`);
}
async function events(sid) { const ev = await R.api(NAME, "GET", `/sessions/${enc(sid)}/events`); return (ev.events ?? ev).map((e) => e.text).filter(Boolean); }
(async () => {
  let { browser, page } = await R.openApp(NAME);
  try {
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Recipe card");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Recipe card", goal: "A small recipe page for the club's pancake evening" });
    out.pid = pid;
    if (!(await L.tasks(NAME, pid)).length) {
      await L.newTask(page, NAME, pid, { title: A, outcome: "index.html shows a pancake recipe: a title, an ingredients list and three steps; styles.css is linked from index.html", who: "coder" });
      await L.newTask(page, NAME, pid, { title: B, outcome: "print.css hides nothing but sets black text on white for printing; index.html links it with media=\"print\"", who: "coder", waitsFor: [A] });
      await L.newTask(page, NAME, pid, { title: C, outcome: "index.html ends with a footer: Chess club, Marktgasse 1, 3011 Bern", who: "coder", waitsFor: [A] });
      await L.newTask(page, NAME, pid, { title: D, outcome: "list.md lists what to buy for 20 pancakes", who: "writer-marketing", waitsFor: [A] });
      // priorities: B high so it runs before C and D
      out.created = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, priority: t.priority, dependsOn: t.dependsOn }));
    }
    persist();
    // ---- Stage 1: L-1a graceful restart while A is being reviewed
    if (STAGE === "all" || STAGE === "1") {
      const s1 = await startViaUi(page, pid, "s01 start dialog recipe card");
      out.stages.s1 = { sid: s1.sid };
      await waitStatus(pid, A, ["in_review"], 600000, 400);
      out.stages.s1.inReviewAt = new Date().toISOString();
      log("A in review: graceful restart");
      out.stages.s1.restart = sh("node scripts/bench/restart-daemon.mjs --name run-live 2>&1").trim();
      await L.sleep(4000);
      await R.reconnect(page, NAME);
    }
    if (STAGE === "all" || STAGE === "1" || STAGE === "1b") {
      out.stages.s1 = out.stages.s1 ?? {};
      if (!out.stages.s1.sid) { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; out.stages.s1.sid = arr[0].id; }
      const s1 = { sid: out.stages.s1.sid };
      const tA = await taskBy(pid, A);
      out.stages.s1.after = { status: tA.status, display: tA.display?.label, cancelWork: tA.display?.cancelWork };
      const sv = await R.api(NAME, "GET", `/sessions/${enc(s1.sid)}`);
      out.stages.s1.session = { status: sv.status, statusText: sv.statusText, summary: sv.summary, stopReason: sv.stopReason };
      out.stages.s1.events = (await events(s1.sid)).slice(-6);
      const inbox = await R.api(NAME, "GET", "/inbox");
      out.stages.s1.updates = (inbox.messages ?? []).slice(0, 4).map((m) => m.body ?? m.title);
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
      out.stages.s1.tasksShot = await R.step(page, "s02 tasks after graceful restart in review");
      // L-7: A's Cancel dialog
      const row = page.getByTestId("task-row").filter({ hasText: A }).first();
      out.stages.s1.cancelTitle = await row.getByTestId("action-cancel").getAttribute("title").catch(() => null);
      await row.getByTestId("action-cancel").click().catch(() => undefined);
      await page.waitForTimeout(1200);
      out.stages.s1.cancelDialog = await page.getByTestId("action-dialog").innerText().catch(() => null);
      await R.step(page, "s03 A cancel dialog after restart");
      await page.getByTestId("dismiss-action").click().catch(() => undefined);
      await goto(page, NAME, `/sessions/${enc(s1.sid)}`, 2500);
      await R.step(page, "s04 session 1 after graceful restart");
      persist();
    }
    // ---- Stage 2: A done, B running -> chat skip (pause / cancel), cancel B (L-6), C in review -> kill -9 (L-1b + R-recovery)
    if (STAGE === "all" || STAGE === "2") {
      const s2 = await startViaUi(page, pid, "s05 start dialog session 2");
      out.stages.s2 = { sid: s2.sid, dialog: s2.dialog.slice(-600) };
      await waitStatus(pid, A, ["done"], 900000, 1000);
      await waitStatus(pid, B, ["in_progress", "claimed"], 300000, 300);
      log("B running: chat skip");
      const r1 = await L.say(page, NAME, pid, `skip the "${D}" task for now`, "s06 chat skip for now");
      out.stages.s2.skipForNow = { reply: r1.reply, readback: r1.readback };
      if (r1.readback) await L.answerReadback(page, false);
      const r2 = await L.say(page, NAME, pid, `Skip the "${D}" task`, "s07 chat skip the task");
      out.stages.s2.skip = { reply: r2.reply, readback: r2.readback };
      if (r2.readback) await L.answerReadback(page, true);
      out.stages.s2.dAfterSkip = (await taskBy(pid, D))?.display;
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 1500);
      await R.step(page, "s08 tasks after skip yes");
      // L-6: cancel B while it runs (if still running)
      const tb = await taskBy(pid, B);
      out.stages.s2.bBeforeCancel = tb.status;
      const rowB = page.getByTestId("task-row").filter({ hasText: B }).first();
      await rowB.getByTestId("action-cancel").click();
      await page.waitForTimeout(1000);
      out.stages.s2.bCancelDialog = await page.getByTestId("action-dialog").innerText().catch(() => null);
      await page.getByTestId("confirm-action").click();
      await page.waitForTimeout(2500);
      out.stages.s2.bMoved = await page.getByTestId("task-moved-sentence").innerText().catch(() => null);
      await R.step(page, "s09 after cancel B running");
      // C in review -> kill -9 the daemon by its PID
      await waitStatus(pid, C, ["in_review"], 900000, 400);
      const b = R.bench(NAME);
      out.stages.s2.killedPid = b.daemonNodePid;
      out.stages.s2.eventsBeforeKill = (await events(s2.sid)).slice(-8);
      out.stages.s2.spentBeforeKill = (await R.api(NAME, "GET", `/sessions/${enc(s2.sid)}`)).spent;
      log("C in review: kill -9", b.daemonNodePid);
      process.kill(b.daemonNodePid, "SIGKILL");
      await L.sleep(3000);
      out.stages.s2.restart = sh("node scripts/bench/restart-daemon.mjs --name run-live 2>&1").trim();
      await L.sleep(5000);
      await R.reconnect(page, NAME);
      const sv = await R.api(NAME, "GET", `/sessions/${enc(s2.sid)}`);
      out.stages.s2.session = { status: sv.status, statusText: sv.statusText, summary: sv.summary, stopReason: sv.stopReason, spent: sv.spent };
      out.stages.s2.events = (await events(s2.sid)).slice(-6);
      out.stages.s2.rows = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label }));
      await goto(page, NAME, `/sessions/${enc(s2.sid)}`, 3000);
      out.stages.s2.sessionPage = await R.step(page, "s10 session 2 after kill -9");
      await goto(page, NAME, `/projects/${enc(pid)}`, 2500);
      out.stages.s2.overview = await R.step(page, "s11 overview after kill -9");
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
      await R.step(page, "s12 tasks after kill -9");
      const rowC = page.getByTestId("task-row").filter({ hasText: C }).first();
      await rowC.getByTestId("action-cancel").click().catch(() => undefined);
      await page.waitForTimeout(1000);
      out.stages.s2.cCancelDialog = await page.getByTestId("action-dialog").innerText().catch(() => null);
      await page.getByTestId("dismiss-action").click().catch(() => undefined);
      const inbox = await R.api(NAME, "GET", "/inbox");
      out.stages.s2.updates = (inbox.messages ?? []).slice(0, 4).map((m) => m.body ?? m.title);
      const costs = await R.api(NAME, "GET", `/costs?from=2026-11-01T00:00:00Z`);
      out.stages.s2.ledgerProject = (costs.byProject ?? []).find((x) => x.key === pid);
      persist();
    }
    // ---- Stage 3: Start -> C done; Undo B's cancel in Changes; Start -> B in review -> Cancel at once (L-8)
    if (STAGE === "all" || STAGE === "3") {
      const s3 = await startViaUi(page, pid, "s13 start dialog session 3");
      out.stages.s3 = { sid: s3.sid };
      const d3 = await R.waitForSession(NAME, s3.sid, 900000);
      out.stages.s3.session = { status: d3.status, summary: d3.summary };
      out.stages.s3.rows = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label }));
      // L-6 Undo B's cancel from Changes
      await goto(page, NAME, "/changes", 2500);
      await R.step(page, "s14 changes before undo");
      const entry = page.locator("li, article, div").filter({ hasText: `Cancelled "${B}"` }).last();
      const undo = entry.getByRole("button", { name: /^Undo/ }).first();
      out.stages.s3.undoCount = await undo.count();
      if (out.stages.s3.undoCount) {
        await undo.click(); await page.waitForTimeout(1200);
        out.stages.s3.undoDialog = await page.evaluate(() => document.body.innerText);
        const confirm = page.getByRole("button", { name: /^(Undo|Yes|Confirm)/ }).last();
        await R.step(page, "s15 undo dialog");
        if (await confirm.count()) { await confirm.click().catch(() => undefined); await page.waitForTimeout(3000); }
        out.stages.s3.afterUndo = await R.step(page, "s16 after undo B");
      }
      const tb = await taskBy(pid, B);
      out.stages.s3.bAfterUndo = { status: tb.status, display: tb.display?.label };
      persist();
    }
    if (STAGE === "all" || STAGE === "4") {
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 1500);
      const s4 = await startViaUi(page, pid, "s17 start dialog session 4");
      out.stages.s4 = { sid: s4.sid };
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 1500);
      const rowB = page.getByTestId("task-row").filter({ hasText: B }).first();
      await R.until(async () => /Being reviewed/.test(await rowB.innerText()), 900000, 100, "B being reviewed in the row");
      const seen = Date.now();
      await rowB.getByTestId("action-cancel").click();
      await page.getByTestId("confirm-action").click();
      out.stages.s4.cancelMs = Date.now() - seen;
      out.stages.s4.cancelAt = new Date().toISOString();
      await page.waitForTimeout(3000);
      out.stages.s4.moved = await page.getByTestId("task-moved-sentence").innerText().catch(() => null);
      await R.step(page, "s18 after cancel in review");
      const d4 = await R.waitForSession(NAME, s4.sid, 600000);
      out.stages.s4.session = { status: d4.status, summary: d4.summary };
      out.stages.s4.events = await events(s4.sid);
      const calls = R.modelCalls(NAME).filter((c) => c.sessionId === s4.sid);
      out.stages.s4.calls = calls.map((c) => ({ t: c.time, role: c.role, usd: c.usd }));
      out.stages.s4.criticAfterCancel = calls.filter((c) => c.role === "critic" && Date.parse(c.time) > Date.parse(out.stages.s4.cancelAt)).length;
      await goto(page, NAME, `/projects/${enc(pid)}/files`, 3000);
      out.stages.s4.files = await R.step(page, "s19 files after cancel in review");
      out.stages.s4.printCssExists = fs.existsSync(path.join(R.workspaceOf(NAME, pid), "print.css"));
      out.stages.s4.rows = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label }));
      persist();
    }
  } finally { persist(); await browser.close().catch(() => undefined); }
  log("done");
})().catch((e) => { console.error(e); persist(); process.exit(1); });
