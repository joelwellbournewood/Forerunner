// Club session, phase "run": Start session (default budget); Home runs; while About runs and
// about.html is in the folder, Cancel on its row (C5); Contact stops at its CHF 0.01 budget (C3).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("club2-log.txt");
const pid = fs.readFileSync(`${L.STEPS}/club-pid.txt`, "utf8").trim();
const ws = R.workspaceOf(N, pid);

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    await L.openStart(page, pid);
    await R.step(page, "club2-01-start-dialog");
    await L.confirmStart(page);
    await R.step(page, "club2-02-started");
    const about = await L.taskBy(pid, /^About page/);
    // Watch the Tasks tab while Home runs; wait until About runs and about.html is written.
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2000);
    const seen = await R.until(
      async () => {
        const t = (await L.tasksOf(pid)).find((x) => x.id === about.id);
        if (["done", "in_review", "needs_human", "failed"].includes(t.status)) return { late: t.status };
        return ["claimed", "in_progress"].includes(t.status) && fs.existsSync(path.join(ws, "about.html")) ? { t } : null;
      },
      900000,
      150,
      "about.html written while About runs",
    );
    if (seen.late) {
      log("About was already", seen.late, "before its file was seen; no cancel while running");
    } else {
      log("about.html written while About runs; index.html links about:", /about\.html/.test(fs.readFileSync(path.join(ws, "index.html"), "utf8")));
      await page.reload();
      await sleep(1200);
      const row = L.rowOf(page, "About page in about.html");
      log("row before cancel:", (await row.innerText()).replace(/\n/g, " | "));
      await row.getByTestId("action-cancel").click();
      await sleep(500);
      const dlgText = await R.step(page, "club2-03-cancel-dialog");
      const dialog = page.getByRole("dialog");
      log("cancel dialog:", (await dialog.innerText().catch(() => dlgText.slice(-600))).replace(/\n/g, " | "));
      await page.getByTestId("confirm-action").click();
      await sleep(2500);
      const after = await R.step(page, "club2-04-cancelled");
      const moved = await page.getByTestId("task-moved-sentence").allInnerTexts().catch(() => []);
      log("moved line:", moved.join(" || "));
      const tAfter = (await L.tasksOf(pid)).find((x) => x.id === about.id);
      log("About after cancel:", tAfter.status, JSON.stringify(tAfter.display));
      await sleep(4000);
      log("about.html in folder after cancel:", fs.existsSync(path.join(ws, "about.html")));
      log("index.html links about after cancel:", fs.existsSync(path.join(ws, "index.html")) && /about\.html/.test(fs.readFileSync(path.join(ws, "index.html"), "utf8")));
      await page.goto(`${ui()}/projects/${pid}/files`);
      await sleep(2500);
      const files = await R.step(page, "club2-05-files-after-cancel");
      log("Files tab lists about.html:", /about\.html/.test(files));
    }
    // The rest of the session: Contact with its CHF 0.01 budget.
    await L.noRunningSession(900000);
    await sleep(3000);
    for (const t of await L.tasksOf(pid)) log("task at end:", t.title, t.status, JSON.stringify(t.display), JSON.stringify(t.check ?? null));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    const tasksText = await R.step(page, "club2-06-tasks-after-session");
    const contactRow = L.rowOf(page, "Contact page in contact.html");
    log("Contact row:", (await contactRow.innerText()).replace(/\n/g, " | "));
    log("Contact row buttons:", (await contactRow.getByRole("button").allInnerTexts()).join(" / "));
    const aboutRow = L.rowOf(page, "About page in about.html");
    log("About row:", (await aboutRow.innerText()).replace(/\n/g, " | "));
    log("Tasks tab has $ or USD:", /\$|USD/.test(tasksText));
    await L.openDrawer(page, pid, "Contact page in contact.html");
    const drawer = await R.step(page, "club2-07-contact-drawer");
    log("Contact drawer has $ or USD:", /\$|USD/.test(drawer), "Resume:", /Resume/.test(drawer));
    await page.keyboard.press("Escape");
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "club2-08-inbox");
    const card = page.getByTestId("request").filter({ hasText: "Contact page in contact.html" });
    log("Contact cards visible:", await card.count());
    if (await card.count()) log("card:", (await card.first().innerText()).replace(/\n/g, " | "));
    log("Inbox has $ or USD:", /\$|USD/.test(inbox));
    await page.goto(`${ui()}/projects/${pid}`);
    await sleep(2500);
    const ov = await R.step(page, "club2-09-overview");
    log("overview:", (ov.match(/Last result[\s\S]{0,500}/) || [""])[0].replace(/\n/g, " | "));
    log("Overview has $ or USD:", /\$|USD/.test(ov));
    await page.goto(`${ui()}/`);
    await sleep(2500);
    const home = await R.step(page, "club2-10-home");
    log("home:", home.slice(home.indexOf("Home\nNeeds"), home.indexOf("Home\nNeeds") + 600).replace(/\n/g, " | "));
    // Session page of this session.
    const ss = await L.sessionsOf(pid);
    const last = ss.sort((a, b) => String(b.startedAt ?? b.createdAt).localeCompare(String(a.startedAt ?? a.createdAt)))[0];
    await page.goto(`${ui()}/sessions/${last.id}`);
    await sleep(2500);
    const sess = await R.step(page, "club2-11-session");
    log("session page head:", sess.slice(0, 1500).replace(/\n/g, " | "));
    // The Contact brief/work must not mention the cancelled page.
    const contactCalls = L.callLines((c) => c.role === "specialist" && /Contact page/.test(c.label ?? ""));
    log("Contact specialist calls:", contactCalls.map((c) => c.n).join(","), "mention about.html:", contactCalls.some((c) => JSON.stringify(c.messages).includes("about.html")));
    const aboutCritic = L.callLines((c) => c.role === "critic" && c.task === about.id);
    const aboutCritic2 = L.callLines((c) => c.role === "critic" && JSON.stringify(c.messages).includes("About page in about.html"));
    log("critic calls for the cancelled About:", aboutCritic.length, aboutCritic2.length);
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "club2-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
