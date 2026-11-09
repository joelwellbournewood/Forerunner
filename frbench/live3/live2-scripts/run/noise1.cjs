// extra §3.1 (#95): no lessons or scratch notes in deliverables.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const fs = require("fs"), path = require("path");
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    let p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Shop numbers");
    const pid = p ? p.id : await L.newProject(page, NAME, { project: "Shop numbers", goal: "A sales report and launch copy for the shop" });
    out.pid = pid;
    const ws = R.workspaceOf(NAME, pid);
    fs.mkdirSync(path.join(ws, "data"), { recursive: true });
    fs.copyFileSync("/tmp/frbench/live2/run/scripts/fixtures/sales.csv", path.join(ws, "data", "sales.csv"));
    if (!(await L.tasks(NAME, pid)).length) {
      await L.newTask(page, NAME, pid, { title: "Write the sales report in report.md", outcome: "report.md gives the monthly totals and the best month from data/sales.csv", who: "data-analyst" });
      await L.newTask(page, NAME, pid, { title: "Write the launch copy in docs/copy.md", outcome: "a headline and two short paragraphs", who: "writer-marketing" });
    }
    await goto(page, NAME, `/projects/${enc(pid)}`);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog = await R.step(page, "n01 start dialog shop numbers");
    await page.getByTestId("confirm-start-session").click();
    const t0 = Date.now();
    await page.waitForTimeout(2000);
    const sess = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((s) => Date.parse(s.startedAt) >= t0 - 3000); }, 60000, 1000, "session");
    const s = await R.waitForSession(NAME, sess.id, 900000);
    out.session = { status: s.status, summary: s.summary };
    const ev = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
    out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    out.rows = (await L.tasks(NAME, pid)).map((t) => ({ title: t.title, status: t.status, display: t.display?.label }));
    const read = (f) => (fs.existsSync(path.join(ws, f)) ? fs.readFileSync(path.join(ws, f), "utf8") : null);
    out.report = read("report.md"); out.copy = read("docs/copy.md");
    out.lessonLines = [out.report, out.copy].map((t) => (t ?? "").split("\n").filter((l) => /^\s*(\*\*)?Lesson/i.test(l)));
    out.rootFiles = fs.readdirSync(ws);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
    await R.step(page, "n02 tasks shop numbers");
    await goto(page, NAME, "/memory", 3000);
    out.memory = await R.step(page, "n03 memory page");
  } finally { save(NAME, "noise1.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
