// C5 (chat variant): Reopen the Credits task, Start; while it runs (or is being reviewed),
// say in the project's Chat 'Skip the Credits page task' and confirm Yes. Expect the same
// cancel line as the row (its run/review stopped, what it changed removed), the file gone.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("c5chat-log.txt");
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
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2000);
    await exactRow(page, TITLE).getByRole("button", { name: "Reopen" }).click();
    await sleep(800);
    if (await page.getByTestId("confirm-action").count()) await page.getByTestId("confirm-action").click();
    await sleep(1500);
    const t = await L.taskBy(PID, /^Credits page/);
    await L.openStart(page, PID);
    await L.confirmStart(page);
    // Open Chat while it runs.
    await page.goto(`${ui()}/projects/${PID}/chat`);
    await sleep(1500);
    await R.until(
      async () => {
        const x = (await L.tasksOf(PID)).find((y) => y.id === t.id);
        return ["claimed", "in_progress", "in_review"].includes(x.status) ? x : null;
      },
      120000,
      200,
      "the task running",
    );
    const box = page.getByLabel("Chat message");
    await box.fill("Skip the Credits page task");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    log("sent at", new Date().toISOString(), "task status:", (await L.tasksOf(PID)).find((y) => y.id === t.id).status);
    const yes = page.getByTestId("confirm-yes");
    await yes.first().waitFor({ timeout: 90000 });
    log("confirm shown at", new Date().toISOString(), ":", (await page.getByTestId("pending-confirmation").innerText().catch(() => "")).replace(/\n/g, " | "));
    const before = (await L.tasksOf(PID)).find((y) => y.id === t.id).status;
    log("task status when pressing Yes:", before);
    await R.step(page, "c5chat-01-confirm");
    await yes.first().click();
    await sleep(3000);
    const chat = await R.step(page, "c5chat-02-after-yes");
    const lines = chat.split("\n").filter((l) => /Cancel|Skip|removed|stopped/i.test(l));
    log("chat lines:", lines.slice(-6).join(" || "));
    await sleep(3000);
    log("credits.html in folder:", fs.existsSync(path.join(ws, "credits.html")));
    const x = (await L.tasksOf(PID)).find((y) => y.id === t.id);
    log("task:", x.status, JSON.stringify(x.check ?? null));
    await L.noRunningSession(300000);
    await sleep(2000);
    log("credits.html in folder after the session:", fs.existsSync(path.join(ws, "credits.html")));
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2000);
    await R.step(page, "c5chat-03-tasks");
    log("row:", (await exactRow(page, TITLE).innerText()).replace(/\n/g, " | "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "c5chat-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
