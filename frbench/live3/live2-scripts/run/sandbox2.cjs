// R-sandbox sibling: with a browser that never starts, a page try reports the browser unavailable and logs no unsandboxed line.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const T = "Add a tagline under the title in index.html";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const pid = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Recipe card").id;
    // B is ready again after the Undo; pause it so only the new task runs
    const b = (await L.tasks(NAME, pid)).find((t) => t.title.startsWith("Add a print"));
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 1500);
    if (b.status === "ready") {
      const row = page.getByTestId("task-row").filter({ hasText: b.title }).first();
      await row.getByTestId("action-pause").click(); await page.waitForTimeout(600);
      await page.getByTestId("confirm-action").click(); await page.waitForTimeout(1500);
    }
    if (!(await L.tasks(NAME, pid)).find((t) => t.title === T))
      await L.newTask(page, NAME, pid, { title: T, outcome: "index.html shows the tagline 'Pancakes for twenty' under the recipe title", who: "coder" });
    await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog = await page.getByRole("dialog").innerText().catch(() => null);
    await page.getByTestId("confirm-start-session").click();
    const t0 = Date.now();
    const s = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t0 - 3000); }, 60000, 1000, "session");
    const d = await R.waitForSession(NAME, s.id, 900000);
    out.session = { status: d.status, summary: d.summary };
    const ev = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    const t = (await L.tasks(NAME, pid)).find((x) => x.title === T);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2500);
    const sw = page.getByText("See what was checked").first();
    if (await sw.count()) { await sw.click(); await page.waitForTimeout(1000); }
    const txt = await R.step(page, "sb01 drawer page try with a browser that never starts");
    const i = txt.indexOf("See what was checked");
    out.checked = i >= 0 ? txt.slice(i, i + 1200) : null;
    out.row = { status: t.status, display: t.display?.label };
  } finally { save(NAME, "sandbox2.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
