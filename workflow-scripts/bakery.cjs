// Bakery: New project from a brief that needs the owner's content -> plan card -> Approve and
// start (C1). While an agent task runs and its file is in Files, answer the person card with
// Send answers, then Cancel the running row (C8); the decision record keeps the answers; Undo
// brings the files back and the answers appear once. Then the task that waits on the person
// runs with the answers in its brief (C1).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("bakery-log.txt");
const NAME = "Bakery Bern";
const BRIEF =
  "A one-page website for a small bakery in Bern; I will give you the real menu, hours and address";
const ANS = {
  menu: "Menu: Butterzopf CHF 6.50, Nussgipfel CHF 3.20, Bernese Lebkuchen CHF 4.80, Birchermüesli CHF 7.00, coffee CHF 4.20",
  hours: "Hours: Tuesday to Friday 07:00-18:30, Saturday 07:00-16:00, closed Sunday and Monday",
  address: "Address: Kramgasse 12, 3011 Bern (Bäckerei Sonnenkorn), phone 031 312 45 67",
};
const answerFor = (q) => {
  if (/menu|product|price|bake|sell|item/i.test(q)) return ANS.menu;
  if (/hour|open|time|day/i.test(q)) return ANS.hours;
  if (/address|where|location|contact|phone|street/i.test(q)) return ANS.address;
  if (/name/i.test(q)) return "The bakery is called Bäckerei Sonnenkorn.";
  return `${ANS.menu}. ${ANS.hours}. ${ANS.address}.`;
};

async function personCardOpen(pid) {
  const inbox = await R.api(N, "GET", "/inbox");
  const tasks = await L.tasksOf(pid);
  const ids = new Set(tasks.map((t) => t.id));
  return inbox.requests.find((r) => r.status === "open" && ids.has(r.taskId) && r.kind !== "approval") ?? null;
}

async function sendAnswers(page, pid) {
  await page.goto(`${ui()}/inbox`);
  await sleep(2000);
  const form = page.getByTestId("person-questions").first();
  await form.waitFor({ timeout: 15000 });
  const card = page.getByTestId("request").filter({ has: page.getByTestId("person-questions") }).first();
  log("person card:", (await card.innerText()).replace(/\n/g, " | ").slice(0, 1500));
  const labels = await form.locator("label").allInnerTexts();
  const boxes = form.getByTestId("person-answer");
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).fill(answerFor(labels[i] ?? ""));
  await R.step(page, "bakery-05-answers-filled");
  await form.getByTestId("send-answers").click();
  await sleep(2500);
  await R.step(page, "bakery-06-answers-sent");
  log("done lines:", (await page.getByTestId("done-line").allInnerTexts().catch(() => [])).join(" || "));
  return labels;
}

function decisionDocs(ws) {
  const dir = path.join(ws, "docs", "decisions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => ({ f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    const pid = await L.newProject(page, { name: NAME, brief: BRIEF });
    fs.writeFileSync(`${L.STEPS}/bakery-pid.txt`, pid);
    const ws = R.workspaceOf(N, pid);
    log("project", pid);
    await R.until(
      async () => {
        const s = await R.api(N, "GET", `/projects/${pid}/intake`);
        if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
        return s.state === "pending" ? s : null;
      },
      600000,
      2000,
      "the plan",
    );
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const card = page.getByTestId("request").filter({ hasText: `Plan for "${NAME}"` });
    log("plan card:", (await card.innerText()).replace(/\n/g, " | "));
    await R.step(page, "bakery-01-plan-card");
    await card.getByRole("button", { name: "Approve and start", exact: true }).click();
    await sleep(3000);
    await R.step(page, "bakery-02-approved");
    let tasks = await L.tasksOf(pid);
    for (const t of tasks)
      log("task:", t.title, "|", t.specialist, "|", t.status, "| deps", JSON.stringify(t.dependsOn ?? null));
    // An agent task that runs now (no wait on the person)?
    let runner = null;
    try {
      runner = await R.until(
        async () => {
          const ts = await L.tasksOf(pid);
          return ts.find((t) => t.specialist && t.specialist !== "person" && ["claimed", "in_progress"].includes(t.status)) ?? null;
        },
        45000,
        500,
        "an agent task running",
      );
    } catch {
      runner = null;
    }
    if (!runner) {
      log("no agent task runs before the answers: adding one (New task) that does not wait on the person");
      await L.noRunningSession(120000);
      await L.newTask(page, pid, {
        title: "Stylesheet for the bakery page",
        outcome: "styles.css: warm colours and readable type for the bakery's one-page site",
        criteria: "styles.css exists",
        who: "coder",
        priority: "high",
      });
      await L.submitTask(page);
      await L.openStart(page, pid);
      await L.confirmStart(page);
      runner = await R.until(
        async () => {
          const ts = await L.tasksOf(pid);
          return ts.find((t) => t.title === "Stylesheet for the bakery page" && ["claimed", "in_progress"].includes(t.status)) ?? null;
        },
        120000,
        500,
        "the stylesheet task running",
      );
    }
    log("running:", runner.title);
    // Wait until its run wrote a file (git status shows a change) while it still runs.
    const before = new Set(fs.readdirSync(ws));
    const written = await R.until(
      async () => {
        const t = (await L.tasksOf(pid)).find((x) => x.id === runner.id);
        if (!["claimed", "in_progress"].includes(t.status)) return { late: t.status };
        const now = fs.readdirSync(ws).filter((f) => !before.has(f) && !f.startsWith("."));
        return now.length ? { files: now } : null;
      },
      600000,
      150,
      "a file written by the running task",
    );
    log("written while running:", JSON.stringify(written));
    if (written.late) throw new Error(`the task ended (${written.late}) before a new file was seen`);
    // Answer the person card now, while it runs.
    const pc = await personCardOpen(pid);
    log("person card open:", pc ? pc.title : "none");
    const labels = await sendAnswers(page, pid);
    log("questions:", labels.join(" || "));
    const docsAfterAnswer = decisionDocs(ws);
    log("decision docs after answers:", docsAfterAnswer.map((d) => `${d.f}: answers=${/Answers for/.test(d.text)} kramgasse=${(d.text.match(/Kramgasse 12/g) || []).length}`).join("; "));
    // Cancel the running row.
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(1500);
    const t0 = (await L.tasksOf(pid)).find((x) => x.id === runner.id);
    log("runner before cancel:", t0.status);
    const row = L.rowOf(page, runner.title);
    await row.getByTestId("action-cancel").click();
    await sleep(500);
    log("cancel dialog:", (await page.getByRole("dialog").innerText()).replace(/\n/g, " | "));
    await R.step(page, "bakery-07-cancel-dialog");
    await page.getByTestId("confirm-action").click();
    await sleep(3000);
    await R.step(page, "bakery-08-cancelled");
    log("moved line:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    await sleep(3000);
    const left = fs.readdirSync(ws).filter((f) => !f.startsWith("."));
    log("folder after cancel:", left.join(", "), "| written files still there:", written.files.filter((f) => fs.existsSync(path.join(ws, f))).join(","));
    const docsAfterCancel = decisionDocs(ws);
    log("decision docs after cancel:", docsAfterCancel.map((d) => `${d.f}: answers=${/Answers for/.test(d.text)} kramgasse=${(d.text.match(/Kramgasse 12/g) || []).length}`).join("; "));
    await page.goto(`${ui()}/projects/${pid}/files`);
    await sleep(2500);
    const files = await R.step(page, "bakery-09-files-after-cancel");
    log("Files tab lists the written files:", written.files.map((f) => `${f}=${files.includes(f)}`).join(","));
    // Undo from the Tasks tab line.
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2000);
    let undo = page.getByTestId("task-moved-undo");
    if (!(await undo.count())) {
      log("no Undo on the Tasks tab line (page reloaded); using Changes");
      await page.goto(`${ui()}/changes`);
      await sleep(2500);
      undo = page.getByTestId("change").filter({ hasText: runner.title }).first().getByTestId("change-undo");
    }
    await undo.first().click();
    await sleep(3000);
    const afterUndo = await R.step(page, "bakery-10-after-undo");
    log("after undo:", (afterUndo.match(/[^\n]*(back in the folder|picks it up|Undone)[^\n]*/g) || []).join(" || "));
    log("written files back:", written.files.map((f) => `${f}=${fs.existsSync(path.join(ws, f))}`).join(","));
    const docsAfterUndo = decisionDocs(ws);
    log("decision docs after undo:", docsAfterUndo.map((d) => `${d.f}: answers=${(d.text.match(/Answers for/g) || []).length} kramgasse=${(d.text.match(/Kramgasse 12/g) || []).length}`).join("; "));
    const tU = (await L.tasksOf(pid)).find((x) => x.id === runner.id);
    log("runner after undo:", tU.status, JSON.stringify(tU.display));
    // Let the work that waits on the person run (a session from the answers, or Start).
    await sleep(5000);
    tasks = await L.tasksOf(pid);
    for (const t of tasks) log("task now:", t.title, "|", t.specialist, "|", t.status);
    const running = await R.api(N, "GET", "/sessions?status=running").catch(() => []);
    log("sessions running:", JSON.stringify(running.map((s) => s.id)));
    if (!running.length) {
      const dlg = await L.openStart(page, pid);
      log("start dialog:", (await dlg.innerText()).replace(/\n/g, " | ").slice(0, 700));
      await R.step(page, "bakery-11-start-dialog");
      if (await dlg.getByTestId("confirm-start-session").isEnabled()) await L.confirmStart(page);
    }
    await sleep(5000);
    await L.noRunningSession(1500000);
    await sleep(3000);
    tasks = await L.tasksOf(pid);
    for (const t of tasks) log("task at end:", t.title, "|", t.specialist, "|", t.status, JSON.stringify(t.display?.label), JSON.stringify(t.check ?? null));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "bakery-12-tasks-end");
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "bakery-13-inbox-end");
    log("inbox needs you:", inbox.slice(inbox.indexOf("Needs you"), inbox.indexOf("Needs you") + 800).replace(/\n/g, " | "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "bakery-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
