// Review walk A: Standard project, a report that says a task is two jobs and a step is missing.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-d1109-selftasks-run";
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(ok ? "OK  " : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
};
const level = Number(process.argv[2] ?? 2);
const pname = process.argv[3] ?? "Bakery site";
const label = process.argv[4] ?? "standard";

(async () => {
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const created = await R.api(N, "POST", "/projects", {
    name: pname,
    goal: "A small web site for the bakery",
    brief:
      "A one-page web site for a bakery.\n- index.html with the menu of breads and cakes and their prices\n- a stylesheet with warm colours and a clear layout for phones\n- a script that shows today's special at the top of the page\n- a README that says how to open the page",
    intake: true,
    autonomyLevel: level,
  });
  const projectId = created.id;
  await R.until(async () => {
    const s = await R.api(N, "GET", `/projects/${projectId}/intake`);
    if (s.state === "failed") throw new Error(s.error);
    return s.state === "pending" ? s : null;
  }, 90_000, 1000, "plan");
  const sessionsBefore = (await R.api(N, "GET", `/sessions`)).length ?? null;
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  await R.step(page, `${label}-plan-card`);
  // Approve and start on this project's card
  const card = page.locator("article, section, li, div").filter({ hasText: pname }).filter({ has: page.getByRole("button", { name: "Approve and start" }) }).last();
  await card.getByRole("button", { name: "Approve and start" }).first().click();
  await page.waitForTimeout(1500);
  const sess = await R.until(async () => {
    const list = await R.api(N, "GET", `/projects/${projectId}/sessions`).catch(() => null);
    const rows = Array.isArray(list) ? list : list?.rows ?? [];
    return rows[0] ?? null;
  }, 30_000, 500, "a session");
  const sessionId = sess.id;
  await page.goto(`${R.bench(N).uiUrl}/sessions/${sessionId}`);
  await page.waitForTimeout(2000);
  await R.step(page, `${label}-session-running`);
  await R.waitForSession(N, sessionId, 600_000);
  await page.waitForTimeout(2500);
  const personText = await R.step(page, `${label}-session-ended`);
  check("session page names the split", /Split "Style the page/.test(personText), personText.split("\n").filter((l) => /Split|Added|Checked the task list|Changed \d tasks/.test(l)));
  const undoButtons = await page.getByRole("button", { name: /Undo/ }).count();
  check("session page has an Undo next to change lines", undoButtons > 0, { undoButtons });
  const details = page.getByText("Details", { exact: true });
  if (await details.count()) {
    await details.first().click();
    await page.waitForTimeout(1500);
  }
  const detailsText = await R.step(page, `${label}-session-details`);
  check("Details: the check line", /Checked the task list after/.test(detailsText), detailsText.split("\n").filter((l) => /Checked the task list|Left out of the task check/.test(l)));
  await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/tasks`);
  await page.waitForTimeout(2000);
  const tasksText = await R.step(page, `${label}-tasks`);
  await page.goto(`${R.bench(N).uiUrl}/changes`);
  await page.waitForTimeout(2000);
  const changesText = await R.step(page, `${label}-changes`);
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  const inboxText = await R.step(page, `${label}-inbox`);
  check("Update line", true, inboxText.split("\n").filter((l) => l.startsWith(pname)));
  const calls = R.modelCalls(N).filter((c) => (c.label ?? "").startsWith(`task-check ${projectId}`));
  check("task-check calls", calls.length >= 0, calls.map((c) => ({ model: c.model, effort: c.effort, tools: (c.tools ?? []).length, max_tokens: c.max_tokens ?? c.maxTokens, usd: c.usd })));
  const tasks = await R.api(N, "GET", `/projects/${projectId}/tasks`);
  check("tasks", true, tasks.map((t) => [t.title, t.status, t.dependsOn ?? t.depends_on]));
  const changes = await R.api(N, "GET", `/changes?projectId=${projectId}`).catch((e) => String(e));
  fs.writeFileSync(`/tmp/frbench/${N}/steps/${label}-changes.json`, JSON.stringify(changes, null, 1));
  out.projectId = projectId;
  out.sessionId = sessionId;
  fs.writeFileSync(`/tmp/frbench/${N}/steps/${label}-walk.json`, JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
