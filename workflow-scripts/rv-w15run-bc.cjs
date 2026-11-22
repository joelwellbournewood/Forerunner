// Reviewer walks B and C for w15-run.
// B (W15-19): New project through the UI, the plan card's figures, Approve and start, Stop now
//   during the first call, the Start dialog's figures, a daemon restart, the figures again.
// C (W15-59): a project with one task, Start through the dialog, Cancel the task on the Tasks
//   tab while the critic reviews it, the session's result.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPO = process.argv[2];
const WHICH = process.argv[3] ?? "BC";
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const NAME = "review-w15-run";
const enc = encodeURIComponent;
const result = {};
const out = (s) => console.log(`[${WHICH}] ${s}`);
const restart = (env = []) =>
  execFileSync(
    "node",
    [path.join(REPO, "scripts/bench/restart-daemon.mjs"), "--name", NAME, ...env.flatMap((e) => ["--env", e])],
    { stdio: "inherit" },
  );
const sessionsOf = async (projectId) => {
  const s = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`).catch(() => []);
  return (Array.isArray(s) ? s : (s.sessions ?? [])).filter((x) => x.projectId === projectId);
};
const figuresOf = (check) =>
  Object.fromEntries(
    [...(check.runnable ?? []), ...(check.later ?? [])].map((t) => [t.title ?? t.taskId, t.estimate?.chfMicro]),
  );

async function walkB() {
  const b = R.bench(NAME);
  let { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByLabel("Name").fill("Pairing page 2");
    await page.getByLabel(/^Brief/).fill("A web page that pairs the chess club's players for each round.");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
    const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
    result.B = { projectId };
    await R.until(
      async () => (await R.api(NAME, "GET", `/projects/${enc(projectId)}/intake`)).state === "pending",
      180_000,
      2000,
      "the plan",
    );
    await page.getByRole("link", { name: /^Inbox/ }).first().click();
    await page.waitForTimeout(2000);
    const card = page.getByTestId("request").filter({ hasText: 'Plan for "Pairing page 2"' });
    result.B.planCard = await card.getByTestId("intake-task").allInnerTexts();
    await R.step(page, "B plan card");
    const before = new Set((await sessionsOf(projectId)).map((x) => x.id));
    await card.getByRole("button", { name: "Approve and start", exact: true }).click();
    const sessionId = await R.until(
      async () => (await sessionsOf(projectId)).find((x) => !before.has(x.id))?.id ?? null,
      30_000,
      500,
      "the session",
    );
    await page.goto(`${b.uiUrl}/sessions/${enc(sessionId)}`);
    // Stop now while the first task's first call is under way.
    await R.until(
      async () =>
        (await R.api(NAME, "GET", `/projects/${enc(projectId)}/tasks`)).some((t) => t.status === "in_progress"),
      60_000,
      300,
      "a running task",
    );
    await page.waitForTimeout(800);
    await R.step(page, "B session running");
    await page.getByRole("button", { name: "Stop now", exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.getByTestId("stop-now-confirm").getByRole("button", { name: /Stop now/ }).click();
    await R.until(
      async () => !["running", "planned", "paused"].includes((await R.api(NAME, "GET", `/sessions/${enc(sessionId)}`)).status),
      60_000,
      1000,
      "the session to stop",
    );
    await page.waitForTimeout(1500);
    result.B.sessionAfterStop = (await R.step(page, "B session after stop now")).slice(-1500);
    result.B.tasksAfterStop = (await R.api(NAME, "GET", `/projects/${enc(projectId)}/tasks`)).map((t) => ({
      title: t.title,
      status: t.status,
      estimate: t.estimate?.chfMicro,
      actual: t.actual?.usdMicro,
      spent: t.spent?.usdMicro,
    }));
    await page.goto(`${b.uiUrl}/projects/${enc(projectId)}/tasks`);
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    result.B.dialogAfterStop = (await R.step(page, "B start dialog after stop now")).split("Start a session").pop();
    result.B.checkAfterStop = figuresOf(await R.api(NAME, "GET", `/projects/${enc(projectId)}/start-check`));
    await page.keyboard.press("Escape");
    await browser.close();
    restart();
    ({ browser, page } = await R.openApp(NAME));
    await page.goto(`${b.uiUrl}/projects/${enc(projectId)}/tasks`);
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    result.B.dialogAfterRestart = (await R.step(page, "B start dialog after restart")).split("Start a session").pop();
    result.B.checkAfterRestart = figuresOf(await R.api(NAME, "GET", `/projects/${enc(projectId)}/start-check`));
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
}

async function walkC() {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", { name: "Club notes", goal: "Notes for the club" });
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the meeting notes",
    outcome: "meeting.md lists the meeting's decisions",
    acceptanceCriteria: ["meeting.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 1,
  });
  result.C = { projectId: project.id };
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2000);
    await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
    await R.until(
      async () => (await R.api(NAME, "GET", `/tasks/${enc(task.id)}`)).task.status === "in_review",
      120_000,
      300,
      "the review",
    );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(1200);
    await R.step(page, "C tasks being reviewed");
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await page.waitForTimeout(800);
    result.C.cancelDialog = await R.step(page, "C cancel dialog");
    const dlg = page.getByRole("dialog");
    const buttons = await dlg.getByRole("button").allInnerTexts();
    result.C.dialogButtons = buttons;
    const confirm = buttons.find((x) => /^Cancel (the )?task|^Cancel it|^Yes/.test(x.trim())) ??
      buttons.find((x) => /Cancel/.test(x) && x.trim() !== "Cancel");
    await dlg.getByRole("button", { name: confirm.trim(), exact: true }).click();
    const sid = await R.until(async () => (await sessionsOf(project.id))[0]?.id ?? null, 10_000, 500, "s");
    await R.until(
      async () => !["running", "planned", "paused"].includes((await R.api(NAME, "GET", `/sessions/${enc(sid)}`)).status),
      120_000,
      1000,
      "the session to end",
    );
    await page.waitForTimeout(2000);
    await R.step(page, "C tasks after cancel");
    const s = await R.api(NAME, "GET", `/sessions/${enc(sid)}`);
    result.C.session = { status: s.status, summary: s.summary };
    await page.goto(`${b.uiUrl}/sessions/${enc(sid)}`);
    await page.waitForTimeout(2500);
    result.C.sessionPage = (await R.step(page, "C session page")).split("· session at").pop().slice(0, 2500);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
    await page.waitForTimeout(2500);
    result.C.overview = (await R.step(page, "C overview")).slice(0, 2500);
    result.C.task = (await R.api(NAME, "GET", `/tasks/${enc(task.id)}`)).task;
  } finally {
    await browser.close();
  }
}

(async () => {
  if (WHICH.includes("B")) await walkB();
  if (WHICH.includes("C")) await walkC();
  fs.writeFileSync(
    path.join(path.dirname(R.bench(NAME).home), "steps", `${WHICH}-result.json`),
    JSON.stringify(result, null, 2),
  );
  out("done");
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(path.dirname(R.bench(NAME).home), "steps", `${WHICH}-result.json`),
    JSON.stringify(result, null, 2),
  );
  process.exit(1);
});
