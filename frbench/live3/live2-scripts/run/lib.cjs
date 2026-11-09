process.env.FRBENCH_ROOT = process.env.FRBENCH_ROOT || "/tmp/frbench/live2/run";
const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const path = require("node:path");
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
async function goto(page, name, route, waitMs = 2000) {
  const b = R.bench(name);
  await page.goto(`${b.uiUrl}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  if (waitMs) await page.waitForTimeout(waitMs);
}
async function text(page) { return page.evaluate(() => document.body.innerText); }
function save(name, file, obj) {
  const b = R.bench(name);
  const p = path.join(b.steps, file);
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return p;
}
async function newProject(page, name, { project, goal = "", brief = "" }) {
  await goto(page, name, "/");
  await page.getByRole("button", { name: "New project" }).first().click();
  const dlg = page.getByTestId("new-project-dialog");
  await dlg.locator('input[name="name"]').fill(project);
  if (goal) await dlg.locator('input[name="goal"]').fill(goal);
  if (brief) await dlg.locator('textarea[name="brief"]').fill(brief);
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\//, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const id = decodeURIComponent(page.url().split("/projects/")[1].split(/[/?#]/)[0]);
  return id;
}
async function newTask(page, name, projectId, { title, outcome, criteria = [], who, budget, tier, waitsFor = [] , shotLabel}) {
  await goto(page, name, `/projects/${enc(projectId)}/tasks`);
  await page.getByTestId("new-task").click();
  const d = page.getByTestId("new-task-dialog");
  await d.getByTestId("task-title").fill(title);
  await d.getByTestId("task-outcome").fill(outcome);
  if (criteria.length) await d.getByTestId("task-criteria").fill(criteria.join("\n"));
  if (who) await d.getByTestId("task-who").selectOption(who);
  if (tier !== undefined) await d.getByTestId("task-risk-tier").selectOption(String(tier));
  if (budget) await d.getByTestId("task-budget").fill(String(budget));
  for (const w of waitsFor) {
    const cb = d.getByRole("checkbox", { name: w });
    if (await cb.count()) await cb.first().check();
    else log("no checkbox for", w);
  }
  await page.waitForTimeout(1500);
  let note = null;
  const n = d.getByTestId("task-who-note");
  if (await n.count()) note = await n.first().innerText();
  let shot = null;
  if (shotLabel) shot = await R.step(page, shotLabel);
  await d.getByTestId("create-task").click();
  await page.waitForTimeout(1500);
  return { note, shot };
}
async function tasks(name, projectId) { return R.api(name, "GET", `/projects/${enc(projectId)}/tasks`); }
module.exports = { R, fs, path, enc, sleep, log, goto, text, save, newProject, newTask, tasks };
async function say(page, name, projectId, line, label, waitMs = 120000) {
  await goto(page, name, `/projects/${enc(projectId)}/chat`, 1500);
  const replies = page.getByTestId("chat-agent");
  const before = await replies.count();
  const box = page.getByTestId("chat-input");
  await box.fill(line);
  await box.press("Enter");
  const reply = await R.until(async () => {
    if ((await replies.count()) <= before) return null;
    const last = replies.last();
    if ((await last.getAttribute("data-streaming")) === "true") return null;
    const t = (await last.innerText()).trim();
    return t && !/^Thinking…$/.test(t) ? t : null;
  }, waitMs, 1000, "a chat reply").catch(() => null);
  await page.waitForTimeout(1500);
  const shot = label ? await R.step(page, label) : null;
  const pending = page.getByTestId("pending-confirmation");
  const readback = (await pending.count()) ? await pending.last().innerText() : null;
  return { reply, readback, shot };
}
async function answerReadback(page, yes = true) {
  const btn = page.getByTestId(yes ? "confirm-yes" : "confirm-no").last();
  await btn.click();
  await page.waitForTimeout(4000);
}
module.exports.say = say;
module.exports.answerReadback = answerReadback;
async function setProjectSetting(page, name, projectName, key, value, label) {
  await goto(page, name, "/settings#other-settings", 3000);
  const adv = page.getByTestId("settings-advanced-summary");
  const os = page.locator("#other-settings");
  if (!(await os.isVisible().catch(() => false)) && (await adv.count())) { await adv.first().click(); await page.waitForTimeout(1000); }
  const rows = page.locator(`[data-testid="setting-row"][data-key="${key}"]`).filter({ hasText: projectName });
  const row = rows.first();
  await row.scrollIntoViewIfNeeded();
  const before = await row.innerText();
  await row.getByTestId("setting-change").click();
  await page.waitForTimeout(1200);
  const v = page.getByTestId("setting-value").first();
  await v.fill(String(value));
  await page.waitForTimeout(500);
  const dlg1 = label ? await R.step(page, `${label} dialog`) : null;
  await page.getByTestId("setting-apply").first().click();
  await page.waitForTimeout(2500);
  let dlg2 = await page.evaluate(() => document.body.innerText);
  const yes = page.getByRole("button", { name: /^(Yes|Confirm|Apply it|Apply)$/ });
  if (await yes.count()) { try { await yes.last().click(); await page.waitForTimeout(2500); } catch {} }
  const after = label ? await R.step(page, `${label} applied`) : null;
  return { before, dlg1, after };
}
module.exports.setProjectSetting = setProjectSetting;
