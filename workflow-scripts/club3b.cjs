// Club phase 3b, after Forerunner was quit during the review and reopened: Contact reads Ready
// and the Update says so (C7b); Start: Contact runs to Done; then Undo the About cancel in
// Changes (C5: after a restart the files come back).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("club3b-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
const ws = R.workspaceOf(N, pid);
const TITLE = "Contact page in contact.html";

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await R.reconnect(page, N);
    const contact = await L.taskBy(pid, /^Contact page/);
    log("Contact after restart:", contact.status, JSON.stringify(contact.display));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "club3b-01-tasks-after-restart");
    log("Contact row:", (await L.rowOf(page, TITLE).innerText()).replace(/\n/g, " | "));
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "club3b-02-inbox-after-restart");
    log("inbox lines about ready again / interrupted:", (inbox.match(/[^\n]*(ready again|interrupted)[^\n]*/g) || []).join(" || "));
    const open = (await R.api(N, "GET", "/inbox")).requests.filter((r) => r.taskId === contact.id && r.status === "open");
    log("open cards for Contact:", open.length);
    await page.goto(`${ui()}/projects/${pid}`);
    await sleep(2500);
    const ov = await R.step(page, "club3b-03-overview-after-restart");
    log("overview:", ov.slice(ov.indexOf("Last result"), ov.indexOf("Last result") + 500).replace(/\n/g, " | "));
    // Start: runs to Done.
    if (contact.status === "ready") {
      const dlg = await L.openStart(page, pid);
      log("start dialog:", (await dlg.innerText()).replace(/\n/g, " | ").slice(0, 500));
      await L.confirmStart(page);
      await sleep(5000);
      await L.noRunningSession(900000);
      await sleep(3000);
      const t = (await L.tasksOf(pid)).find((x) => x.id === contact.id);
      log("Contact at the end:", t.status, JSON.stringify(t.display), JSON.stringify(t.check ?? null));
      await page.goto(`${ui()}/projects/${pid}/tasks`);
      await sleep(2500);
      await R.step(page, "club3b-04-tasks-done");
      await L.openDrawer(page, pid, TITLE);
      await L.seeWhatWasChecked(page);
      const dr = await R.step(page, "club3b-05-contact-drawer");
      const ri = dr.indexOf("Runs");
      log("drawer runs/review:", dr.slice(ri, ri + 2500).replace(/\n/g, " | "));
      await page.keyboard.press("Escape");
    }
    // Undo the About cancel in Changes.
    await page.goto(`${ui()}/changes`);
    await sleep(3000);
    const ch = await R.step(page, "club3b-06-changes");
    const change = page.getByTestId("change").filter({ hasText: /About page/ });
    log("changes about About:", await change.count(), (await change.allInnerTexts()).join(" || ").replace(/\n/g, " | ").slice(0, 800));
    const undo = change.first().getByTestId("change-undo");
    if (await undo.count()) {
      await undo.click();
      await sleep(1000);
      const yes = page.getByRole("button", { name: /^(Yes|Undo)/ });
      await R.step(page, "club3b-07-undo-clicked");
      await sleep(3000);
      const after = await R.step(page, "club3b-08-after-undo");
      log("after undo text:", (after.match(/[^\n]*(back in the folder|Undone|undone|picks it up)[^\n]*/g) || []).join(" || "));
      log("about.html back:", fs.existsSync(path.join(ws, "about.html")));
      const t = await L.taskBy(pid, /^About page/);
      log("About after undo:", t.status, JSON.stringify(t.display));
      await page.goto(`${ui()}/projects/${pid}/files`);
      await sleep(2500);
      const files = await R.step(page, "club3b-09-files-after-undo");
      log("Files lists about.html:", /about\.html/.test(files));
      log("index.html links about.html:", /about\.html/.test(fs.readFileSync(path.join(ws, "index.html"), "utf8")));
    } else {
      log("no Undo offered on the About change");
    }
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "club3b-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
