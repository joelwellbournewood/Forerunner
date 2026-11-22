// Club phase 3a: Raise the budget on the Contact card (C3); while Contact reads 'Being reviewed',
// Stop now on the session page (C7a); checks; Start again; exit once it reads 'Being reviewed'
// again (the caller then quits and restarts Forerunner).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("club3a-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
const ws = R.workspaceOf(N, pid);
const TITLE = "Contact page in contact.html";

async function runningSessionId() {
  return R.until(
    async () => {
      const s = await R.api(N, "GET", "/sessions?status=running").catch(() => null);
      return Array.isArray(s) && s.length ? s[0].id : null;
    },
    60000,
    500,
    "a running session",
  );
}

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    const contact = await L.taskBy(pid, /^Contact page/);
    // Raise the budget from the Inbox card.
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const card = page.getByTestId("request").filter({ hasText: TITLE }).first();
    await card.getByRole("button", { name: "Raise the budget" }).click();
    await sleep(1000);
    await R.step(page, "club3-01-raise-confirm");
    if (await page.getByTestId("choice-confirm-yes").count()) {
      log("confirm:", (await page.getByTestId("choice-confirm").innerText().catch(() => "")).replace(/\n/g, " | "));
      await page.getByTestId("choice-confirm-yes").first().click();
    }
    await sleep(2500);
    const raised = await R.step(page, "club3-02-raised");
    log("done lines:", (await page.getByTestId("done-line").allInnerTexts().catch(() => [])).join(" || "));
    const sid = await runningSessionId();
    log("session started by Raise:", sid);
    const t1 = (await L.tasksOf(pid)).find((x) => x.id === contact.id);
    log("Contact budget after raise:", JSON.stringify(t1.budget));
    // Wait on the session page until Contact is being reviewed.
    await page.goto(`${ui()}/sessions/${sid}`);
    await sleep(2000);
    await R.until(
      async () => {
        const t = (await L.tasksOf(pid)).find((x) => x.id === contact.id);
        if (["done", "needs_human", "failed", "ready"].includes(t.status)) throw new Error(`Contact went ${t.status} before review`);
        return t.status === "in_review" ? t : null;
      },
      600000,
      150,
      "Contact being reviewed",
    );
    log("Contact reads in_review; pressing Stop now");
    await page.getByTestId("stop-now").click();
    await sleep(300);
    await page.getByTestId("stop-session").click();
    await sleep(3000);
    await R.step(page, "club3-03-stopped-now");
    await L.noRunningSession(120000);
    await sleep(3000);
    await page.reload();
    await sleep(3000);
    const sess = await R.step(page, "club3-04-session-after-stop");
    log("session status line:", (sess.match(/Stopped by you[^\n]*/g) || []).join(" || "));
    log("session log mentions ready again:", (sess.match(/[^\n]*ready again[^\n]*/g) || []).join(" || "));
    const t2 = (await L.tasksOf(pid)).find((x) => x.id === contact.id);
    log("Contact after Stop now:", t2.status, JSON.stringify(t2.display), "attempt", t2.attempt);
    log("contact.html in folder:", fs.existsSync(path.join(ws, "contact.html")));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "club3-05-tasks-after-stop");
    log("Contact row:", (await L.rowOf(page, TITLE).innerText()).replace(/\n/g, " | "));
    await L.openDrawer(page, pid, TITLE);
    const dr = await R.step(page, "club3-06-drawer-after-stop");
    const ri = dr.indexOf("Runs");
    log("drawer runs/review:", dr.slice(ri, ri + 1200).replace(/\n/g, " | "));
    await page.keyboard.press("Escape");
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    await R.step(page, "club3-07-inbox-after-stop");
    const open = (await R.api(N, "GET", "/inbox")).requests.filter((r) => r.taskId === contact.id && r.status === "open");
    log("open cards for Contact:", open.length);
    await page.goto(`${ui()}/projects/${pid}/files`);
    await sleep(2500);
    const files = await R.step(page, "club3-08-files-after-stop");
    log("Files lists contact.html:", /contact\.html/.test(files));
    // Start again.
    const dlg = await L.openStart(page, pid);
    log("start dialog:", (await dlg.innerText()).replace(/\n/g, " | ").slice(0, 600));
    await L.confirmStart(page);
    const sid2 = await runningSessionId();
    log("second session:", sid2);
    await R.until(
      async () => {
        const t = (await L.tasksOf(pid)).find((x) => x.id === contact.id);
        if (["done", "needs_human", "failed"].includes(t.status)) throw new Error(`Contact went ${t.status} before review`);
        return t.status === "in_review" ? t : null;
      },
      600000,
      150,
      "Contact being reviewed again",
    );
    log("Contact reads in_review again: quit and restart now", new Date().toISOString());
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "club3-error").catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
