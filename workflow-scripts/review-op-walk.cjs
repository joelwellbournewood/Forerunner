// Reviewer walk for d1109-oversize-pause (independent of the fixer's walk).
// Usage: node review-op-walk.cjs <phase>   phases: a (first session), b (after restart: card, next Start),
//        c (OP-5: run again at the coder's limit), d (Continue on the card), e (no-progress)
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-8/scripts/bench/recorder.cjs");
const { DatabaseSync } = require("node:sqlite");
const N = "review-d1109-oversize-pause";
const ROOT = `/tmp/frbench/${N}`;
const DB = `${ROOT}/home/data/state.sqlite`;
const STATE = `${ROOT}/walk-state.json`;
const phase = process.argv[2];
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const out = { phase, checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${String(detail).slice(0, 400)}` : ""}`);
};
function setEstimate(taskId, usd) {
  const db = new DatabaseSync(DB);
  db.prepare("update task set est_cost_usd_micro = ? where id = ?").run(Math.round(usd * 1e6), taskId);
  db.close();
}
const bench = () => JSON.parse(fs.readFileSync(`${ROOT}/bench.json`, "utf8"));
const sessionsOf = async (pid) =>
  ((await R.api(N, "GET", "/sessions?limit=50")) ?? []).filter((x) => x.projectId === pid);
const ended = (s) => !["planned", "running", "paused"].includes(s.status ?? "");

async function newProject(name) {
  const p = await R.api(N, "POST", "/projects", { name, goal: "A shop page" });
  return p.id;
}
async function task(pid, title, usd, priority) {
  const t = await R.api(N, "POST", `/projects/${pid}/tasks`, {
    title,
    outcome: `${title} is done`,
    acceptanceCriteria: [],
    priority,
    status: "ready",
    dependsOn: [],
    specialist: "coder",
    riskTier: 1,
  });
  setEstimate(t.id, usd);
  return t;
}
async function startFromDialog(page, pid, chf, label) {
  await page.goto(`${bench().uiUrl}/projects/${pid}`);
  await page.getByTestId("start-session").click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor();
  if (chf) await dialog.getByLabel(/Session budget/).fill(chf);
  await page.waitForTimeout(1200);
  const text = await R.step(page, label);
  const before = (await sessionsOf(pid)).map((s) => s.id);
  await dialog.getByTestId("confirm-start-session").click();
  await R.until(async () => (await sessionsOf(pid)).some((s) => !before.includes(s.id)), 60000, 1000, "new session");
  const sid = (await sessionsOf(pid)).find((s) => !before.includes(s.id)).id;
  await R.until(async () => ended(await R.api(N, "GET", `/sessions/${sid}`)), 240000, 1500, "session end");
  return { text, sid };
}
async function inboxText(page, label, openAnswered = false) {
  await page.goto(`${bench().uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  if (openAnswered) {
    await page.getByTestId("answered").locator("summary").click().catch(() => undefined);
    await page.waitForTimeout(600);
  }
  return R.step(page, label, { fullPage: true });
}
async function sessionPage(page, sid, label) {
  await page.goto(`${bench().uiUrl}/sessions/${sid}`);
  await page.waitForTimeout(2000);
  return R.step(page, label, { fullPage: true });
}

async function main() {
  const { browser, page } = await R.openApp(N, { freshProfile: phase === "a" });
  try {
    await R.skipSetup(page).catch(() => undefined);
    if (phase === "a") {
      const pid = await newProject("Shop review");
      st.pid = pid;
      st.intro = (await task(pid, "Write the intro in intro.md", 0.05, "high")).id;
      st.shop = (await task(pid, "Build the shop page in shop.html", 8, "medium")).id;
      st.notes = (await task(pid, "Write the notes in notes.md", 0.05, "low")).id;
      save();
      const ws = R.workspaceOf(N, pid);
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(
        path.join(ws, "package.json"),
        JSON.stringify({ name: "shop", scripts: { test: "node -e \"console.log('shop test failed: token sk-demo');process.exit(1)\"" } }, null, 1),
      );
      const { text, sid } = await startFromDialog(page, pid, "2.00", "a01-start-dialog");
      st.s1 = sid;
      save();
      check("A1 plan sentence: intro first, then the shop with what is left",
        /This session runs "Write the intro in intro\.md" \(about CHF [\d.]+\), then works on "Build the shop page in shop\.html" with what is left\./.test(text), text);
      check("A2 warning: after \"Write the intro...\"",
        /"Build the shop page in shop\.html" needs about CHF [\d.]+, more than this session's work budget of CHF [\d.]+: after "Write the intro in intro\.md" it works with about CHF [\d.]+, keeps its work, and asks you to continue\./.test(text));
      check("A3 note: notes come after it",
        text.includes('"Write the notes in notes.md" comes after it: it runs if "Build the shop page in shop.html" leaves budget, else in your next session.'));
      check("A4 no old words", !/after the other tasks|one task that large|after the work that fits/.test(text));
      const t2 = await sessionPage(page, sid, "a02-session-1");
      check("A5 Took line exactly once", (t2.match(/Took "Build the shop page in shop\.html"/g) ?? []).length === 1, (t2.match(/Took[^\n]*/g) ?? []).join(" | "));
      check("A6 result: notes wait for next session",
        t2.includes('"Write the notes in notes.md" waits for your next session: "Build the shop page in shop.html" used the rest of this one.'));
      const events = await R.api(N, "GET", `/sessions/${sid}/events?limit=500`).catch(() => null);
      st.ev1 = Array.isArray(events) ? events.length : null;
      const t3 = await inboxText(page, "a03-inbox-card");
      check("A7 card: checks clause (test fails)", /the project's test fails on its work\./.test(t3), "");
      check("A8 card: no check output on the card", !/shop test failed|sk-demo/.test(t3));
      check("A9 Continue explain names the next Start", /Starts a session now with CHF [\d.]+; without it, your next Start takes it in its turn\./.test(t3));
      await page.goto(`${bench().uiUrl}/projects/${pid}/tasks`);
      await page.waitForTimeout(1500);
      const t4 = await R.step(page, "a04-tasks-row");
      check("A10 row label", /Paused before the session's budget ran out/.test(t4));
      await page.getByTestId("task-title").filter({ hasText: "Build the shop page" }).first().click();
      await page.getByTestId("task-drawer-body").waitFor();
      await page.waitForTimeout(1000);
      const t5 = await R.step(page, "a05-task-drawer", { fullPage: true });
      check("A11 drawer detail", /Your next Start goes on with it, or Continue in the Inbox\./.test(t5));
      const tasks = await R.api(N, "GET", `/projects/${pid}/tasks`);
      st.statuses1 = tasks.map((t) => [t.title, t.status]);
      save();
      console.log(JSON.stringify(st.statuses1));
    }
    if (phase === "b") {
      const pid = st.pid;
      const t1 = await inboxText(page, "b01-inbox-after-restart");
      check("B1 same card after restart", /the project's test fails on its work\./.test(t1) && /without it, your next Start takes it in its turn\./.test(t1));
      const { text, sid } = await startFromDialog(page, pid, "2.00", "b02-next-start-dialog");
      st.s2 = sid;
      save();
      check("B2 next Start plans the shop (from its kept work)", /Build the shop page in shop\.html/.test(text) && /spent so far/.test(text), text);
      const t3 = await sessionPage(page, sid, "b03-session-2");
      const t4 = await inboxText(page, "b04-inbox-after-next-start", true);
      check("B3 old card closed by the start", /Your session of \d\d:\d\d went on with it\./.test(t4));
      const runs = await R.api(N, "GET", `/projects/${pid}/tasks`);
      st.statuses2 = runs.map((t) => [t.title, t.status]);
      save();
      console.log(JSON.stringify(st.statuses2));
      check("B4 session 2 took the shop first", /Build the shop page/.test(t3));
    }
    if (phase === "c") {
      const pid = await newProject("Shop limit review");
      st.pid2 = pid;
      st.shop2 = (await task(pid, "Build the shop page two in shop2.html", 9, "medium")).id;
      save();
      const { text, sid } = await startFromDialog(page, pid, "8.00", "c01-start-dialog-alone");
      st.s3 = sid;
      save();
      check("C1 alone: works until its work budget is used", /This session works on "Build the shop page two in shop2\.html" until its work budget is used\./.test(text), text);
      const t2 = await sessionPage(page, sid, "c02-session-limit");
      check("C2 goes-on line once", (t2.match(/The coder goes on with "Build the shop page two in shop2\.html" from where it stopped\./g) ?? []).length === 1, (t2.match(/[^\n]*goes on[^\n]*/g) ?? []).join(" | "));
      const t3 = await inboxText(page, "c03-inbox");
      console.log(t3.slice(0, 3000));
    }
    if (phase === "d") {
      await page.goto(`${bench().uiUrl}/inbox`);
      await page.waitForTimeout(1500);
      const card = page.getByTestId("request").filter({ hasText: st.dTitle || "Build the shop page two" }).first();
      const btn = card.getByTestId("option").filter({ hasText: /^Continue/ }).first();
      const label = await btn.textContent();
      st.continueLabel = label;
      const pid = st.dPid || st.pid2;
      const before = (await sessionsOf(pid)).map((s) => s.id);
      await R.step(page, "d01-before-continue", { fullPage: true });
      await btn.click();
      await page.waitForTimeout(800);
      const yes = page.getByTestId("choice-confirm-yes");
      if (await yes.count()) await yes.click();
      await page.waitForTimeout(1500);
      await R.step(page, "d02-after-continue", { fullPage: true });
      await R.until(async () => (await sessionsOf(pid)).some((s) => !before.includes(s.id)), 60000, 1000, "continue session");
      const sid = (await sessionsOf(pid)).find((s) => !before.includes(s.id)).id;
      st.s4 = sid;
      save();
      check("D1 a session started at once from Continue", !!sid, label);
      await R.until(async () => ended(await R.api(N, "GET", `/sessions/${sid}`)), 300000, 1500, "session end");
      const t = await sessionPage(page, sid, "d03-continue-session");
      const tasks = await R.api(N, "GET", `/projects/${pid}/tasks`);
      st.statuses4 = tasks.map((x) => [x.title, x.status]);
      save();
      console.log(JSON.stringify(st.statuses4));
    }
    if (phase === "e") {
      if (!st.pid3) {
        st.pid3 = await newProject("Tiny review");
        st.tiny = (await task(st.pid3, "Write the tiny guide in tiny.md", 0.05, "medium")).id;
        save();
      }
      const n = (st.eRuns = (st.eRuns ?? 0) + 1);
      save();
      const { text, sid } = await startFromDialog(page, st.pid3, process.argv[3] || "0.02", `e0${n}-start-dialog`);
      st[`e${n}`] = sid;
      save();
      console.log("DIALOG:", text.slice(text.indexOf("Start a session")).slice(0, 800));
      const t2 = await sessionPage(page, sid, `e0${n}-session`);
      console.log("SESSION:", t2.slice(t2.indexOf("You started")).slice(0, 1200));
      const t3 = await inboxText(page, `e0${n}-inbox`, true);
      console.log("INBOX:", t3.slice(t3.indexOf("Needs you")).slice(0, 1800));
    }
    if (phase === "f") {
      await page.goto(`${bench().uiUrl}/inbox`);
      await page.waitForTimeout(1500);
      const card = page.getByTestId("request").filter({ hasText: "Write the tiny guide" }).first();
      await card.getByTestId("choice-note").fill("use the existing parser");
      await R.step(page, "f01-note-typed", { fullPage: true });
      const before = (await sessionsOf(st.pid3)).map((s) => s.id);
      await card.getByTestId("option").filter({ hasText: /^Continue/ }).first().click();
      await page.waitForTimeout(800);
      const yes = page.getByTestId("choice-confirm-yes");
      if (await yes.count()) await yes.click();
      await R.until(async () => (await sessionsOf(st.pid3)).some((s) => !before.includes(s.id)), 60000, 1000, "continue session");
      const sid = (await sessionsOf(st.pid3)).find((s) => !before.includes(s.id)).id;
      st.f1 = sid;
      save();
      await R.until(async () => ended(await R.api(N, "GET", `/sessions/${sid}`)), 240000, 1500, "session end");
      const calls = R.modelCalls(N, "specialist").filter((c) => JSON.stringify(c.messages ?? []).includes("Write the tiny guide"));
      const last = calls.at(-1);
      const first = JSON.stringify(last?.messages?.[0] ?? "");
      check("F1 note in the brief", first.includes("use the existing parser"));
      check("F2 try another way in the brief", first.includes("The last two runs of this task did not get further: try another way"));
      const t = await sessionPage(page, sid, "f02-session");
      console.log("SESSION:", t.slice(t.indexOf("Tasks in this session")).slice(0, 900));
      const t3 = await inboxText(page, "f03-inbox", true);
      console.log("INBOX:", t3.slice(t3.indexOf("Needs you")).slice(0, 900));
    }
    if (phase === "e-dialog") {
      await page.goto(`${bench().uiUrl}/projects/${st.pid3}`);
      await page.getByTestId("start-session").click();
      const dialog = page.getByTestId("start-session-dialog");
      await dialog.waitFor();
      await page.waitForTimeout(1500);
      const t = await R.step(page, "e-dialog-after-no-progress");
      console.log("DIALOG:", t.slice(t.indexOf("Start a session")).slice(0, 800));
      await page.goto(`${bench().uiUrl}/projects/${st.pid3}/tasks`);
      await page.waitForTimeout(1500);
      const t4 = await R.step(page, "e-tasks-after-no-progress");
      console.log("TASKS:", t4.slice(t4.indexOf("Write the tiny")).slice(0, 400));
    }
    try {
      out.problems = await R.problems(N);
    } catch {
      out.problems = [];
    }
  } finally {
    fs.writeFileSync(`${ROOT}/steps/walk-${phase}.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
