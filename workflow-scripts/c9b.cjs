// C9b / C5: Cancel on the row while the task reads 'Being reviewed' (a live review): dialog and
// line say its review stopped and what it changed is removed; the file leaves Files; Undo.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("c9b-log.txt");
const PID = "01a19c8c-f359-7097-81fe-818e32a2556f"; // Quote page
const ws = R.workspaceOf(N, PID);
const TITLE = "Credits page in credits.html";
const exactRow = (page, title) =>
  page.getByTestId("task-row").filter({ has: page.getByTestId("task-title").getByText(title, { exact: true }) });

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    await L.newTask(page, PID, {
      title: TITLE,
      outcome: "credits.html lists where the quotes come from (one line per author), with a link back to index.html",
      criteria: "credits.html exists and links back to index.html",
      who: "coder",
      priority: "high",
      budget: "0.10",
    });
    await L.submitTask(page);
    const t = await L.taskBy(PID, /^Credits page/);
    await L.openStart(page, PID);
    await L.confirmStart(page);
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(1500);
    await R.until(
      async () => {
        const x = (await L.tasksOf(PID)).find((y) => y.id === t.id);
        if (["done", "needs_human", "failed"].includes(x.status)) throw new Error(`went ${x.status} before review`);
        return x.status === "in_review" ? x : null;
      },
      600000,
      150,
      "Being reviewed",
    );
    await page.reload();
    await sleep(800);
    const row = exactRow(page, TITLE);
    log("row:", (await row.innerText()).replace(/\n/g, " | "));
    await row.getByTestId("action-cancel").click();
    await sleep(300);
    log("dialog:", (await page.getByRole("dialog").innerText()).replace(/\n/g, " | "));
    await R.step(page, "c9b-01-cancel-dialog");
    await page.getByTestId("confirm-action").click();
    await sleep(2500);
    await R.step(page, "c9b-02-cancelled");
    log("line:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    await sleep(3000);
    log("credits.html in folder:", fs.existsSync(path.join(ws, "credits.html")));
    const x = (await L.tasksOf(PID)).find((y) => y.id === t.id);
    log("task:", x.status, JSON.stringify(x.display.label), JSON.stringify(x.check ?? null));
    await page.goto(`${ui()}/projects/${PID}/files`);
    await sleep(2500);
    const files = await R.step(page, "c9b-03-files");
    log("Files lists credits.html:", /credits\.html/.test(files));
    await L.noRunningSession(300000);
    const crit = L.callLines((c) => c.role === "critic" && (c.label ?? "").includes(t.id));
    log("critic calls for it:", crit.map((c) => `${c.n}:${c.reply?.stopReason}`).join(","));
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2000);
    await R.step(page, "c9b-04-tasks");
    log("row after:", (await exactRow(page, TITLE).innerText()).replace(/\n/g, " | "));
    await L.openDrawer(page, PID, TITLE);
    const d = await R.step(page, "c9b-05-drawer");
    log("drawer runs:", d.slice(d.indexOf("Runs"), d.indexOf("Runs") + 600).replace(/\n/g, " | "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "c9b-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
