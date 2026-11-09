// L-6: cancel a running print task while the session goes on to a task that changes index.html; then Undo.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const B = "Add a print stylesheet print.css and link it from index.html", E = "Make the recipe title bigger in index.html";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const pid = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Recipe card").id;
    out.pid = pid;
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2000);
    const rowB = () => page.getByTestId("task-row").filter({ hasText: B }).first();
    if ((await L.tasks(NAME, pid)).find((t) => t.title === B).status === "cancelled") {
      await rowB().getByTestId("action-reopen").click();
      await page.waitForTimeout(800);
      out.reopenDialog = await page.getByTestId("action-dialog").innerText().catch(() => null);
      await page.getByTestId("confirm-action").click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }
    if (!(await L.tasks(NAME, pid)).find((t) => t.title === E))
      await L.newTask(page, NAME, pid, { title: E, outcome: "The recipe title in index.html is a larger heading than now", who: "coder" });
    out.before = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status }));
    await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog = await page.getByRole("dialog").innerText().catch(() => null);
    await page.getByTestId("confirm-start-session").click();
    const t0 = Date.now();
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 500);
    await R.until(async () => /Running/.test(await rowB().innerText()), 300000, 200, "B running");
    await page.waitForTimeout(1500); // let it write something
    out.bRowRunning = await rowB().innerText();
    await rowB().getByTestId("action-cancel").click();
    await page.waitForTimeout(600);
    out.cancelDialog = await page.getByTestId("action-dialog").innerText().catch(() => null);
    await R.step(page, "l01 cancel dialog running print task");
    await page.getByTestId("confirm-action").click();
    await page.waitForTimeout(2500);
    out.moved = await page.getByTestId("task-moved-sentence").innerText().catch(() => null);
    await R.step(page, "l02 after cancel running");
    const s = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t0 - 3000); }, 60000, 1000, "session");
    const d = await R.waitForSession(NAME, s.id, 900000);
    out.session = { status: d.status, summary: d.summary };
    const ev = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    await goto(page, NAME, "/changes", 2500);
    const entry = page.locator("li, article, div").filter({ hasText: `Cancelled "${B}"` }).filter({ has: page.getByRole("button", { name: /^Undo$/ }) }).last();
    const undo = entry.getByRole("button", { name: /^Undo$/ }).first();
    out.undoCount = await undo.count();
    out.changesEntry = out.undoCount ? await entry.innerText() : null;
    if (out.undoCount) {
      await undo.click(); await page.waitForTimeout(3000);
      out.afterUndo = (await page.evaluate(() => document.body.innerText)).split("\n").filter((l) => /Undone|could not|changed since|is back/.test(l)).slice(0, 5);
      await R.step(page, "l03 after undo in changes");
    }
    const tb = (await L.tasks(NAME, pid)).find((t) => t.title === B);
    out.bAfter = { status: tb.status, display: tb.display?.label };
  } finally { save(NAME, "l6.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
