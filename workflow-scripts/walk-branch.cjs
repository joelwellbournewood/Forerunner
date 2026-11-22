// leftovers7-merge walk: two tasks with the same title in one repository (R-branch).
// node walk-branch.cjs <label>
const path = require("node:path");
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_294ae3cd-fb8-1/scripts/bench/recorder.cjs");

const NAME = "fix-leftovers7-merge";
const LABEL = process.argv[2] ?? "before";
const enc = encodeURIComponent;

(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(NAME, "POST", "/projects", {
      name: `Same titles (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
      goal: "Two guides with one title",
      repos: ["bench/seeded"],
    });
    const create = (file) =>
      R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
        title: "Write the guide",
        outcome: `${file} is written`,
        acceptanceCriteria: [`${file} exists`],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        specialist: "coder",
        riskTier: 1,
      });
    const first = await create("guide.md");
    await new Promise((r) => setTimeout(r, 1000));
    const second = await create("notes.md");
    await R.startSession(NAME, project.id, "same titles walk");
    await R.until(async () => {
      const rows = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
      return rows.every((t) => t.status === "done" || t.status === "failed" || t.status === "needs_human");
    }, 240_000);
    const rows = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
    const a = (await R.api(NAME, "GET", `/tasks/${first.id}`)).task;
    const c = (await R.api(NAME, "GET", `/tasks/${second.id}`)).task;
    const prs = await R.api(NAME, "GET", `/projects/${enc(project.id)}/pull-requests`);
    const result = {
      label: LABEL,
      ids: [first.id, second.id],
      branches: [a.branch, c.branch],
      prUrls: [a.prUrl, c.prUrl],
      rows: rows.map((t) => ({ title: t.title, status: t.status, label: t.display?.label })),
      waiting: prs.waiting.map((w) => ({ number: w.number, title: w.title, branch: w.branch, taskId: w.taskId })),
    };
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} same titles tasks`);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} same titles overview`);
    fs.writeFileSync(path.join(b.steps, `${LABEL}-same-titles.json`), JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
