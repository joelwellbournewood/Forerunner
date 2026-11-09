// Zero-cost UI checks: Start dialog keeps the tasks that fit (C-45), Answer opens its card, session page result.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Budget fit");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Budget fit", goal: "Check what a session takes" });
    out.pid = pid;
    if (!(await L.tasks(NAME, pid)).length) {
      await L.newTask(page, NAME, pid, { title: "Write the long guide in guide.md", outcome: "guide.md explains the club rules", who: "writer-marketing", budget: "2.40" });
      await L.newTask(page, NAME, pid, { title: "Write the second guide in guide2.md", outcome: "guide2.md explains the tournament rules", who: "writer-marketing", budget: "2.40" });
      await L.newTask(page, NAME, pid, { title: "Write the short note in note.md", outcome: "note.md has one line", who: "writer-marketing", budget: "0.80" });
      const ts = await L.tasks(NAME, pid);
      // first task high priority, others low (Edit through API is not under test)
      for (const t of ts) await R.api(NAME, "PATCH", `/tasks/${enc(t.id)}`, { priority: t.title.includes("long guide") ? "high" : "low", version: t.version }).catch((e) => { out.patchError = String(e.message).slice(0, 300); });
    }
    out.rows = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, priority: t.priority, budget: t.budget, estimate: t.estimate }));
    await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(3000);
    out.dialog = await page.getByRole("dialog").innerText().catch(async () => await page.evaluate(() => document.body.innerText));
    await R.step(page, "z01 start dialog budget fit");
    await page.keyboard.press("Escape");
    // Answer on the Tasks tab opens its card
    const bk = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Bakery Bern").id;
    await goto(page, NAME, `/projects/${enc(bk)}/tasks`, 2000);
    const row = page.getByTestId("task-row").filter({ hasText: "Get the real menu" }).first();
    await row.getByRole("button", { name: "Answer" }).or(row.getByRole("link", { name: "Answer" })).first().click();
    await page.waitForTimeout(2500);
    out.answerUrl = page.url();
    await R.step(page, "z02 answer opens the card");
    // the cancel-only session page (stops stage 4)
    const st = JSON.parse(require("fs").readFileSync(`${R.bench(NAME).steps}/stops.json`, "utf8"));
    await goto(page, NAME, `/sessions/${enc(st.stages.s4.sid)}`, 2500);
    out.cancelSession = await R.step(page, "z03 session page after cancel in review");
    await goto(page, NAME, `/projects/${enc(st.pid)}`, 2500);
    out.recipeOverview = await R.step(page, "z04 recipe overview");
    await goto(page, NAME, "/", 2500);
    out.home = await R.step(page, "z05 home all projects");
  } finally { save(NAME, "zero.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
