// w8-l4-leftovers AFTER walk: a project with two tasks, one done by a session, one never run;
// the Tasks tab shows no CHF 0.00 for the task that spent nothing.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const name = "fix-w8-l4-leftovers";
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8"));
const api = async (path, body, method) => {
  const res = await fetch(`${bench.daemonUrl}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${bench.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.json().catch(() => null);
};
(async () => {
  const project = await api("/projects", { name: "Pond notes", goal: "Notes about the pond" });
  const task = (title, priority) =>
    api(`/projects/${project.id}/tasks`, {
      title,
      outcome: `${title} is done`,
      acceptanceCriteria: ["it is done"],
      priority,
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "coder",
      riskTier: 0,
    });
  const a = await task("Write notes/pond.md", "high");
  await task("Write notes/frogs.md", "low");
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${bench.uiUrl}/projects/${project.id}/tasks`);
    await page.waitForTimeout(1500);
    const before = await R.step(page, "after-1-tasks-tab-nothing-spent");
    console.log("TASKS TAB:", before.includes("CHF 0.00") ? "has CHF 0.00" : "no CHF 0.00");
    console.log("task", a?.id ?? JSON.stringify(a).slice(0, 200));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
