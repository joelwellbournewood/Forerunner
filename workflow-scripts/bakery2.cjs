// Bakery part 2. The real planner made no person task, so the person adds it (New task, Who
// does it = Me) with a coder task that waits on it, plus an independent coder task. Start: while
// the independent task runs and its file is in the folder, Send answers on the person card, then
// Cancel the running row (C8): the files leave, the decision record keeps the answers; Undo:
// the files come back and the answers appear once. Then the waiting coder task runs with the
// answers in its brief (C1).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("bakery2-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/bakery-pid.txt`, "utf8").trim();
const ws = R.workspaceOf(N, pid);
const PERSON = "Give the bakery's real menu, hours and address";
const FILL = "Put the real menu, hours and address into the page";
const SIDE = "Add a print stylesheet print.css for the menu";
const ANS = [
  "Butterzopf CHF 6.50, Nussgipfel CHF 3.20, Bernese Lebkuchen CHF 4.80, Birchermuesli CHF 7.00, coffee CHF 4.20",
  "Tuesday to Friday 07:00-18:30, Saturday 07:00-16:00, closed Sunday and Monday",
  "Baeckerei Sonnenkorn, Kramgasse 12, 3011 Bern, phone 031 312 45 67",
];

const exactRow = (page, title) =>
  page.getByTestId("task-row").filter({ has: page.getByTestId("task-title").getByText(title, { exact: true }) });

function decisionDocs() {
  const dir = path.join(ws, "docs", "decisions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => ({ f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
}
const docLine = (ds) =>
  ds.map((d) => `${d.f}: 'Answers for'=${(d.text.match(/Answers for/g) || []).length} Kramgasse=${(d.text.match(/Kramgasse 12/g) || []).length}`).join("; ");

async function pickDeps(dlg, titles) {
  for (const t of titles) {
    const opt = dlg.getByTestId("dependency-picker").locator("label").filter({ hasText: t }).getByTestId("dependency-option");
    await opt.check();
  }
}

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession(1200000);
    for (const t of await L.tasksOf(pid)) log("plan task:", t.title, t.status, JSON.stringify(t.display.label));
    let dlg = await L.newTask(page, pid, {
      title: PERSON,
      outcome: "The real menu with prices, the opening hours and the address, from me",
      criteria: "What is on the menu, with prices?\nWhat are the opening hours?\nWhat is the bakery's name, address and phone number?",
      who: "person",
      priority: "high",
    });
    await R.step(page, "bakery2-01-person-task");
    await L.submitTask(page);
    dlg = await L.newTask(page, pid, {
      title: FILL,
      outcome: "index.html shows the real menu, hours and address instead of the PLACEHOLDER texts",
      criteria: "No PLACEHOLDER marker is left for the menu, the hours or the address\nThe page uses exactly the menu, hours and address the person gave",
      who: "coder",
      priority: "high",
    });
    await pickDeps(dlg, [PERSON]);
    await R.step(page, "bakery2-02-fill-task");
    await L.submitTask(page);
    await L.newTask(page, pid, {
      title: SIDE,
      outcome: "print.css: when the page is printed, only the menu shows, in black on white; index.html links it with media=print",
      criteria: "print.css exists\nindex.html links print.css with media=\"print\"",
      who: "coder",
      priority: "medium",
    });
    await L.submitTask(page);
    await page.reload();
    await sleep(2000);
    await R.step(page, "bakery2-03-tasks");
    for (const t of await L.tasksOf(pid)) log("task:", t.title, t.specialist, t.status, JSON.stringify(t.dependsOn ?? null));
    await L.openStart(page, pid);
    await L.confirmStart(page);
    const side = await L.taskBy(pid, /^Add a print stylesheet/);
    const seen = await R.until(
      async () => {
        const t = (await L.tasksOf(pid)).find((x) => x.id === side.id);
        if (["in_review", "done", "needs_human", "failed"].includes(t.status)) return { late: t.status };
        return ["claimed", "in_progress"].includes(t.status) && fs.existsSync(path.join(ws, "print.css")) ? { ok: true } : null;
      },
      600000,
      120,
      "print.css written while the task runs",
    );
    if (seen.late) throw new Error(`the print task was ${seen.late} before print.css was seen`);
    log("print.css written while running; index links print.css:", /print\.css/.test(fs.readFileSync(path.join(ws, "index.html"), "utf8")));
    log("decision docs before answers:", docLine(decisionDocs()));
    // Answer the person card now.
    await page.goto(`${ui()}/inbox`);
    await sleep(1500);
    const card = page.getByTestId("request").filter({ hasText: PERSON }).first();
    log("person card:", (await card.innerText()).replace(/\n/g, " | ").slice(0, 900));
    const boxes = card.getByTestId("person-answer");
    const n = await boxes.count();
    for (let i = 0; i < n; i++) await boxes.nth(i).fill(ANS[i] ?? ANS.join("; "));
    await card.getByTestId("send-answers").click();
    await sleep(2000);
    await R.step(page, "bakery2-04-answers-sent");
    log("done lines:", (await page.getByTestId("done-line").allInnerTexts().catch(() => [])).join(" || "));
    const tSide = (await L.tasksOf(pid)).find((x) => x.id === side.id);
    log("print task when answers were sent:", tSide.status);
    log("decision docs after answers:", docLine(decisionDocs()));
    // Cancel the running row.
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(1200);
    const row = exactRow(page, SIDE);
    log("row before cancel:", (await row.innerText()).replace(/\n/g, " | "));
    await row.getByTestId("action-cancel").click();
    await sleep(400);
    log("cancel dialog:", (await page.getByRole("dialog").innerText()).replace(/\n/g, " | "));
    await R.step(page, "bakery2-05-cancel-dialog");
    await page.getByTestId("confirm-action").click();
    await sleep(2500);
    await R.step(page, "bakery2-06-cancelled");
    log("line:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    await sleep(3000);
    log("print.css after cancel:", fs.existsSync(path.join(ws, "print.css")), "| index links print.css:", /print\.css/.test(fs.readFileSync(path.join(ws, "index.html"), "utf8")));
    log("decision docs after cancel:", docLine(decisionDocs()));
    const ptask = await L.taskBy(pid, /^Give the bakery/);
    log("person task after cancel:", ptask.status, JSON.stringify(ptask.display.label));
    await page.goto(`${ui()}/projects/${pid}/files`);
    await sleep(2500);
    const files = await R.step(page, "bakery2-07-files-after-cancel");
    log("Files lists print.css:", /print\.css/.test(files));
    // Undo from the line on the Tasks tab (else Changes).
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(1500);
    let undo = page.getByTestId("task-moved-undo");
    if (!(await undo.count())) {
      await page.goto(`${ui()}/changes`);
      await sleep(2500);
      undo = page.getByTestId("change").filter({ hasText: SIDE }).first().getByTestId("change-undo");
    }
    await undo.first().click();
    await sleep(3000);
    const au = await R.step(page, "bakery2-08-after-undo");
    log("after undo:", (au.match(/[^\n]*(back in the folder|picks it up)[^\n]*/g) || []).slice(0, 2).join(" || "));
    log("print.css back:", fs.existsSync(path.join(ws, "print.css")));
    log("decision docs after undo:", docLine(decisionDocs()));
    // The waiting task runs with the answers (a session from the answers, or Start).
    await sleep(4000);
    const running = await R.api(N, "GET", "/sessions?status=running").catch(() => []);
    log("sessions running after undo:", running.length);
    await L.noRunningSession(1200000);
    await sleep(2000);
    let fill = await L.taskBy(pid, /^Put the real menu/);
    log("fill task after the session:", fill.status);
    if (fill.status === "ready") {
      const d = await L.openStart(page, pid);
      log("start dialog:", (await d.innerText()).replace(/\n/g, " | ").slice(0, 600));
      await L.confirmStart(page);
      await sleep(5000);
      await L.noRunningSession(1200000);
      await sleep(2000);
    }
    for (const t of await L.tasksOf(pid)) log("task at end:", t.title, t.status, JSON.stringify(t.display.label));
    fill = await L.taskBy(pid, /^Put the real menu/);
    const briefs = L.callLines((c) => c.role === "specialist" && c.task === fill.id && (c.messages ?? []).length === 1);
    for (const b of briefs) {
      const first = typeof b.messages[0].content === "string" ? b.messages[0].content : JSON.stringify(b.messages[0].content);
      const i = first.indexOf("## Answers from the person to");
      log(`fill brief line ${b.n}: has section=${i >= 0}`, i >= 0 ? first.slice(i, i + 900).replace(/\n/g, " | ") : "");
    }
    const html = fs.readFileSync(path.join(ws, "index.html"), "utf8");
    log("index.html uses answers:", ["Kramgasse 12", "Nussgipfel", "07:00", "Sonnenkorn"].map((s) => `${s}=${html.includes(s)}`).join(" "), "PLACEHOLDER left:", (html.match(/PLACEHOLDER/g) || []).length);
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "bakery2-09-inbox-end");
    log("inbox:", inbox.slice(inbox.indexOf("Needs you"), inbox.indexOf("Needs you") + 600).replace(/\n/g, " | "));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "bakery2-10-tasks-end");
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "bakery2-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
