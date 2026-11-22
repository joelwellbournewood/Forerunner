// fixup-polish-words walk E (the review's blocking findings):
// 1. a push GitHub refuses (the stand-in's bare repository with a pre-receive hook that prints
//    GitHub's line): the task's reason, its row and drawer, its card name no fr/<id> branch and
//    show GitHub's own line within the row's first 100 characters (C-59, R-2);
// 2. a guide that paused after writing guide.md, cancelled and reopened from the Tasks tab: the
//    ready row's and drawer's Cancel say its work is set aside (P7-20, the real daemon's heldWork).
"use strict";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-11";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const path = require("node:path");
const NAME = "fixup-polish-words";
const out = (s) => console.log(`[walk E] ${s}`);
const result = { texts: {}, checks: [] };
const check = (name, ok, evidence) => {
  result.checks.push({ name, ok: !!ok, evidence });
  out(`${ok ? "PASS" : "FAIL"} ${name} :: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};

(async () => {
  const { browser, page } = await R.openApp(NAME);
  const base = R.bench(NAME).uiUrl.replace(/\?.*$/, "").replace(/\/$/, "");

  // 1. GitHub refuses the push.
  const hook = path.join(path.dirname(R.bench(NAME).home), "githost", "bench", "seeded.git", "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'Permission to bench/seeded.git denied to bench.' >&2\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  try {
    const p = await R.api(NAME, "POST", "/projects", { name: "Locked repo", goal: "A welcome note", repos: ["bench/seeded"] });
    const pid = p.id;
    const created = await R.api(NAME, "POST", `/projects/${pid}/tasks`, {
      title: "Write a short welcome note in welcome.md",
      outcome: "welcome.md greets new members",
      specialist: "coder",
      riskTier: 1,
    });
    const taskId = created.task?.id ?? created.id;
    const started = await R.startSession(NAME, pid);
    const sid = started.session?.id ?? started.sessionId ?? started.id;
    const s = await R.waitForSession(NAME, sid, 400_000);
    result.pushSession = { status: s.status, statusText: s.statusText, summary: s.summary };
    out(`session ${JSON.stringify(result.pushSession)}`);
    const t = (await R.api(NAME, "GET", `/projects/${pid}/tasks`)).find((x) => x.id === taskId);
    result.pushTask = { status: t.status, reason: t.reason, display: t.display, branch: t.branch };
    out(`task ${JSON.stringify(result.pushTask)}`);
    const words = `${t.reason ?? ""} ${t.display?.label ?? ""} ${t.display?.detail ?? ""}`;
    check("the task's reason quotes GitHub's line", /GitHub refused the push: "Permission to bench\/seeded\.git denied to bench"/.test(t.reason ?? ""), t.reason);
    check("no fr/<id> branch in the reason or the row", !/fr\/[0-9a-f]{8}-/.test(words), words);
    const inbox = await R.api(NAME, "GET", "/inbox");
    const card = inbox.requests.find((r) => r.taskId === taskId && r.status === "open");
    result.pushCard = card ? { title: card.title, body: card.body } : null;
    out(`card ${JSON.stringify(result.pushCard)}`);
    check("the card names no fr/<id> branch", !/fr\/[0-9a-f]{8}-/.test(JSON.stringify(result.pushCard ?? {})), result.pushCard);
    await page.goto(`${base}/projects/${pid}/tasks?task=${taskId}`);
    await page.waitForTimeout(2500);
    result.texts.pushTasks = await R.step(page, "51-push-refused-row-and-drawer");
    const rowText = await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-status").textContent();
    result.pushRow = rowText;
    check(
      "the row shows GitHub's line ('Permission to … denied'), not the branch",
      /Permission to bench\/seeded\.git denied/.test(rowText ?? "") || /Permission to bench\/seeded\.git denied/.test(result.texts.pushTasks),
      rowText,
    );
    await page.goto(`${base}/inbox`);
    await page.waitForTimeout(2000);
    result.texts.pushInbox = await R.step(page, "52-push-refused-inbox");
  } finally {
    fs.rmSync(hook, { force: true });
  }

  // 2. A guide that wrote guide.md before its pause: Cancel, Reopen, then the ready row's Cancel.
  const q = await R.api(NAME, "POST", "/projects", { name: "Club guides", goal: "A guide for the club" });
  const qid = q.id;
  const g = await R.api(NAME, "POST", `/projects/${qid}/tasks`, {
    title: "Write the guide in guide.md",
    outcome: "guide.md explains the club",
    specialist: "coder",
    riskTier: 1,
    budgetUsdMicro: 45_000,
  });
  const gid = g.task?.id ?? g.id;
  const gs = await R.startSession(NAME, qid);
  await R.waitForSession(NAME, gs.session?.id ?? gs.sessionId ?? gs.id, 400_000);
  const ws = R.workspaceOf(NAME, qid);
  result.guideAfterPause = fs.existsSync(`${ws}/guide.md`);
  const paused = (await R.api(NAME, "GET", `/projects/${qid}/tasks`)).find((x) => x.id === gid);
  out(`paused: ${paused.status} :: ${JSON.stringify(paused.display)}; guide.md ${result.guideAfterPause}`);
  await page.goto(`${base}/projects/${qid}/tasks`);
  await page.waitForTimeout(2000);
  await page.locator(`[data-testid="task-row"][data-task-id="${gid}"]`).getByTestId("action-cancel").click();
  await page.waitForTimeout(1000);
  await page.getByTestId("confirm-action").click();
  await page.waitForTimeout(2500);
  result.texts.cancelled = await R.step(page, "53-guide-with-work-cancelled");
  result.guideAfterCancel = fs.existsSync(`${ws}/guide.md`);
  await page.goto(`${base}/projects/${qid}/tasks`);
  await page.waitForTimeout(2000);
  await page.locator(`[data-testid="task-row"][data-task-id="${gid}"]`).getByTestId("action-reopen").click();
  await page.waitForTimeout(1000);
  await page.getByTestId("confirm-action").click();
  await page.waitForTimeout(2500);
  result.texts.reopened = await R.step(page, "54-guide-with-work-reopened");
  result.guideAfterReopen = fs.existsSync(`${ws}/guide.md`);
  const ready = (await R.api(NAME, "GET", `/projects/${qid}/tasks`)).find((x) => x.id === gid);
  await page.goto(`${base}/projects/${qid}/tasks?task=${gid}`);
  await page.waitForTimeout(2500);
  result.texts.readyDrawer = await R.step(page, "55-ready-holding-work-drawer");
  const drawerCancel = await page.getByTestId("drawer-explain-cancel").textContent().catch(() => null);
  const rowTitle = await page.locator(`[data-testid="task-row"][data-task-id="${gid}"]`).getByTestId("action-cancel").getAttribute("title");
  check(
    "a ready task holding its paused run's work: row and drawer say Cancel sets it aside (P7-20)",
    ready.status === "ready" && /set aside/.test(drawerCancel ?? "") && /set aside/.test(rowTitle ?? ""),
    {
      status: ready.status,
      cancelWork: ready.display?.cancelWork,
      drawerCancel,
      rowTitle,
      guideAfterPause: result.guideAfterPause,
      guideAfterCancel: result.guideAfterCancel,
      guideAfterReopen: result.guideAfterReopen,
    },
  );
  fs.writeFileSync(`/tmp/frbench/${NAME}/steps/walk-e.json`, JSON.stringify(result, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
