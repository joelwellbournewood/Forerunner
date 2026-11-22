// Shared helpers for the livec-a walks (phase C live checks: verification + continuity).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_09470d59-af0-1/scripts/bench/recorder.cjs");
const N = process.env.LC_BENCH || "livec-a";
const STEPS = `/tmp/frbench/${N}/steps`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ui = () => R.bench(N).uiUrl;

function logTo(file) {
  const out = [];
  const log = (...a) => {
    const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    console.log(s);
    out.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
    fs.writeFileSync(path.join(STEPS, file), `${out.join("\n")}\n`);
  };
  return log;
}

async function tasksOf(pid) {
  return R.api(N, "GET", `/projects/${encodeURIComponent(pid)}/tasks`);
}
async function taskBy(pid, re) {
  return (await tasksOf(pid)).find((t) => re.test(t.title));
}
async function sessionsOf(pid) {
  const s = await R.api(N, "GET", `/sessions?projectId=${encodeURIComponent(pid)}`);
  return (Array.isArray(s) ? s : []).filter((x) => x.projectId === pid);
}
async function noRunningSession(ms = 1_200_000) {
  return R.until(
    async () => {
      const s = await R.api(N, "GET", "/sessions?status=running").catch(() => null);
      return Array.isArray(s) && s.length === 0 ? true : null;
    },
    ms,
    3000,
    "no running session",
  );
}

/** New project through the dialog: name + goal (no brief = no intake) or a brief. */
async function newProject(page, { name, goal, brief }) {
  await page.goto(`${ui()}/`);
  await sleep(1500);
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await sleep(500);
  await page.getByLabel("Name").fill(name);
  if (goal) await page.getByLabel(/^Goal/).fill(goal);
  if (brief) await page.getByLabel(/^Brief/).fill(brief);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 20_000 });
  return decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
}

/** New task through the Tasks tab dialog. who: a specialist name ("coder"), level: label regex. */
async function newTask(page, pid, { title, outcome, criteria, level, who, budget, priority }) {
  await page.goto(`${ui()}/projects/${encodeURIComponent(pid)}/tasks`);
  await sleep(2000);
  await page.getByRole("button", { name: "New task" }).first().click();
  const dlg = page.getByTestId("new-task-dialog");
  await dlg.getByTestId("task-title").fill(title);
  await dlg.getByTestId("task-outcome").fill(outcome);
  if (criteria) await dlg.getByTestId("task-criteria").fill(criteria);
  await R.until(
    async () => (await dlg.getByTestId("task-who").locator("option").count()) > 2,
    15000,
    300,
    "the specialists list",
  );
  if (level) {
    const opts = await dlg.getByTestId("task-risk-tier").locator("option").allInnerTexts();
    const pick = opts.find((o) => level.test(o));
    if (pick) await dlg.getByTestId("task-risk-tier").selectOption({ label: pick });
  }
  if (who) await dlg.getByTestId("task-who").selectOption(who);
  if (budget) await dlg.getByTestId("task-budget").fill(budget);
  if (priority) await dlg.getByTestId("task-priority").selectOption(priority);
  return dlg;
}
async function submitTask(page) {
  await page.getByTestId("new-task-dialog").getByTestId("create-task").click();
  await sleep(1500);
}

/** Start session dialog from the project page; budget in CHF (string) or the default. */
async function openStart(page, pid, budget) {
  await page.goto(`${ui()}/projects/${encodeURIComponent(pid)}`);
  await sleep(2000);
  await page.getByRole("button", { name: /^Start session$/ }).first().click();
  await sleep(1500);
  const dlg = page.getByTestId("start-session-dialog");
  if (budget !== undefined) {
    await dlg.locator('input[name="budget"]').fill(budget);
    await sleep(1500);
  }
  return dlg;
}
async function confirmStart(page) {
  const dlg = page.getByTestId("start-session-dialog");
  await dlg.getByTestId("confirm-start-session").click();
  await sleep(2000);
  return dlg;
}

function rowOf(page, title) {
  return page.getByTestId("task-row").filter({ hasText: title });
}

async function openDrawer(page, pid, title) {
  await page.goto(`${ui()}/projects/${encodeURIComponent(pid)}/tasks`);
  await sleep(2000);
  await rowOf(page, title).getByTestId("task-title").first().click();
  await sleep(2000);
}
async function seeWhatWasChecked(page) {
  const ev = page.getByText("See what was checked");
  if (await ev.count()) {
    await ev.first().click();
    await sleep(2500);
    return true;
  }
  return false;
}

/** USD so far on this bench. */
function spent() {
  return R.callSummary(R.modelCalls(N)).usd;
}

/** Index (1-based line numbers) of model-call log lines matching a predicate. */
function callLines(pred) {
  const file = R.bench(N).modelCallLog;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l)
    .map(([n, l]) => ({ n, ...JSON.parse(l) }))
    .filter(pred);
}

/** Wait until no session runs; press Stop now on the running session if the spend passes `limit`. */
async function watchdog(page, limit, log, ms = 1800000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const running = await R.api(N, "GET", "/sessions?status=running").catch(() => null);
    if (Array.isArray(running) && running.length === 0) {
      await sleep(6000);
      const again = await R.api(N, "GET", "/sessions?status=running").catch(() => null);
      if (Array.isArray(again) && again.length === 0) return true;
    }
    if (Array.isArray(running) && running.length && spent() >= limit) {
      log(`spend ${spent().toFixed(3)} reached the walk's limit ${limit}: Stop now`);
      await page.goto(`${ui()}/sessions/${running[0].id}`);
      await sleep(2000);
      await page.getByTestId("stop-now").click().catch(() => {});
      await sleep(300);
      await page.getByTestId("stop-session").click().catch(() => {});
      await sleep(3000);
    }
    await sleep(2000);
  }
  return false;
}

module.exports = {
  watchdog,
  R,
  N,
  STEPS,
  sleep,
  ui,
  logTo,
  tasksOf,
  taskBy,
  sessionsOf,
  noRunningSession,
  newProject,
  newTask,
  submitTask,
  openStart,
  confirmStart,
  rowOf,
  openDrawer,
  seeWhatWasChecked,
  spent,
  callLines,
};
