// Fix-up walk for l4-money-pause on the bench "fixup-l4-money-pause" (stand-in model).
// Usage: node fixup-money-walk.cjs <label> [b|d|f|all]
const R = require("/home/user/Forerunner/.claude/worktrees/wf_e1575ce2-d2f-3/scripts/bench/recorder.cjs");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const N = "fixup-l4-money-pause";
const label = process.argv[2] ?? "after";
const which = process.argv[3] ?? "all";
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const DB = `${bench.home}/data/state.sqlite`;
const OUT = `/tmp/frbench/${N}/walk-${label}.json`;
const out = { journeys: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

function setEst(taskId, usd) {
  const db = new DatabaseSync(DB);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("update task set est_cost_usd_micro = ? where id = ?").run(Math.round(usd * 1e6), taskId);
  db.close();
}
async function project(name, goal, budgetUsdMicro) {
  return R.api(N, "POST", "/projects", { name, goal, ...(budgetUsdMicro ? { budgetUsdMicro } : {}) });
}
async function task(projectId, title, { priority = "medium", budgetUsdMicro = 0, est } = {}) {
  const t = await R.api(N, "POST", `/projects/${projectId}/tasks`, {
    title, outcome: `${title} is done`, acceptanceCriteria: [], priority, status: "ready",
    dependsOn: [], budgetUsdMicro, specialist: "coder", riskTier: 1,
  });
  const id = t.task?.id ?? t.id ?? t.taskId;
  if (est !== undefined) setEst(id, est);
  return id;
}
async function startViaUi(page, projectId, chf, l) {
  await page.goto(page.url().replace(/(\/\/[^/]+).*/, `$1/projects/${projectId}/tasks`));
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Start/ }).first().click();
  await page.getByTestId("start-session-dialog").waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator('input[name="budget"]').fill(chf);
  await page.waitForTimeout(800);
  await R.step(page, `${label}-${l}-start-dialog`);
  await page.getByTestId("confirm-start-session").click();
  const rows = await R.until(async () => {
    const v = await R.api(N, "GET", `/projects/${projectId}/sessions`);
    return v.rows && v.rows.length ? v.rows : null;
  }, 60000, 1000, "a session row");
  const id = rows[0].id ?? rows[0].sessionId;
  await R.waitForSession(N, id, 300000);
  await page.waitForTimeout(2500);
  return id;
}
async function sessionScreens(page, projectId, sessionId, l) {
  const base = page.url().replace(/(\/\/[^/]+).*/, "$1");
  await page.goto(`${base}/sessions/${sessionId}`);
  await page.waitForTimeout(2500);
  const ended = await R.step(page, `${label}-${l}-session-page`);
  const details = page.getByRole("button", { name: /Details/ }).first();
  if (await details.count()) {
    await details.click();
    await page.waitForTimeout(1200);
  }
  const det = await R.step(page, `${label}-${l}-session-details`, { fullPage: true });
  const ev = await R.api(N, "GET", `/sessions/${sessionId}/events`);
  return {
    lines: (Array.isArray(ev) ? ev : ev.events ?? []).map((e) => e.text).filter(Boolean),
    screens: { ended, det },
  };
}

(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await page.waitForTimeout(2000);
    await R.skipSetup(page).catch(() => undefined);
    await page.waitForTimeout(1000);
    if (which === "all" || which === "b") {
      // B3 (L4-money-103): a project budget with the review's room kept: the start line whole.
      const p = await project("Club", "A club page", 75000);
      const t = await task(p.id, "Write the club history", { est: 0.05 });
      const sid = await startViaUi(page, p.id, "5.00", "b");
      out.journeys.b = { projectId: p.id, t, ...(await sessionScreens(page, p.id, sid, "b")) };
      save();
    }
    if (which === "all" || which === "b2") {
      // B3 (L4-money-103): the review's room kept inside the project's budget (USD 0.30).
      const p = await project("Club room", "A club page", 300000);
      const t = await task(p.id, "Write the club history", { est: 0.05 });
      const sid = await startViaUi(page, p.id, "5.00", "b2");
      out.journeys.b2 = { projectId: p.id, t, ...(await sessionScreens(page, p.id, sid, "b2")) };
      save();
    }
    if (which === "all" || which === "d") {
      // B4 (L4-money-112): sent back once, accepted far over its estimate.
      const p = await project("Swiss pairing", "A pairing list");
      const t = await task(p.id, "Write the pairing list", { est: 0.02 });
      const sid = await startViaUi(page, p.id, "5.00", "d");
      out.journeys.d = { projectId: p.id, t, ...(await sessionScreens(page, p.id, sid, "d")) };
      save();
    }
    if (which === "all" || which === "f") {
      // B2 (L4-github-110): a new project with a brief, Approve and start in the Inbox.
      const brief = "A page that shows a random quote";
      const p = await R.api(N, "POST", "/projects", { name: `Quote page ${label}`, goal: brief, brief, intake: true });
      const card = await R.until(async () => {
        const v = await R.api(N, "GET", "/inbox");
        return (v.requests ?? []).find((r) => r.projectId === p.id && r.status === "open" && /^Plan for/.test(r.title ?? ""));
      }, 120000, 1000, "the plan card");
      const base = page.url().replace(/(\/\/[^/]+).*/, "$1");
      await page.goto(`${base}/inbox`);
      await page.waitForTimeout(2500);
      await R.step(page, `${label}-f-plan-card`);
      const before = new Set(((await R.api(N, "GET", `/projects/${p.id}/sessions`)).rows ?? []).map((r) => r.id ?? r.sessionId));
      const btn = page.getByRole("button", { name: "Approve and start" }).first();
      await btn.click();
      const row = await R.until(async () => {
        const v = await R.api(N, "GET", `/projects/${p.id}/sessions`);
        return (v.rows ?? []).find((r) => !before.has(r.id ?? r.sessionId));
      }, 60000, 1000, "the work session's row");
      const sid = row.id ?? row.sessionId;
      await R.waitForSession(N, sid, 300000);
      await page.waitForTimeout(2500);
      out.journeys.f = { projectId: p.id, card: card.title, ...(await sessionScreens(page, p.id, sid, "f")) };
      save();
    }
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    save();
  } finally {
    save();
    await browser.close();
  }
})();
