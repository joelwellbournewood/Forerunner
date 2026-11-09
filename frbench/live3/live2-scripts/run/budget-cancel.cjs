// Step 2 case 4: Cancel a paused task with a dependent (Tasks tab), Undo; then case 3's Continue.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const TITLE = process.argv[2] || "Write the meeting notes in notes.md";
const DO_CONTINUE = process.argv.includes("--continue");
(async () => {
  const prev = JSON.parse(require("fs").readFileSync(`${R.bench(NAME).steps}/budget1.json`, "utf8"));
  const pid = prev.pid;
  const ws = R.workspaceOf(NAME, pid);
  const sh = (c) => require("child_process").execSync(c, { cwd: ws, encoding: "utf8" });
  const out = { pid };
  const { browser, page } = await R.openApp(NAME);
  try {
    let t = (await L.tasks(NAME, pid)).find((x) => x.title === TITLE);
    out.before = { status: t.status, display: t.display, files: sh("git status --short; ls"), log: sh("git log --oneline -5") };
    if (!process.argv.includes("--no-cancel")) {
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
    const row = page.getByTestId("task-row").filter({ hasText: TITLE }).first();
    out.rowText = await row.innerText();
    const cancelBtn = row.getByTestId("action-cancel");
    out.cancelTitle = await cancelBtn.getAttribute("title");
    await cancelBtn.click();
    await page.waitForTimeout(1500);
    out.dialog = await page.getByTestId("action-dialog").innerText();
    await R.step(page, "x01 cancel dialog paused task with dependent");
    await page.getByTestId("confirm-action").click();
    await page.waitForTimeout(3000);
    out.moved = (await page.getByTestId("task-moved-sentence").count()) ? await page.getByTestId("task-moved-sentence").innerText() : null;
    await R.step(page, "x02 after cancel");
    t = (await L.tasks(NAME, pid)).find((x) => x.title === TITLE);
    out.afterCancel = { status: t.status, display: t.display, files: sh("git status --short; ls"), log: sh("git log --oneline -5") };
    out.dependent = (await L.tasks(NAME, pid)).filter((x) => x.title !== TITLE).map((x) => ({ title: x.title, display: x.display?.label }));
    await goto(page, NAME, `/projects/${enc(pid)}/files`, 2500);
    out.filesTab = await R.step(page, "x03 files tab after cancel");
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 1500);
    const undo = page.getByTestId("task-moved-undo");
    out.undoVisible = await undo.count();
    if (!out.undoVisible) {
      // Undo lives in Changes as well
      await goto(page, NAME, "/changes", 2000);
      await R.step(page, "x04 changes page");
      const u = page.getByRole("button", { name: /^Undo/ }).first();
      if (await u.count()) { await u.click(); await page.waitForTimeout(2500); out.undoFrom = "changes"; }
    } else { await undo.first().click(); await page.waitForTimeout(3000); out.undoFrom = "tasks"; }
    out.afterUndoSentence = (await page.getByTestId("task-moved-sentence").count()) ? await page.getByTestId("task-moved-sentence").innerText() : null;
    await R.step(page, "x05 after undo");
    t = (await L.tasks(NAME, pid)).find((x) => x.title === TITLE);
    out.afterUndo = { status: t.status, display: t.display, files: sh("git status --short; ls"), log: sh("git log --oneline -5") };
    }
    await goto(page, NAME, "/inbox", 2500);
    out.inboxAfterUndo = await R.step(page, "x06 inbox before continue");
    if (DO_CONTINUE) {
      const inbox = await R.api(NAME, "GET", "/inbox");
      const card = (inbox.requests ?? []).find((r) => r.status === "open" && r.taskId === t.id);
      out.card = card ? { title: card.title, body: card.body, options: card.options } : null;
      const btn = page.locator(`#card-${card.id}`).getByRole("button", { name: /^Continue \(CHF/ }).first().or(page.getByRole("button", { name: /^Continue \(CHF/ }).first());
      out.continueLabel = (await btn.count()) ? await btn.innerText() : null;
      const t0 = Date.now();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(3000);
        await R.step(page, "x07 after continue");
        const sess = await R.until(async () => {
          const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`);
          const arr = Array.isArray(a) ? a : a.sessions ?? [];
          return arr.find((s) => Date.parse(s.startedAt) >= t0 - 2000);
        }, 30000, 1000, "a session after Continue").catch(() => null);
        out.sessionStartedAfterMs = sess ? Date.parse(sess.startedAt) - t0 : null;
        if (sess) {
          const done = await R.waitForSession(NAME, sess.id, 900000);
          out.contSession = { status: done.status, summary: done.summary };
          const calls = R.modelCalls(NAME).filter((c) => c.sessionId === sess.id && c.role === "specialist" && ((c.label ?? "").includes(TITLE)));
          const first = calls[0];
          const userText = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? "").join("\n");
          out.nextBrief = first ? userText(first.messages.find((m) => m.role === "user")).slice(0, 2500) : null;
          out.criticCalls = R.modelCalls(NAME).filter((c) => c.sessionId === sess.id && c.role === "critic").map((c) => c.label);
          out.finalRows = (await L.tasks(NAME, pid)).map((x) => ({ title: x.title, status: x.status, display: x.display?.label }));
          const inbox2 = await R.api(NAME, "GET", "/inbox");
          out.openCardsAfter = (inbox2.requests ?? []).filter((r) => r.status === "open" && r.projectId === pid).map((r) => r.title);
          await goto(page, NAME, `/sessions/${enc(sess.id)}`, 2500);
          out.contSessionPage = await R.step(page, "x08 continue session page");
        }
      }
    }
  } finally { save(NAME, `cancel-${Date.now()}.json`, out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
