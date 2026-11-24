// Review walk for l4-github-carried: Close on a cancelled task's pull request (L4-github-130),
// the "Update yarn.lock" branch (L4e-left-2), the cancelled block's words (L4-github-124 (b)).
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const n = process.argv[2];
const out = {};
const benchDir = `/tmp/frbench/${n}`;
const reqLog = path.join(benchDir, "githost-requests.jsonl");
const readReqs = () =>
  fs.existsSync(reqLog)
    ? fs.readFileSync(reqLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

(async () => {
  const project = await R.api(n, "POST", "/projects", {
    name: "Kite club",
    goal: "The club's pages",
    repos: ["bench/seeded"],
  });
  const pid = project.id;
  out.projectId = pid;
  const a = await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Update yarn.lock",
    outcome: "yarn.lock lists the packages the club's pages use",
    riskTier: 1,
    specialist: "coder",
  });
  const b = await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Write kite/rules.txt with the rules",
    outcome: "kite/rules.txt lists the rules",
    riskTier: 1,
    specialist: "coder",
  });
  out.created = [a, b].map((x) => x.task?.id ?? x.id);
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    // Start the session as the person does: the project page's Start session.
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/summary`);
    await page.getByTestId("start-session").click();
    await R.step(page, "close-01-start-dialog");
    const confirm = page.getByTestId("confirm-start-session");
    if (await confirm.count()) await confirm.click();
    else await page.getByRole("button", { name: /^Start/ }).last().click();
    await R.until(
      async () => {
        const tasks = await R.api(n, "GET", `/projects/${pid}/tasks`);
        return tasks.every((t) => ["done", "failed", "cancelled", "needs_human"].includes(t.status))
          ? tasks
          : null;
      },
      240_000,
      2000,
      "both tasks finished",
    );
    const tasks = await R.api(n, "GET", `/projects/${pid}/tasks`);
    out.tasks = tasks.map((t) => ({ title: t.title, status: t.status, branch: t.branch, pr: t.prUrl ?? t.pr_url }));
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/summary`);
    await page.waitForTimeout(2500);
    out.overviewPrs = await R.step(page, "close-02-overview-prs");
    // Redo then Cancel the yarn.lock task through the Tasks tab, as a person does.
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    const row = page.getByTestId("task-row").filter({ hasText: "Update yarn.lock" });
    await row.getByTestId("action-redo").click();
    await R.step(page, "close-03-redo-dialog");
    await page.getByTestId("confirm-action").click();
    await page.waitForTimeout(1500);
    // The redone task is ready; cancel it before a session picks it up (no session runs now).
    await row.getByTestId("action-cancel").click();
    await R.step(page, "close-04-cancel-dialog");
    await page.getByTestId("confirm-action").click();
    await page.waitForTimeout(1500);
    out.tasksAfterCancel = await R.step(page, "close-05-tasks-after-cancel");
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/summary`);
    await page.getByTestId("prs-cancelled").waitFor({ timeout: 30_000 });
    out.overviewCancelled = await R.step(page, "close-06-overview-cancelled");
    const closeBtn = page.getByTestId("pr-cancelled-close");
    out.closeTitle = await closeBtn.getAttribute("title");
    out.explain = await page.getByTestId("prs-cancelled-explain").innerText();
    out.closeVisibleNearby = await page.getByTestId("pr-cancelled").innerText();
    const before = readReqs().length;
    await closeBtn.click();
    await page.getByTestId("pr-close-answer").waitFor({ timeout: 30_000 });
    out.closeAnswer = await page.getByTestId("pr-close-answer").innerText();
    await page.waitForTimeout(1500);
    out.overviewClosed = await R.step(page, "close-07-overview-closed");
    out.cancelledBlockAfter = await page.getByTestId("prs-cancelled").count();
    const writes = readReqs()
      .slice(before)
      .filter((r) => r.method !== "GET" && !String(r.path).endsWith("git-upload-pack"));
    out.writes = writes.map((r) => `${r.method} ${r.path} ${r.status}`);
    out.allAfter = readReqs()
      .slice(before)
      .map((r) => `${r.method} ${r.path} ${r.status}`);
    // Tasks row of the cancelled one, and its drawer
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    await page.waitForTimeout(1500);
    out.tasksAfterClose = await R.step(page, "close-08-tasks-after-close");
    fs.writeFileSync(path.join(benchDir, "steps", "walk-close.json"), JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  try {
    fs.writeFileSync(path.join(benchDir, "steps", "walk-close.json"), JSON.stringify(out, null, 2));
  } catch {}
  process.exit(1);
});
