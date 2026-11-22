// Verification walks on one project ("Club tools", no brief), one session:
//  - walk D (fixup blocking 1): index.html (planted) throws; 'Style the page in styles.css' is
//    not sent back for it and the drawer says the error was not caused by this task.
//  - V2: 'Members chart' by the data-analyst without data/members.csv; Go ahead without on the
//    first card; expected: not Done, a card asking for data/members.csv, Needs you.
//  - V6: 'Deploy the site' by ops-deploy, Light review chosen; Edit offers no Light review; after
//    the critic accepts: '... needs your sign-off', not Done until Accept the work.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("verif-log.txt");
const STYLE = "Style the page in styles.css";
const CHART = "Members chart";
const DEPLOY = "Deploy the site";
const exactRow = (page, title) =>
  page.getByTestId("task-row").filter({ has: page.getByTestId("task-title").getByText(title, { exact: true }) });

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession(2400000);
    const pid = await L.newProject(page, { name: "Club tools", goal: "The garden club's page, its members chart and its deploy" });
    fs.writeFileSync(`${L.STEPS}/verif-pid.txt`, pid);
    const ws = R.workspaceOf(N, pid);
    await R.until(() => fs.existsSync(ws), 30000, 500, "the project folder");
    fs.writeFileSync(
      path.join(ws, "index.html"),
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Club</title><link rel="stylesheet" href="styles.css"></head>\n<body><h1>Garden club</h1><p id="intro">We meet on Saturdays.</p>\n<script>document.getElementById("quote").textContent = "x";</script>\n</body></html>\n',
    );
    log("planted index.html whose inline script throws (no #quote element)");
    await L.newTask(page, pid, { title: STYLE, outcome: "styles.css gives the page a green heading", criteria: "The heading is green", who: "coder", priority: "high" });
    await L.submitTask(page);
    await L.newTask(page, pid, {
      title: CHART,
      outcome: "charts/members.svg: a bar chart of members per year from data/members.csv",
      criteria: "Every bar uses the exact number from data/members.csv\nNo number is invented",
      who: "data-analyst",
      priority: "medium",
    });
    await L.submitTask(page);
    const dd = await L.newTask(page, pid, {
      title: DEPLOY,
      outcome: "The site is packaged for deploy (a Dockerfile that serves index.html) with a runbook in docs/deploy.md",
      criteria: "docs/deploy.md says how to roll back",
      who: "ops-deploy",
      level: /^Light review/,
      priority: "low",
    });
    log("New task levels offered:", (await dd.getByTestId("task-risk-tier").locator("option").allInnerTexts()).join(" | "));
    log("New task chosen level:", await dd.getByTestId("task-risk-tier").inputValue(), "| notes:", (await dd.locator('[data-testid="task-docker-note"], [data-testid="task-who-note"]').allInnerTexts()).join(" | "));
    await R.step(page, "verif-01-deploy-new-task");
    await L.submitTask(page);
    for (const t of await L.tasksOf(pid)) log("task:", t.title, t.specialist, "tier", t.riskTier, t.status, JSON.stringify(t.display.label));
    // Edit on the deploy.
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2000);
    await R.step(page, "verif-02-tasks-ready");
    await exactRow(page, DEPLOY).getByTestId("task-title").click();
    await sleep(1500);
    await page.getByTestId("drawer-action-edit").first().click().catch(async () => page.getByRole("button", { name: "Edit" }).first().click());
    await sleep(800);
    const opts = await page.getByTestId("edit-risk-tier").locator("option").allInnerTexts();
    log("Edit on the deploy offers:", opts.join(" | "), "| selected:", await page.getByTestId("edit-risk-tier").inputValue());
    log("Edit note:", (await page.getByTestId("edit-full-review-note").allInnerTexts().catch(() => [])).join(" | "));
    await R.step(page, "verif-03-edit-deploy");
    await page.keyboard.press("Escape");
    await sleep(500);
    await page.keyboard.press("Escape");
    // Start session.
    const sd = await L.openStart(page, pid);
    log("start dialog:", (await sd.innerText()).replace(/\n/g, " | ").slice(0, 900));
    await R.step(page, "verif-04-start-dialog");
    if (!(await sd.getByTestId("confirm-start-session").isEnabled())) throw new Error("Start is disabled");
    await L.confirmStart(page);
    await sleep(4000);
    // While sessions run: answer the Members chart's first card with Go ahead without.
    let answered = false;
    const end = Date.now() + 1800000;
    while (Date.now() < end) {
      const inbox = await R.api(N, "GET", "/inbox");
      const tasks = await L.tasksOf(pid);
      const chart = tasks.find((t) => t.title === CHART);
      const card = inbox.requests.find((r) => r.status === "open" && r.taskId === chart.id);
      if (card && !answered && (card.choices ?? []).some((c) => c.label === "Go ahead without")) {
        await page.goto(`${ui()}/inbox`);
        await sleep(2000);
        const c = page.getByTestId("request").filter({ hasText: CHART }).first();
        log("first Members chart card:", (await c.innerText()).replace(/\n/g, " | ").slice(0, 1500));
        await R.step(page, "verif-05-chart-first-card");
        await c.getByRole("button", { name: "Go ahead without" }).click();
        await sleep(800);
        if (await page.getByTestId("choice-confirm-yes").count()) await page.getByTestId("choice-confirm-yes").first().click();
        await sleep(2500);
        await R.step(page, "verif-06-go-ahead-without");
        log("done lines:", (await page.getByTestId("done-line").allInnerTexts().catch(() => [])).join(" || "));
        answered = true;
      }
      const running = await R.api(N, "GET", "/sessions?status=running").catch(() => []);
      const limit = Number(process.env.SPEND_LIMIT || 1.45);
      if (running.length && L.spent() >= limit) {
        log(`spend ${L.spent().toFixed(3)} reached the walk's limit ${limit}: Stop now`);
        await page.goto(`${ui()}/sessions/${running[0].id}`);
        await sleep(2000);
        await page.getByTestId("stop-now").click().catch(() => {});
        await sleep(300);
        await page.getByTestId("stop-session").click().catch(() => {});
        await sleep(3000);
        answered = true;
        continue;
      }
      if (!running.length) {
        await sleep(8000);
        const again = await R.api(N, "GET", "/sessions?status=running").catch(() => []);
        const cardNow = (await R.api(N, "GET", "/inbox")).requests.find((r) => r.status === "open" && r.taskId === chart.id);
        const wantsGo = cardNow && !answered && (cardNow.choices ?? []).some((c) => c.label === "Go ahead without");
        if (!again.length && !wantsGo) break;
      }
      await sleep(3000);
    }
    log("answered the chart's first card:", answered);
    for (const t of await L.tasksOf(pid)) log("task at end:", t.title, t.status, JSON.stringify(t.display.label), JSON.stringify(t.check ?? null), "attempt", t.attempt);
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "verif-07-tasks-after");
    for (const title of [STYLE, CHART, DEPLOY]) {
      const row = exactRow(page, title);
      log(`row ${title}:`, (await row.innerText()).replace(/\n/g, " | "));
    }
    for (const title of [STYLE, CHART, DEPLOY]) {
      await page.goto(`${ui()}/projects/${pid}/tasks`);
      await sleep(1800);
      await exactRow(page, title).getByTestId("task-title").click();
      await sleep(2000);
      await L.seeWhatWasChecked(page);
      const d = await R.step(page, `verif-08-drawer-${title.slice(0, 6)}`);
      const ri = d.indexOf("Review\n");
      log(`drawer ${title} review:`, ri >= 0 ? d.slice(ri, ri + 2500).replace(/\n/g, " | ") : d.slice(d.indexOf("Runs"), d.indexOf("Runs") + 1500).replace(/\n/g, " | "));
      await page.keyboard.press("Escape");
    }
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "verif-09-inbox");
    log("inbox head:", inbox.slice(inbox.indexOf("Needs you"), inbox.indexOf("Needs you") + 2500).replace(/\n/g, " | "));
    log("Inbox nav label:", (inbox.match(/Inbox\d*/) || [""])[0]);
    // Deploy: Accept the work if its sign-off card is there.
    const dep = page.getByTestId("request").filter({ hasText: DEPLOY }).first();
    if ((await dep.count()) && (await dep.getByRole("button", { name: "Accept the work" }).count())) {
      const depTask = await L.taskBy(pid, /^Deploy the site/);
      log("deploy before Accept:", depTask.status, JSON.stringify(depTask.display.label));
      await dep.getByRole("button", { name: "Accept the work" }).click();
      await sleep(800);
      if (await page.getByTestId("choice-confirm-yes").count()) await page.getByTestId("choice-confirm-yes").first().click();
      await sleep(2500);
      await R.step(page, "verif-10-deploy-accepted");
      const after = await L.taskBy(pid, /^Deploy the site/);
      log("deploy after Accept:", after.status, JSON.stringify(after.display.label), JSON.stringify(after.check ?? null));
    }
    const chartT = await L.taskBy(pid, /^Members chart/);
    log("charts/members.svg exists:", fs.existsSync(path.join(ws, "charts", "members.svg")));
    const sc = L.callLines((c) => c.role === "specialist" && c.task === chartT.id);
    const last = sc[sc.length - 1];
    if (last) log("last chart specialist reply:", String(last.reply?.text ?? "").slice(-900).replace(/\n/g, " | "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "verif-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
