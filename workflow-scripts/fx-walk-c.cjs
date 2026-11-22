// review-polish-words walk C (on the Members project of walk B):
// - a sign-off card seeded on a draft task (no Docker on this machine for a deploy's full review);
// - the paused task: Cancel from the Tasks tab, then Reopen: a ready task holding work (P7-20, the
//   real daemon's heldWork);
// - Costs and Reviews; the session page before and after the person answers its cards (L-21).
"use strict";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-11";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const NAME = "fixup-polish-words";
const [PID, SID] = process.argv.slice(2);
const out = (s) => console.log(`[walk C] ${s}`);
const result = { texts: {}, checks: [] };
const check = (name, ok, evidence) => {
  result.checks.push({ name, ok: !!ok, evidence });
  out(`${ok ? "PASS" : "FAIL"} ${name} :: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const uuid7 = () => {
  const b = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

(async () => {
  const { browser, page } = await R.openApp(NAME);
  const base = R.bench(NAME).uiUrl.replace(/\?.*$/, "").replace(/\/$/, "");
  const me = await R.api(NAME, "GET", "/me");

  // 1. Seed a sign-off card as the critic files it (followup.ts signoffRequest, reason "verdict").
  const existing = (await R.api(NAME, "GET", `/projects/${PID}/tasks`)).find((t) => t.title === "Deploy the members page");
  const created = existing ? null : await R.api(NAME, "POST", `/projects/${PID}/tasks`, {
    title: "Deploy the members page",
    outcome: "the members page is online",
    specialist: "coder",
    riskTier: 1,
    status: "draft",
  });
  const taskId = existing?.id ?? created.task?.id ?? created.id ?? created.taskId;
  out(`seeded task ${taskId}`);
  const db = new DatabaseSync(`${R.bench(NAME).home}/data/state.sqlite`);
  const already = db.prepare("select id from human_request where task_id = ? and status = 'open'").get(taskId);
  const now = new Date().toISOString();
  const critic = db.prepare("select id from agent where name = 'Critic'").get().id;
  if (!already) db.prepare(
    "update task set status = 'needs_human', reason = 'critic: human sign-off required', version = version + 1, updated_at = ? where id = ?",
  ).run(now, taskId);
  const title = '"Deploy the members page" needs your sign-off';
  const reqId = already?.id ?? uuid7();
  if (!already) db.prepare(
    `insert into human_request (id, created_at, updated_at, author_agent, version, human_id, project_id, task_id, kind, why, steps, options, blocking, status, risk, change_card)
     values (?, ?, ?, ?, 1, ?, ?, ?, 'approval', ?, '[]', ?, 1, 'open', 'medium', ?)`,
  ).run(
    reqId,
    now,
    now,
    critic,
    me.human?.id ?? me.id,
    PID,
    taskId,
    `${title}. The critic said: "Accepted: the page is ready to go online."`,
    JSON.stringify(["Accept the work", "Send it back", "Cancel task"]),
    JSON.stringify({
      key: "critic:signoff",
      task_id: taskId,
      review_id: null,
      run_id: null,
      finding_ids: [],
      reason: "verdict",
      applied_at: null,
      title,
      said: "Accepted: the page is ready to go online.",
      saidBy: "critic",
    }),
  );
  db.close();

  const row = async (id) => (await R.api(NAME, "GET", `/projects/${PID}/tasks`)).find((t) => t.id === id);
  const signoffRow = await row(taskId);
  result.signoffDisplay = signoffRow.display;
  check("sign-off row label", signoffRow.display?.label === "Needs your sign-off", signoffRow.display);
  await page.goto(`${base}/projects/${PID}/tasks?task=${taskId}`);
  await page.waitForTimeout(2500);
  result.texts.signoffDrawer = await R.step(page, "21-signoff-row-and-drawer");
  const rowEl = page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);
  const acts = await rowEl.locator('[data-testid^="action-"]').evaluateAll((els) => els.map((e) => e.textContent));
  check("sign-off row offers Answer and Cancel only", JSON.stringify(acts) === JSON.stringify(["Answer", "Cancel"]), acts);
  const drawerActs = await page.locator('[data-testid^="drawer-action-"]').evaluateAll((els) => els.map((e) => e.textContent));
  check("sign-off drawer offers no Try again", !drawerActs.includes("Try again"), drawerActs);
  check("drawer says the card's own choices", /accept the work, send it back, or cancel it/.test(result.texts.signoffDrawer), "drawer text");
  // Press Answer in the drawer: the Inbox opens at the card.
  await page.getByTestId("drawer-action-answer").click();
  await page.waitForTimeout(2000);
  result.texts.signoffAnswer = await R.step(page, "22-signoff-answer-opens-card");
  check("Answer opens the card", page.url().includes(reqId), page.url());
  // fixup: the row's Answer on the Tasks tab opens the card too (later #55's sibling).
  await page.goto(`${base}/projects/${PID}/tasks`);
  await page.waitForTimeout(2000);
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("action-answer").click();
  await page.waitForTimeout(2000);
  result.texts.rowAnswer = await R.step(page, "22b-row-answer-opens-card");
  check("the row's Answer opens /inbox#card-<its card>", page.url().includes(`#card-${reqId}`), page.url());
  const st = (await R.api(NAME, "GET", `/projects/${PID}`)).statusLine;
  result.statusMembers = st;
  check("three kinds named, no 'and 1 more' (design §5.5)", !/and 1 more/.test(st?.text ?? "") , st);
  out(`members status now ${JSON.stringify(st)}`);
  await page.goto(`${base}/`);
  await page.waitForTimeout(2000);
  result.texts.home = await R.step(page, "23-home-three-kinds");
  // Home's Answer.
  const card = page.locator('[data-testid="project-card"]').filter({ hasText: "Members" }).first();
  await card.getByTestId("project-status-action").click();
  await page.waitForTimeout(2000);
  result.texts.homeAnswer = await R.step(page, "24-home-answer-oldest-card");
  check("Home's Answer opens /inbox#card-<oldest>", /\/inbox#card-/.test(page.url()), page.url());

  // 2. The paused task: Cancel from the Tasks tab, then Reopen it (work comes back: P7-20).
  const tasks = await R.api(NAME, "GET", `/projects/${PID}/tasks`);
  const guide = tasks.find((t) => /Write the guide/.test(t.title));
  await page.goto(`${base}/projects/${PID}/tasks?task=${guide.id}`);
  await page.waitForTimeout(2500);
  result.texts.pausedDrawer = await R.step(page, "25-paused-drawer");
  const drawerCancel = await page.getByTestId("drawer-explain-cancel").textContent().catch(() => null);
  check("paused drawer's Cancel says the work is set aside (P7-21)", /set aside/.test(drawerCancel ?? ""), drawerCancel);
  const rowCancelTitle = await page.locator(`[data-testid="task-row"][data-task-id="${guide.id}"]`).getByTestId("action-cancel").getAttribute("title");
  out(`paused row Cancel title: ${rowCancelTitle}`);
  await page.goto(`${base}/projects/${PID}/tasks`);
  await page.waitForTimeout(2000);
  const gRow = page.locator(`[data-testid="task-row"][data-task-id="${guide.id}"]`);
  await gRow.getByTestId("action-cancel").click();
  await page.waitForTimeout(1200);
  result.texts.cancelDialog = await R.step(page, "26-paused-cancel-dialog");
  await page.getByTestId("confirm-action").click();
  await page.waitForTimeout(2500);
  result.texts.cancelled = await R.step(page, "27-paused-cancelled");
  const ws = R.workspaceOf(NAME, PID);
  result.guideFileAfterCancel = fs.existsSync(`${ws}/guide.md`);
  out(`guide.md after cancel: ${result.guideFileAfterCancel}`);
  // Reopen.
  await page.goto(`${base}/projects/${PID}/tasks`);
  await page.waitForTimeout(2000);
  const reopenBtn = page.locator(`[data-testid="task-row"][data-task-id="${guide.id}"]`).getByTestId("action-reopen");
  if (await reopenBtn.count()) {
    await reopenBtn.click();
    await page.waitForTimeout(1000);
    await page.getByTestId("confirm-action").click();
    await page.waitForTimeout(2500);
  } else out("no Reopen on the row");
  result.guideFileAfterReopen = fs.existsSync(`${ws}/guide.md`);
  out(`guide.md after reopen: ${result.guideFileAfterReopen}`);
  const reopened = await row(guide.id);
  result.reopenedDisplay = reopened.display;
  out(`reopened guide: ${reopened.status} :: ${JSON.stringify(reopened.display)}`);
  await page.goto(`${base}/projects/${PID}/tasks?task=${guide.id}`);
  await page.waitForTimeout(2500);
  result.texts.reopenedDrawer = await R.step(page, "28-reopened-ready-drawer");
  const readyCancel = await page.getByTestId("drawer-explain-cancel").textContent().catch(() => null);
  const rowTitle = await page
    .locator(`[data-testid="task-row"][data-task-id="${guide.id}"]`)
    .getByTestId("action-cancel")
    .getAttribute("title")
    .catch(() => null);
  // fixup: this guide's paused run (CHF 0.004) wrote nothing, so a Cancel sets nothing aside.
  check(
    "reopened task whose paused run wrote nothing: Cancel says only 'Drops it.' (P7-20 fixup)",
    reopened.status === "ready" && !reopened.display?.cancelWork && (readyCancel ?? "").trim() === "Drops it." && rowTitle === "Drops it.",
    { status: reopened.status, readyCancel, rowTitle, guideFileAfterCancel: result.guideFileAfterCancel, guideFileAfterReopen: result.guideFileAfterReopen },
  );

  // 3. Costs and Reviews.
  await page.goto(`${base}/projects/${PID}/costs`);
  await page.waitForTimeout(2500);
  result.texts.costs = await R.step(page, "29-members-costs");
  check("Costs names 'the writer', not the registry key", /the writer/.test(result.texts.costs) && !/writer-marketing/.test(result.texts.costs), (result.texts.costs.match(/[^\n]*writer[^\n]*/g) || []).slice(0, 4));
  await page.goto(`${base}/projects/${PID}/reviews`);
  await page.waitForTimeout(2500);
  result.texts.reviews = await R.step(page, "30-members-reviews");

  // 4. The session page now, then answer the questions card with Cancel task: L-21.
  result.sessionBefore = (await R.api(NAME, "GET", `/sessions/${SID}`)).statusText;
  await page.goto(`${base}/sessions/${SID}`);
  await page.waitForTimeout(2500);
  result.texts.sessionBefore = await R.step(page, "31-session-before-answer");
  const inbox = await R.api(NAME, "GET", "/inbox");
  const chart = tasks.find((t) => /Chart the members/.test(t.title));
  for (const r of inbox.requests.filter((x) => x.projectId === PID && x.status === "open" && x.taskId === chart?.id)) {
    await R.api(NAME, "POST", `/requests/${r.id}/answer`, { version: r.version, answer: "Cancel task" });
  }
  await page.waitForTimeout(2000);
  result.sessionAfter = (await R.api(NAME, "GET", `/sessions/${SID}`)).statusText;
  await page.goto(`${base}/sessions/${SID}`);
  await page.waitForTimeout(2500);
  result.texts.sessionAfter = await R.step(page, "32-session-after-answer");
  out(`session statusText before ${JSON.stringify(result.sessionBefore)} after ${JSON.stringify(result.sessionAfter)}`);
  fs.writeFileSync(`/tmp/frbench/${NAME}/steps/walk-c.json`, JSON.stringify(result, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
