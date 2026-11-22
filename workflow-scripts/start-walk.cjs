// Start-dialog walk: a project with three tasks made in New task, then Start session at CHF 0.50.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_dbd51cc4-c3a-7/scripts/bench/recorder.cjs");
const N = "review-cost";

(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await page.waitForTimeout(1500);
    const t0 = await page.evaluate(() => document.body.innerText);
    if (/Set up later/.test(t0)) await R.skipSetup(page);
    // A project made through New project; its plan is rejected in the Inbox so only the person's tasks exist.
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByLabel("Name").fill("Notes site review");
    await page.getByLabel(/^Brief/).fill("A small notes site");
    await R.step(page, "new project dialog");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
    const projectUrl = page.url();
    const pid = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(projectUrl)[1]);
    const p = { id: pid };
    await R.until(async () => {
      const st = await R.api(N, "GET", `/projects/${encodeURIComponent(pid)}/intake`);
      return st.state === "pending" || st.state === "failed" ? st : null;
    }, 300_000, 2000, "plan");
    await page.getByRole("link", { name: /^Inbox/ }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "inbox with the plan card");
    await page.getByRole("button", { name: "Reject", exact: true }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "plan rejected");
    await page.goto(projectUrl);
    await page.waitForTimeout(1500);
    // Open the project's Tasks tab.
    await page.getByRole("tab", { name: "Tasks" }).or(page.getByRole("link", { name: "Tasks" })).first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
    await R.step(page, "tasks tab empty");
    const titles = ["Write the home page", "Write the about page", "Write the contact page"];
    for (const [i, title] of titles.entries()) {
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.getByTestId("new-task-dialog").getByTestId("task-title").fill(title);
      await page.getByTestId("new-task-dialog").getByTestId("task-outcome").fill(`${title} in plain HTML`);
      if (i < 2) await page.getByTestId("new-task-dialog").getByTestId("task-who").selectOption("coder");
      if (i === 0) await R.step(page, "new task dialog filled");
      await page.getByTestId("new-task-dialog").getByRole("button", { name: /^(Create|Add|Save)/ }).first().click();
      await page.waitForTimeout(1200);
    }
    await R.step(page, "tasks made by a person");
    const tasks = await R.api(N, "GET", `/projects/${encodeURIComponent(p.id)}/tasks`);
    console.log("tasks", JSON.stringify(tasks.map((t) => [t.title, t.specialist, t.estCostUsdMicro ?? t.est_cost_usd_micro, t.status])));
    await page.getByRole("button", { name: "Start session", exact: true }).first().click();
    await page.waitForTimeout(1000);
    const budget = page.getByLabel(/Session budget/);
    await budget.fill("0.50");
    await page.waitForTimeout(2000);
    const text = await R.step(page, "start dialog at chf 0-50");
    const m = text.match(/This session[^\n]*|Nothing can run[^\n]*/);
    console.log("START LINE:", m ? m[0] : "(none)");
    const check = await R.api(N, "GET", `/projects/${encodeURIComponent(p.id)}/start-check?budgetUsdMicro=610000`).catch((e) => e.message);
    console.log("start-check", JSON.stringify(check).slice(0, 1500));
    // Start, then wait for the session.
    await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(2000);
    await R.step(page, "session started");
    const sessions = await R.api(N, "GET", `/sessions?projectId=${encodeURIComponent(p.id)}`);
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.projectId === p.id);
    if (s) {
      const done = await R.waitForSession(N, s.id, 900_000);
      console.log("session", done.status);
    }
    await page.waitForTimeout(1500);
    await R.step(page, "tasks after the session");
    const after = await R.api(N, "GET", `/projects/${encodeURIComponent(p.id)}/tasks`);
    console.log("after", JSON.stringify(after.map((t) => [t.title, t.status, t.actualCostUsdMicro ?? t.cost_usd_micro ?? t.costUsdMicro])));
    const est = await R.api(N, "GET", "/costs/estimates");
    console.log("estimates", JSON.stringify(est).slice(0, 2000));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
