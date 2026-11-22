// Bench walk for the leftovers of wave 7 (leftovers7-session, R-criticbudget): a task whose run
// fits the project's budget but whose critic review does not.
//   node walk-review-budget.cjs <repo> <bench> <label> [projectChf]
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const REPO = process.argv[2];
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const NAME = process.argv[3];
const LABEL = process.argv[4] || "walk";
const PROJECT_CHF = Number(process.argv[5] || "0.01");
const enc = encodeURIComponent;
const out = (s) => console.log(`[review-budget ${LABEL}] ${s}`);

async function main() {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Review budget (${LABEL})`,
    goal: "A club page",
  });
  // The project's budget, as Settings sets it (the command its row sends).
  let set = await R.api(NAME, "POST", "/commands/execute", {
    commands: [
      { name: "budget.set", params: { scope: "project", amountChf: PROJECT_CHF, project: project.id } },
    ],
    wordsUsed: `Settings: Project budget to ${PROJECT_CHF}`,
    source: "ui",
    projectId: project.id,
  });
  if (set.status === "pending")
    set = await R.api(NAME, "POST", `/commands/${enc(set.pendingId)}/confirm`, { answer: "tap" });
  out(`budget.set: ${set.status}`);
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the club page",
    outcome: "club.html shows the club's name",
    acceptanceCriteria: ["club.html exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 2_000_000,
    specialist: "coder",
    riskTier: 1,
  });
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "review budget walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  out(`session ${session.status}: ${session.summary}`);
  const detail = await R.api(NAME, "GET", `/tasks/${enc(task.id)}`);
  out(`task: ${detail.task.status} ${detail.task.display?.label} attempt=${detail.task.attempt ?? "?"}`);
  out(`runs: ${detail.runs.map((r) => `${r.kind}:${r.specialist}:${r.outcome}`).join(", ")}`);
  const inbox = await R.api(NAME, "GET", "/inbox");
  const cards = inbox.requests.filter((q) => q.taskId === task.id);
  out(`cards: ${JSON.stringify(cards.map((q) => [q.title, q.status, (q.choices ?? []).map((c) => c.label)]))}`);
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} tasks tab`);
    const row = page.getByText(task.title).first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(1500);
      await R.step(page, `${LABEL} drawer`);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} inbox`);
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} session`);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(b.root ?? path.dirname(b.home), "steps", `${LABEL}-review-budget.json`),
    JSON.stringify({ session, detail, cards }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
