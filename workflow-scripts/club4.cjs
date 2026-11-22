// Club phase 4: the Contact task left 'Being reviewed' by the quit: what a person sees (Start
// dialog, row, drawer); Cancel on it (C9: a task in review no session reviews: 'Drops it.' and
// 'Cancelled "X".', files stay); Reopen; Start: About (restored by Undo) and Contact run and are
// reviewed (V3: the critic reads about.html; C7a/C3: Contact ends Done).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("club4-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
const ws = R.workspaceOf(N, pid);
const TITLE = "Contact page in contact.html";

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await R.reconnect(page, N);
    const dlg = await L.openStart(page, pid);
    log("start dialog with Contact stuck in review:", (await dlg.innerText()).replace(/\n/g, " | ").slice(0, 900));
    await R.step(page, "club4-01-start-dialog");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await L.openDrawer(page, pid, TITLE);
    const dr = await R.step(page, "club4-02-contact-drawer-stuck");
    log("drawer (stuck):", dr.slice(dr.indexOf(TITLE, dr.indexOf("Actions")), dr.indexOf(TITLE, dr.indexOf("Actions")) + 700).replace(/\n/g, " | "));
    await page.keyboard.press("Escape");
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2000);
    const row = L.rowOf(page, TITLE);
    log("row:", (await row.innerText()).replace(/\n/g, " | "));
    await row.getByTestId("action-cancel").click();
    await sleep(600);
    log("cancel dialog:", (await page.getByRole("dialog").innerText()).replace(/\n/g, " | "));
    await R.step(page, "club4-03-cancel-dialog");
    await page.getByTestId("confirm-action").click();
    await sleep(3000);
    await R.step(page, "club4-04-cancelled");
    log("moved line:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    log("contact.html still in folder:", fs.existsSync(path.join(ws, "contact.html")));
    // Reopen it.
    await page.reload();
    await sleep(2000);
    const row2 = L.rowOf(page, TITLE);
    log("row after cancel:", (await row2.innerText()).replace(/\n/g, " | "));
    await row2.getByRole("button", { name: "Reopen" }).click();
    await sleep(800);
    if (await page.getByTestId("confirm-action").count()) await page.getByTestId("confirm-action").click();
    await sleep(2500);
    log("after reopen:", (await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => [])).join(" || "));
    for (const t of await L.tasksOf(pid)) log("task:", t.title, t.status);
    const firstCall = R.modelCalls(N).length;
    const dlg2 = await L.openStart(page, pid);
    log("start dialog:", (await dlg2.innerText()).replace(/\n/g, " | ").slice(0, 700));
    await L.confirmStart(page);
    await sleep(5000);
    await L.noRunningSession(1200000);
    await sleep(3000);
    for (const t of await L.tasksOf(pid)) log("task at end:", t.title, t.status, JSON.stringify(t.display.label), JSON.stringify(t.check ?? null));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "club4-05-tasks-end");
    for (const title of ["About page in about.html", TITLE]) {
      await L.openDrawer(page, pid, title);
      await L.seeWhatWasChecked(page);
      const d = await R.step(page, `club4-06-drawer-${title.slice(0, 5)}`);
      const ri = d.indexOf("Review\n");
      log(`drawer ${title}:`, d.slice(ri, ri + 1500).replace(/\n/g, " | "));
      await page.keyboard.press("Escape");
    }
    log("first call of this session:", firstCall + 1);
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "club4-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
