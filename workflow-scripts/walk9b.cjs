// Review walk 9b (R-dirtyworktree): after the crash, the person presses Start again; the task
// finishes with its pull request and the cut-short run's files are kept under the failed ref.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-3/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const N = "review-leftovers7-merge";
const DIR = "/tmp/frbench/review-leftovers7-merge";
const w9 = JSON.parse(fs.readFileSync(`${DIR}/walk9.json`, "utf8"));
const out = { ...w9 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { browser, page } = await R.openApp(N);
  const b = R.bench(N);
  await page.goto(`${b.uiUrl}/projects/${w9.projectId}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1500);
  out.overviewAfterCrash = await R.step(page, "w9-01-overview-after-crash");
  out.taskAfterCrash = (await R.api(N, "GET", `/tasks/${w9.taskId}`)).task.status;
  await page.getByRole("button", { name: /^(Start|Continue|Start session)$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /^Start/ }).last().click();
  await R.until(async () => ["done", "failed", "needs_human"].includes((await R.api(N, "GET", `/tasks/${w9.taskId}`)).task.status), 240_000, 3000, "the task to finish").catch((e) => (out.waitErr = String(e)));
  await sleep(3000);
  const t = (await R.api(N, "GET", `/tasks/${w9.taskId}`)).task;
  out.after = { status: t.status, prUrl: t.prUrl, label: t.display?.label, reason: t.reason };
  out.failedRefs = execFileSync("git", ["-C", w9.worktree, "for-each-ref", "refs/forerunner/failed/"], { encoding: "utf8" }).trim();
  out.statusNow = execFileSync("git", ["-C", w9.worktree, "status", "--porcelain"], { encoding: "utf8" }).trim();
  const log = fs.readFileSync(`${DIR}/daemon.log`, "utf8");
  out.refusedInLog = /would be overwritten|resolve your current index/.test(log);
  out.cutShortLog = log.split("\n").filter((l) => /cut-short|set aside|leftovers/.test(l)).slice(-3).map((l) => l.slice(0, 300));
  await page.goto(`${b.uiUrl}/projects/${w9.projectId}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1500);
  out.overviewDone = await R.step(page, "w9-02-overview-after-restart-run");
  fs.writeFileSync(`${DIR}/walk9.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, overviewAfterCrash: out.overviewAfterCrash.slice(0, 700), overviewDone: undefined }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("WALK FAILED", e);
  fs.writeFileSync(`${DIR}/walk9.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
