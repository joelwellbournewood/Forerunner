// C4: the '"X" could not run' card on a refusal that still exists: a task naming a specialist
// the install does not have (as a planner writes it), in the Quote project.
"use strict";
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("c4-log.txt");
const PID = process.argv[2];

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    // The planner's task: a specialist this install does not have (not offered by New task).
    const created = await R.api(N, "POST", `/projects/${PID}/tasks`, {
      title: "Draw a logo for the quote page",
      outcome: "logo.svg: a simple logo for the quote page",
      acceptanceCriteria: ["logo.svg exists and is a valid SVG"],
      specialist: "illustrator",
      riskTier: 1,
      priority: "medium",
    });
    const tid = created.task?.id ?? created.id;
    log("created (API, as a plan writes it)", tid);
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2000);
    await R.step(page, "c4-01-tasks-before-start");
    // Start session as a person does.
    const dlg = await L.openStart(page, PID);
    await R.step(page, "c4-02-start-dialog");
    await L.confirmStart(page);
    await R.step(page, "c4-03-started");
    await R.until(
      async () => {
        const t = (await L.tasksOf(PID)).find((x) => x.id === tid);
        return t && t.status === "needs_human" ? t : null;
      },
      120000,
      1000,
      "the task to stop",
    );
    await L.noRunningSession(120000);
    await sleep(2000);
    const calls = R.modelCalls(N).length;
    log("model calls so far (no new call expected for this task)", calls);
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "c4-04-inbox");
    log("inbox has could-not-run card:", /"Draw a logo for the quote page" could not run/.test(inbox));
    log("inbox has cc:", /cc:/.test(inbox));
    const card = page.getByTestId("request").filter({ hasText: "Draw a logo for the quote page" });
    log("cards for the task in Inbox:", await card.count());
    if (await card.count()) log("card text:", (await card.first().innerText()).slice(0, 1500));
    await page.goto(`${ui()}/`);
    await sleep(2500);
    const home = await R.step(page, "c4-05-home");
    log("home waiting on you:", (home.match(/Waiting on you[^\n]*\n?[^\n]*/) || [""])[0]);
    await page.goto(`${ui()}/projects/${PID}`);
    await sleep(2500);
    const ov = await R.step(page, "c4-06-overview");
    log("overview last result:", (ov.match(/Last result[\s\S]{0,300}/) || [""])[0].replace(/\n/g, " | "));
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2500);
    await R.step(page, "c4-07-tasks");
    const row = L.rowOf(page, "Draw a logo for the quote page");
    const rowText = await row.innerText();
    log("row:", rowText.replace(/\n/g, " | "));
    log("row buttons:", (await row.getByRole("button").allInnerTexts()).join(" / "));
    // Try again from the Inbox without changing anything.
    await page.goto(`${ui()}/inbox`);
    await sleep(2000);
    const c1 = page.getByTestId("request").filter({ hasText: "Draw a logo for the quote page" }).first();
    await c1.getByRole("button", { name: "Try again" }).click();
    await sleep(1200);
    const yes = page.getByTestId("choice-confirm-yes");
    if (await yes.count()) await yes.first().click();
    await sleep(2500);
    const after = await R.step(page, "c4-08-after-try-again");
    log("done line after Try again:", (after.match(/[^\n]*(Try again|session)[^\n]*/g) || []).slice(0, 5).join(" || "));
    await R.until(
      async () => {
        const t = (await L.tasksOf(PID)).find((x) => x.id === tid);
        return t && t.status === "needs_human" && t.version > 0 ? t : null;
      },
      120000,
      1000,
      "the task to stop again",
    );
    await L.noRunningSession(120000);
    await sleep(3000);
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox2 = await R.step(page, "c4-09-inbox-after-retry");
    const open = (await R.api(N, "GET", "/inbox")).requests.filter((r) => r.taskId === tid && r.status === "open");
    log("open cards for the task after Try again:", open.length, open.map((r) => r.title).join(" | "));
    log("visible cards for the task:", await page.getByTestId("request").filter({ hasText: "Draw a logo for the quote page" }).count());
    // Cancel task from the card.
    const c2 = page.getByTestId("request").filter({ hasText: "Draw a logo for the quote page" }).first();
    await c2.getByRole("button", { name: "Cancel task" }).click();
    await sleep(1200);
    if (await page.getByTestId("choice-confirm-yes").count()) await page.getByTestId("choice-confirm-yes").first().click();
    await sleep(2500);
    await R.step(page, "c4-10-after-cancel");
    const t = (await L.tasksOf(PID)).find((x) => x.id === tid);
    log("task after Cancel task:", t.status, JSON.stringify(t.display));
    await page.goto(`${ui()}/projects/${PID}/tasks`);
    await sleep(2500);
    await R.step(page, "c4-11-tasks-after-cancel");
    log("model calls at end:", R.modelCalls(N).length);
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "c4-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
