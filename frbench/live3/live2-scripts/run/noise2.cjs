// extra §3.2 (#96, #100): reviewer asks for findings, tester leaves docs/testing.md; plus R-estimates (plan card vs Start dialog).
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const BRIEF = "Review the existing code in src/clamp.js for bugs and report your findings, then add node:test tests for clamp and round in test/clamp.test.js.";
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Clamp review");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Clamp review", brief: BRIEF });
    out.pid = pid;
    const ws = R.workspaceOf(NAME, pid);
    execSync(`cp -r /tmp/frbench/live2/run/scripts/fixtures/clamp/. ${ws}/ && cd ${ws} && git add -A >/dev/null 2>&1; true`);
    out.copiedAt = new Date().toISOString();
    await R.until(async () => (await R.api(NAME, "GET", `/projects/${enc(pid)}/intake`)).state === "pending", 300000, 3000, "plan");
    await goto(page, NAME, "/inbox", 3000);
    const card = page.locator("[id^=card-]").filter({ hasText: "Clamp review" }).first();
    out.planCard = await card.innerText();
    await card.screenshot({ path: `${R.bench(NAME).steps}/watch/clamp-plan-card.png` }).catch(() => undefined);
    await R.step(page, "r01 inbox clamp plan card");
    // Approve and start
    await card.getByRole("button", { name: "Approve and start" }).click();
    const t0 = Date.now();
    const sess = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((s) => Date.parse(s.startedAt) >= t0 - 3000); }, 60000, 500, "session after approve");
    // stop at once: session page, Stop now
    await goto(page, NAME, `/sessions/${enc(sess.id)}`, 800);
    const stopNow = page.getByRole("button", { name: /^Stop now/ }).first();
    if (await stopNow.count()) {
      await stopNow.click(); await page.waitForTimeout(800);
      const conf = page.getByRole("button", { name: /^Stop now/ }).last();
      if (await conf.count()) await conf.click().catch(() => undefined);
    }
    out.stopClickedMs = Date.now() - t0;
    const s1 = await R.waitForSession(NAME, sess.id, 300000);
    out.s1 = { status: s1.status, summary: s1.summary, statusText: s1.statusText, spent: s1.spent };
    await R.step(page, "r02 session stopped at once");
    out.tasksAfterStop = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label, specialist: t.specialist, estimate: t.estimate }));
    await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(3000);
    out.startDialog = await page.getByTestId("start-session-plan").innerText().catch(async () => await page.evaluate(() => document.body.innerText));
    await R.step(page, "r03 start dialog after stop");
    await page.getByTestId("confirm-start-session").click();
    const t1 = Date.now();
    const s2 = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((s) => Date.parse(s.startedAt) >= t1 - 3000); }, 60000, 1000, "session 2");
    const d2 = await R.waitForSession(NAME, s2.id, 1200000);
    out.s2 = { status: d2.status, summary: d2.summary };
    const ev = await R.api(NAME, "GET", `/sessions/${enc(s2.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    const rows = await L.tasks(NAME, pid);
    out.rows = rows.map((t) => ({ title: t.title, status: t.status, display: t.display?.label, specialist: t.specialist, outcome: t.outcome }));
    out.files = execSync(`cd ${ws} && git status --short; find . -path ./.git -prune -o -type f -print | sort`, { encoding: "utf8" });
    out.testingMd = fs.existsSync(path.join(ws, "docs/testing.md")) ? fs.readFileSync(path.join(ws, "docs/testing.md"), "utf8") : null;
    for (const t of rows) {
      await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2500);
      await R.step(page, `r04 drawer ${t.specialist} ${t.title}`.slice(0, 60));
    }
  } finally { save(NAME, "noise2.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
