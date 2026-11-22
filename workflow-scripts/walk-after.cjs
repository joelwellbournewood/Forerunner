// d1109-oversize-pause AFTER walk: the larger task in its turn, the pause card with its checks,
// the next Start continuing it and closing its card.
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-3/scripts/bench/recorder.cjs");
const N = "fix-d1109-oversize-pause";
const { DatabaseSync } = require("node:sqlite");
const DB = `/tmp/frbench/${N}/home/data/state.sqlite`;
function setEstimate(taskId, usd) {
  const db = new DatabaseSync(DB);
  db.prepare("update task set est_cost_usd_micro = ? where id = ?").run(Math.round(usd * 1e6), taskId);
  db.close();
}
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

async function main() {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(N, "POST", "/projects", { name: `Shop walk ${Date.now() % 10000}`, goal: "A shop page" });
    const pid = project.id;
    const task = async (title, usd, priority) => {
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
    };
    const intro = await task("Write the intro in intro.md", 0.05, "high");
    const shop = await task("Build the shop page in shop.html", 8, "medium");
    const notes = await task("Write the notes in notes.md", 0.05, "low");
    // The project's own test, failing, in its folder (the kept-work check runs it in the sandbox).
    let ws = null;
    try { ws = R.workspaceOf(N, pid); } catch { ws = null; }
    if (ws) {
      fs.writeFileSync(
        path.join(ws, "package.json"),
        JSON.stringify({ name: "shop", scripts: { test: "node -e \"console.log('shop test failed');process.exit(1)\"" } }),
      );
    }
    const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
    await page.goto(`${bench.uiUrl}/projects/${pid}`);
    await page.getByTestId("start-session").click();
    const dialog = page.getByTestId("start-session-dialog");
    await dialog.waitFor();
    const budget = dialog.getByLabel(/Session budget/);
    await budget.fill("2.00");
    await page.waitForTimeout(800);
    const t1 = await R.step(page, "after-01-start-dialog-order");
    check("plan sentence names the task before it", /This session runs "Write the intro in intro\.md".*then works on "Build the shop page in shop\.html" with what is left\./.test(t1), "");
    check("warning: after \"Write the intro...\"", /after "Write the intro in intro\.md" it works with about CHF/.test(t1));
    check("note: the task after it", /"Write the notes in notes\.md" comes after it: it runs if "Build the shop page in shop\.html" leaves budget, else in your next session\./.test(t1));
    check("no old words", !/after the other tasks|one task that large/.test(t1));
    await dialog.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    const mine = async () =>
      ((await R.api(N, "GET", "/sessions?limit=20")) ?? []).filter((x) => x.projectId === pid);
    await R.until(async () => (await mine()).length >= 1, 60000);
    const s1 = (await mine())[0].id;
    await R.until(async () => {
      const s = await R.api(N, "GET", `/sessions/${s1}`);
      return !["planned", "running", "paused"].includes(s.status);
    }, 120000);
    await page.goto(`${bench.uiUrl}/sessions/${s1}`);
    await page.waitForTimeout(1500);
    const t2 = await R.step(page, "after-02-session-result");
    check("result: notes wait for the next session", /"Write the notes in notes\.md" waits for your next session: "Build the shop page in shop\.html" used the rest of this one\./.test(t2));
    check("Took line once", (t2.match(/Took "Build the shop page in shop\.html"/g) ?? []).length <= 1);
    await page.goto(`${bench.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    const t3 = await R.step(page, "after-03-inbox-pause-card");
    check("card: checks clause", /the project's test fails on its work\./.test(t3), "");
    check("card: Continue explain names the next Start", /without it, your next Start takes it in its turn\./.test(t3));
    await page.goto(`${bench.uiUrl}/projects/${pid}/tasks`);
    await page.waitForTimeout(1500);
    const t4a = await R.step(page, "after-04-tasks-row");
    check("row: wrap-up label", /Paused before the session's budget ran out/.test(t4a));
    await page.getByTestId("task-title").filter({ hasText: "Build the shop page" }).first().click();
    await page.getByTestId("task-drawer-body").waitFor();
    await page.waitForTimeout(800);
    const t4 = await R.step(page, "after-04b-task-drawer");
    check("drawer: next Start goes on with it", /Your next Start goes on with it, or Continue in the Inbox\./.test(t4));
    // The next plain Start takes it in its turn and closes its card.
    await page.goto(`${bench.uiUrl}/projects/${pid}`);
    await page.getByTestId("start-session").click();
    await dialog.waitFor();
    await page.waitForTimeout(800);
    const t5 = await R.step(page, "after-05-next-start-dialog");
    check("next Start plans it from its kept work", /spent so far/.test(t5) || /Build the shop page in shop\.html/.test(t5));
    await dialog.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    await R.until(async () => {
      const rows = await mine();
      return rows.length >= 2 && rows.every((r) => !["planned", "running", "paused"].includes(r.status ?? ""));
    }, 120000).catch(() => undefined);
    await page.goto(`${bench.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    await page.getByTestId("answered").locator("summary").click().catch(() => undefined);
    await page.waitForTimeout(500);
    const t6 = await R.step(page, "after-06-inbox-card-closed-by-start");
    check("card closed by the start", /Your session of \d\d:\d\d went on with it\./.test(t6));
    try { out.problems = await R.problems(N); } catch { out.problems = []; }
  } finally {
    fs.writeFileSync(`/tmp/frbench/${N}/steps/after-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
