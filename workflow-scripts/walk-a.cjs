// fixup-l4-starts-carried bench walk A (--provider bench, FORERUNNER_BENCH_USAGE=club motto:20000):
// the Start dialog with a task paused at the project's budget, a waiter on it, and a waiter on a
// task the person paused (the review's blocking 1 and 2).
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[2];
const name = process.argv[3];
const out = process.argv[4];
const { openApp, step, api, until, skipSetup, bench } = require(path.join(repo, "scripts/bench/recorder.cjs"));

const checks = [];
const check = (label, ok, seen) => {
  checks.push({ label, ok: !!ok, seen });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` :: ${String(seen).slice(0, 400)}`}`);
};

async function task(projectId, title, dependsOn = []) {
  const t = await api(name, "POST", `/projects/${projectId}/tasks`, {
    title,
    outcome: `${title} is written`,
    acceptanceCriteria: ["it is written"],
    priority: "medium",
    status: "ready",
    dependsOn,
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 0,
  });
  return t.task ?? t;
}

async function dialogText(page, projectId, label) {
  await page.goto(`${bench(name).uiUrl.replace(/\/$/, "")}/projects/${projectId}`);
  await page.getByTestId("start-session").first().click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor();
  await page.waitForTimeout(800);
  await step(page, label);
  const text = await dialog.innerText();
  await page.keyboard.press("Escape");
  return text;
}

(async () => {
  const projects = await api(name, "GET", "/projects");
  const project = await api(name, "POST", "/projects", { name: `Club motto ${String(Date.now()).slice(-4)}`, goal: "A motto" });
  // The project's budget: CHF 0.06, through the same command Settings uses.
  const asked = await api(name, "POST", "/commands/execute", {
    commands: [{ name: "budget.set", params: { scope: "project", amountChf: 0.06, project: project.id } }],
    wordsUsed: "Settings: Project budget to 0.06",
    source: "ui",
    projectId: project.id,
  });
  if (asked.status === "pending")
    await api(name, "POST", `/commands/${asked.pendingId}/confirm`, { answer: "yes" });
  const motto = await task(project.id, "Write the club motto in motto.txt");
  const agents = await api(name, "GET", "/agents");
  await api(name, "POST", "/sessions", { agentId: agents[0].id, projectId: project.id, trigger: "manual" });
  await until(
    async () => {
      const ts = await api(name, "GET", `/projects/${project.id}/tasks`);
      const sessions = await api(name, "GET", `/sessions?projectId=${project.id}`);
      return (
        ts.find((t) => t.id === motto.id)?.status === "needs_human" &&
        sessions.every((s) => !["planned", "running", "paused"].includes(s.status))
      );
    },
    120_000,
    1000,
    "the motto task to pause at the project's budget",
  );
  const { browser, page } = await openApp(name);
  await skipSetup(page).catch(() => undefined);
  // 1. Alone: the limit and Open Settings, no "Give your agent work first".
  const alone = await dialogText(page, project.id, "after-1-start-dialog-paused-at-the-project-budget");
  check("the blocker names the limit", /(paused (at|before) the project's budget|its review waits for room in the project's budget).*raise it in Settings/s.test(alone), alone);
  check("Open Settings is offered", /Open Settings/.test(alone), alone);
  check("no 'Give your agent work first'", !/Give your agent work first/.test(alone), alone);
  // 2. A waiter on it and a waiter on a task the person paused.
  await task(project.id, "Write the club rules in rules.txt", [motto.id]);
  const song = await task(project.id, "Write the club song in song.txt");
  await task(project.id, "Sing the club song from song.txt", [song.id]);
  await api(name, "POST", `/tasks/${song.id}/action`, { version: song.version, action: "pause" });
  const waiting = await dialogText(page, project.id, "after-2-start-dialog-with-waiters");
  check(
    "the waiting line names the limit and Settings",
    /"Write the club rules in rules\.txt" waits on "Write the club motto in motto\.txt", (paused (at|before) the project's budget[^,]*|which is done; its review waits for room in the project's budget), so it cannot run\. Raise the project's budget in Settings, or change what it waits for on the Tasks tab\./.test(waiting),
    waiting,
  );
  check(
    "the waiting line says 'which you paused' with Resume",
    /"Sing the club song from song\.txt" waits on "Write the club song in song\.txt", which you paused, so it cannot run\. Resume "Write the club song in song\.txt", or change what it waits for on the Tasks tab\./.test(waiting),
    waiting,
  );
  check("no 'needs your answer' in the dialog", !/needs your answer/.test(waiting), waiting);
  check("no 'Give your agent work first' with waiters", !/Give your agent work first/.test(waiting), waiting);
  // 3. At 375 px the same lines.
  await page.setViewportSize({ width: 375, height: 800 });
  const narrow = await dialogText(page, project.id, "after-3-start-dialog-with-waiters-375");
  check("375 px: same waiting lines", /Raise the project's budget in Settings/.test(narrow) && /which you paused/.test(narrow), narrow);
  fs.writeFileSync(out, JSON.stringify({ projects: projects.length, checks }, null, 2));
  await browser.close();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
