// Review walk for d1116-budget-all: tasks made in New task (the hint), Start dialog figure vs the
// start check, a session through the UI, the row/drawer/Costs figures, the footer's paused review,
// a daemon restart between the pause and Continue, Continue pressed in the Inbox.
// Usage: node review-ba-walk.cjs <bench> <label> <footerChf>
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_8c78dba2-180-2";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);

const [n, label, footerChfArg] = process.argv.slice(2);
const footerChf = footerChfArg ?? "0.07";
const out = { label };

async function rows(pid) {
  const tasks = await R.api(n, "GET", `/projects/${pid}/tasks`);
  return (tasks.tasks ?? tasks).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    budget: t.budget,
    actual: t.actual,
    spent: t.spent,
    cap: t.cap,
    capSource: t.capSource,
    estimate: t.estimate,
  }));
}
async function cards(pid) {
  const inbox = await R.api(n, "GET", "/inbox");
  return (inbox.requests ?? [])
    .filter((r) => r.projectId === pid)
    .map((r) => ({
      id: r.id,
      status: r.status,
      title: r.title,
      body: r.body,
      choices: (r.choices ?? []).map((c) => c.label),
      card: r.changeCard ?? null,
    }));
}
async function lines(sid) {
  const ev = await R.api(n, "GET", `/sessions/${sid}/events`);
  return ev.map((e) => e.text ?? "").filter(Boolean);
}

async function newTask(page, { title, outcome, criteria, budget }) {
  await page.getByRole("button", { name: "New task", exact: true }).first().click();
  const dlg = page.getByTestId("new-task-dialog");
  await dlg.waitFor({ state: "visible" });
  await dlg.getByTestId("task-title").fill(title);
  await dlg.getByTestId("task-outcome").fill(outcome);
  await dlg.getByTestId("task-criteria").fill(criteria);
  await dlg.getByTestId("task-who").selectOption("coder");
  await dlg.getByTestId("task-risk-tier").selectOption("1");
  if (budget) await dlg.getByTestId("task-budget").fill(budget);
  return dlg;
}

(async () => {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  const b = () => JSON.parse(fs.readFileSync(path.join("/tmp/frbench", n, "bench.json"), "utf8"));
  try {
    await R.skipSetup(page);
    const project = await R.api(n, "POST", "/projects", {
      name: `Chess club ${label}`,
      goal: "A chess club site",
    });
    const pid = project.id;
    out.project = pid;
    await page.goto(`${b().uiUrl}/projects/${pid}/tasks`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await newTask(page, {
      title: "Write the Swiss pairing tool in swiss.html",
      outcome: "swiss.html pairs players by the Swiss system",
      criteria: "swiss.html exists",
      budget: "2.00",
    });
    out.newTaskDialog = await R.step(page, `${label}-01-new-task-dialog`);
    await page.getByTestId("new-task-dialog").getByTestId("create-task").click();
    await page.getByTestId("new-task-dialog").waitFor({ state: "hidden" });
    await newTask(page, {
      title: "Add a footer line with the club's name to index.html",
      outcome: "index.html has a footer with the club's name",
      criteria: "index.html exists",
      budget: footerChf,
    });
    await page.getByTestId("new-task-dialog").getByTestId("create-task").click();
    await page.getByTestId("new-task-dialog").waitFor({ state: "hidden" });
    await newTask(page, {
      title: "Write the rules page in rules.html",
      outcome: "rules.html lists the club rules",
      criteria: "rules.html exists",
      budget: "",
    });
    await page.getByTestId("new-task-dialog").getByTestId("create-task").click();
    await page.getByTestId("new-task-dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(800);
    out.tasksBefore = await R.step(page, `${label}-02-tasks-before`);
    out.rows0 = await rows(pid);
    out.startCheck = await R.api(n, "GET", `/projects/${pid}/start-check`);
    // Start dialog through the UI.
    await page.getByTestId("start-session").first().click();
    const start = page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).first();
    await R.until(async () => (await start.isEnabled().catch(() => false)) || null, 20_000, 500, "Start enabled");
    out.startDialog = await R.step(page, `${label}-03-start-dialog`);
    await start.click();
    const open = page.getByTestId("start-session-open");
    await open.waitFor({ state: "visible", timeout: 30_000 });
    await open.click();
    await page.waitForURL(/\/sessions\/[^/]+/, { timeout: 30_000 });
    const sid = decodeURIComponent(/\/sessions\/([^/?#]+)/.exec(page.url())[1]);
    out.session1 = sid;
    // Poll the task rows during the session: the figure grows while being reviewed, version same.
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 600_000) {
      const s = await R.api(n, "GET", `/sessions/${sid}`);
      const rr = await rows(pid);
      const sw = rr.find((r) => r.title.startsWith("Write the Swiss"));
      samples.push({ at: Date.now() - t0, status: sw?.status, actual: sw?.actual?.usdMicro, spent: sw?.spent?.usdMicro });
      if (["completed", "stopped", "failed", "ended", "done"].includes(s.status ?? s.session?.status) || (s.endedAt ?? s.session?.endedAt)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    out.samples = samples.filter((x, i, a) => i === 0 || JSON.stringify({ ...x, at: 0 }) !== JSON.stringify({ ...a[i - 1], at: 0 }));
    await R.waitForSession(n, sid, 600_000).catch((e) => (out.waitErr = String(e)));
    out.lines1 = await lines(sid);
    out.rows1 = await rows(pid);
    out.cards1 = await cards(pid);
    const costs = await R.api(n, "GET", `/costs?projectId=${pid}`);
    out.costs1 = { totals: costs.totals, byTask: costs.byTask };
    await page.goto(`${b().uiUrl}/projects/${pid}/tasks`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(800);
    out.tasksAfter = await R.step(page, `${label}-04-tasks-after-session`);
    // hover the budget line for its tooltip
    const swissRow = out.rows1.find((r) => r.title.startsWith("Write the Swiss"));
    await page.goto(`${b().uiUrl}/projects/${pid}/tasks?task=${swissRow.id}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    out.drawer = await R.step(page, `${label}-05-drawer-swiss`);
    const footerRow = out.rows1.find((r) => r.title.startsWith("Add a footer"));
    await page.goto(`${b().uiUrl}/projects/${pid}/tasks?task=${footerRow.id}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    out.drawerFooter = await R.step(page, `${label}-06-drawer-footer`);
    await page.goto(`${b().uiUrl}/projects/${pid}/costs`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(800);
    out.costsPage = await R.step(page, `${label}-07-costs`);
    await page.goto(`${b().uiUrl}/sessions/${sid}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const details = page.getByRole("button", { name: /Details/ });
    if (await details.count()) await details.first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
    out.sessionPage = await R.step(page, `${label}-08-session`);
    await page.goto(`${b().uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(800);
    out.inbox1 = await R.step(page, `${label}-09-inbox`);
    // Restart the daemon between the pause and Continue (state must survive).
    execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", n], { stdio: "inherit" });
    await R.reconnect(page, n).catch(() => undefined);
    out.rowsAfterRestart = await rows(pid);
    out.cardsAfterRestart = await cards(pid);
    await page.goto(`${b().uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1200);
    out.inbox2 = await R.step(page, `${label}-10-inbox-after-restart`);
    const openCard = out.cardsAfterRestart.find(
      (c) => c.status === "open" && c.choices.some((x) => /^Continue/.test(x)),
    );
    out.openCard = openCard ?? null;
    if (openCard) {
      const card = page.locator(`[data-request-id="${openCard.id}"]`);
      const btn = card.getByRole("button", { name: /^Continue/ });
      out.continueButtons = await btn.allInnerTexts().catch(() => []);
      await btn.first().click();
      await page.waitForTimeout(800);
      out.afterClick = await R.step(page, `${label}-11-inbox-after-click`);
      const confirm = page.getByRole("dialog").getByRole("button", { name: /^(Continue|Yes|Confirm)/ });
      if (await confirm.count()) {
        await confirm.first().click().catch(() => undefined);
        out.confirmed = true;
      }
      const target = openCard.card?.task_id ?? null;
      await R.until(
        async () => {
          const rr = await rows(pid);
          const t = rr.find((r) => r.title.startsWith("Add a footer"));
          return t && ["done", "failed"].includes(t.status) ? t : null;
        },
        300_000,
        2000,
        "the footer after Continue",
      ).catch((e) => (out.continueErr = String(e.message ?? e)));
      const sessions = await R.api(n, "GET", `/projects/${pid}/sessions`);
      out.sessions = (sessions.rows ?? sessions.sessions ?? sessions).map?.((s) => ({ id: s.id, status: s.status })) ?? sessions;
      const last = (sessions.rows ?? [])[0];
      if (last && last.id !== sid) {
        await R.waitForSession(n, last.id, 300_000).catch(() => undefined);
        out.session2 = last.id;
        out.lines2 = await lines(last.id);
      }
      out.rows2 = await rows(pid);
      out.cards2 = await cards(pid);
      await page.goto(`${b().uiUrl}/projects/${pid}/tasks`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(1000);
      out.tasksAfterContinue = await R.step(page, `${label}-12-tasks-after-continue`);
      await page.goto(`${b().uiUrl}/inbox`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(800);
      out.inbox3 = await R.step(page, `${label}-13-inbox-after-continue`);
      if (out.session2) {
        await page.goto(`${b().uiUrl}/sessions/${out.session2}`);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const d2 = page.getByRole("button", { name: /Details/ });
        if (await d2.count()) await d2.first().click().catch(() => undefined);
        await page.waitForTimeout(1000);
        out.session2Page = await R.step(page, `${label}-14-session2`);
      }
    }
    const costs2 = await R.api(n, "GET", `/costs?projectId=${pid}`);
    out.costs2 = { totals: costs2.totals, byTask: costs2.byTask };
    out.calls = R.modelCalls(n).map((c) => ({ role: c.role, label: c.label, usd: c.usd, model: c.model, max_tokens: c.max_tokens ?? c.maxTokens }));
    out.problems = R.problems(n).slice(-20);
  } catch (e) {
    out.error = String(e.stack ?? e);
    try { await R.step(page, `${label}-error`); } catch {}
  } finally {
    const dir = path.join("/tmp/frbench", n, "steps");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${label}-walk.json`), JSON.stringify(out, null, 2));
    await browser.close();
    console.log("done", out.error ?? "");
  }
})();
