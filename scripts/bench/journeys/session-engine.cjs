// Session-engine journey (the core-experience design, §4): one Start runs a 7-task chain, a
// crash mid-task leaves no ghost session, and the next Start works the first time.
//   node scripts/bench/start.mjs --name se --daemon-port 47940 --ui-port 1540 --fresh \
//        --env FORERUNNER_BENCH_PLAN=chain --env FORERUNNER_BENCH_DELAY_MS=600
//   node scripts/bench/journeys/session-engine.cjs se <label>
//   node scripts/bench/stop.mjs --name se
// Steps are <bench>/steps/NN-<label>-*.png and .txt; the result is
// <bench>/steps/<label>-session-engine.json. The exit code is 0 when the bench itself worked,
// whatever the product did; the checks say what the product did.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const R = require("../recorder.cjs");

const NAME = process.argv[2] || "se";
const LABEL = process.argv[3] || "run";
const ENDED = new Set(["completed", "stopped", "failed", "killed"]);
const b = R.bench(NAME);
const result = { label: LABEL, checks: [], notes: [] };
const out = (s) => console.log(`[session-engine ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const step = (page, s, o) => R.step(page, `${LABEL} ${s}`, o);
const tasksOf = async (projectId) => {
  const t = await R.api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
  return Array.isArray(t) ? t : (t.tasks ?? []);
};
const openProject = async (page, projectId, tab) => {
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${encodeURIComponent(projectId)}/${tab}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
};

/** Open the Start dialog on the project page and press Start; returns the dialog's text. */
async function startFromUi(page, projectId, what) {
  await openProject(page, projectId, "summary");
  const open = page.getByRole("button", { name: /^(Start session|Start|Continue)$/ }).first();
  await open.click();
  await page.waitForTimeout(1500);
  const dialogText = await step(page, `${what} start dialog`);
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForTimeout(2500);
  const after = await step(page, `${what} after start`);
  return { dialogText, after };
}

async function newestSession(projectId) {
  return R.until(
    async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
      return list[0] ?? null;
    },
    30_000,
    500,
    "the new session",
  );
}

(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    const first = await page.evaluate(() => document.body.innerText);
    if (/Set up Forerunner/.test(first)) await R.skipSetup(page);

    // (a) A 7-task chain, one Start.
    const chain = await R.createPlannedProject(NAME, {
      project: "Chain page",
      goal: "A page built in seven steps",
      brief: "A one-page website that shows today's date and a greeting; plain HTML",
    });
    result.chainProject = chain.projectId;
    out(`chain project ${chain.projectId}: ${chain.tasks.length} tasks`);
    const startA = await startFromUi(page, chain.projectId, "chain");
    result.chainDialog = startA.dialogText.slice(-1500);
    const sA = await newestSession(chain.projectId);
    await page.goto(`${b.uiUrl}/sessions/${encodeURIComponent(sA.id)}`);
    await page.waitForTimeout(5000);
    await step(page, "chain session running");
    const endA = await R.waitForSession(NAME, sA.id, 600_000).catch((e) => ({ error: String(e) }));
    await page.waitForTimeout(2000);
    await step(page, "chain session ended");
    const afterA = await tasksOf(chain.projectId);
    const doneA = afterA.filter((t) => t.status === "done").length;
    const sessionsA = await R.api(
      NAME,
      "GET",
      `/sessions?projectId=${encodeURIComponent(chain.projectId)}`,
    );
    result.chain = {
      status: endA.status,
      summary: endA.summary,
      done: doneA,
      of: afterA.length,
      sessions: sessionsA.length,
    };
    check(
      "one Start runs every task of the chain",
      doneA === afterA.length,
      `${doneA} of ${afterA.length} done in ${sessionsA.length} session(s)`,
    );
    check(
      "the session result is at most 3 lines",
      String(endA.summary ?? "").split("\n").length <= 3,
      JSON.stringify(endA.summary),
    );
    check("the result has no '(ready)' list", !/\(ready\)/.test(String(endA.summary ?? "")));
    await openProject(page, chain.projectId, "summary");
    await step(page, "chain project at the end");

    // (e) A crash while a task runs: no ghost, the task is ready, the next Start works.
    const crash = await R.createPlannedProject(NAME, {
      project: "Crash page",
      goal: "A page that survives a crash",
      brief: "A one-page website that shows a random quote; plain HTML",
    });
    result.crashProject = crash.projectId;
    const started = await R.startSession(NAME, crash.projectId);
    const sE = started.session ?? (await newestSession(crash.projectId));
    await R.until(
      async () => {
        const ev = await R.api(NAME, "GET", `/sessions/${encodeURIComponent(sE.id)}/events`);
        return ev.some((e) => e.type === "task.started") ? true : null;
      },
      60_000,
      300,
      "a task to start",
    );
    await page.goto(`${b.uiUrl}/sessions/${encodeURIComponent(sE.id)}`);
    await page.waitForTimeout(1200);
    await step(page, "crash session before the crash");
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, "..", "restart-daemon.mjs"), "--name", NAME, "--hard"],
      { encoding: "utf8" },
    );
    out(`restart: ${r.status} ${r.stdout.slice(-200)} ${r.stderr.slice(-200)}`);
    await R.reconnect(page, NAME);
    await page.goto(`${b.uiUrl}/sessions/${encodeURIComponent(sE.id)}`);
    await page.waitForTimeout(2500);
    const ghostText = await step(page, "crash session after the restart");
    const ghost = await R.api(NAME, "GET", `/sessions/${encodeURIComponent(sE.id)}`);
    result.crash = { status: ghost.status, summary: ghost.summary };
    check("the crashed session is no longer running", ENDED.has(ghost.status), ghost.status);
    check("the session page says it was interrupted", /Interrupted/i.test(ghostText));
    const tasksE = await tasksOf(crash.projectId);
    check(
      "no task is left in progress or claimed",
      !tasksE.some((t) => ["in_progress", "claimed"].includes(t.status)),
      tasksE.map((t) => `${t.title}: ${t.status}`).join("; "),
    );
    const inbox = await R.api(NAME, "GET", "/inbox");
    const interrupted = (inbox.messages ?? []).filter((m) => /interrupted/i.test(m.body ?? ""));
    check(
      "one Update says the session was interrupted",
      interrupted.length === 1,
      String(interrupted.length),
    );
    await openProject(page, crash.projectId, "summary");
    await step(page, "crash project after the restart");
    const startE = await startFromUi(page, crash.projectId, "crash next");
    check(
      "the next Start works the first time",
      !/already has an active session/.test(startE.after),
      startE.after.slice(-300),
    );
    const probs = R.problems(NAME).filter((p) => /\b409\b/.test(JSON.stringify(p)));
    check("no 409 anywhere", probs.length === 0, JSON.stringify(probs.slice(0, 3)));
  } finally {
    fs.writeFileSync(
      path.join(b.steps, `${LABEL}-session-engine.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
