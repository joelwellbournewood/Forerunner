// Review walk B: Assisted projects; the suggestion card, answered while running / after a restart / kept.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5/scripts/bench/recorder.cjs");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const N = "review-d1109-selftasks-run";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5";
const mode = process.argv[2]; // running | restart | keep
const pname = process.argv[3];
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(ok ? "OK  " : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));
};
const BRIEF =
  "A one-page web site for a bakery.\n- index.html with the menu of breads and cakes and their prices\n- a stylesheet with warm colours and a clear layout for phones\n- a script that shows today's special at the top of the page\n- a README that says how to open the page";

async function sessionsOf(projectId) {
  const list = await R.api(N, "GET", `/projects/${projectId}/sessions`);
  return (list.rows ?? []).filter((r) => !r.planning);
}
async function proposalCard(projectId) {
  const inbox = await R.api(N, "GET", "/inbox");
  return (inbox.requests ?? []).find((r) => r.projectId === projectId && /agent suggests/.test(r.title ?? ""));
}

(async () => {
  let { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const created = await R.api(N, "POST", "/projects", {
    name: pname,
    goal: "A small web site for the bakery",
    brief: BRIEF,
    intake: true,
    autonomyLevel: 1,
  });
  const projectId = created.id;
  await R.until(async () => {
    const s = await R.api(N, "GET", `/projects/${projectId}/intake`);
    if (s.state === "failed") throw new Error(s.error);
    return s.state === "pending" ? s : null;
  }, 90_000, 1000, "plan");
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  const plan = page.locator("article, section, li, div").filter({ hasText: `Plan for "${pname}"` }).filter({ has: page.getByRole("button", { name: "Approve and start" }) }).last();
  await plan.getByRole("button", { name: "Approve and start" }).first().click();
  // Assisted: the session plan asks first ("Assisted mode" card); approve it in the UI.
  const assisted = await R.until(async () => {
    const ib = await R.api(N, "GET", "/inbox");
    return (ib.requests ?? []).find((r) => r.projectId === projectId && r.status === "open" && r.title === "Assisted mode") ?? null;
  }, 30_000, 500, "the Assisted mode card");
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  await R.step(page, `${mode}-${pname}-assisted-mode-card`);
  await R.api(N, "POST", `/requests/${assisted.id}/answer`, { version: assisted.version, answer: "approve" });
  const sess = await R.until(async () => (await sessionsOf(projectId))[0] ?? null, 30_000, 500, "a session");
  const card = await R.until(async () => (await proposalCard(projectId)) ?? null, 300_000, 500, "the suggestion card");
  const running = (await sessionsOf(projectId)).some((r) => r.working);
  check("card filed while the session runs on", true, { running, title: card.title, body: card.body, details: card.details, choices: card.choices?.map((c) => [c.label, c.explain]) });
  if (mode !== "running") await R.waitForSession(N, sess.id, 600_000);
  const tasksBefore = await R.api(N, "GET", `/projects/${projectId}/tasks`);
  if (mode === "restart") {
    execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", N], { stdio: "inherit" });
    await browser.close();
    ({ browser, page } = await R.openApp(N));
  }
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  const before = await R.step(page, `${mode}-${pname}-card`);
  const sessionsBefore = (await sessionsOf(projectId)).length;
  const title = `${pname}: the agent suggests`;
  const cardEl = page.locator("article, section, li, div").filter({ hasText: title }).filter({ has: page.getByRole("button", { name: "Keep the tasks" }) }).last();
  // open Details to read the list of changes
  const det = cardEl.getByText("Details", { exact: true });
  if (await det.count()) await det.first().click().catch(() => undefined);
  await page.waitForTimeout(500);
  await R.step(page, `${mode}-${pname}-card-details`);
  const option = mode === "keep" ? "Keep the tasks" : "Make these changes";
  await cardEl.getByRole("button", { name: option }).first().click();
  await page.waitForTimeout(4000);
  const after = await R.step(page, `${mode}-${pname}-done-line`);
  check("Done line", /Done:/.test(after), after.split("\n").filter((l) => /^Done:|Kept|Changed \d|Nothing changed/.test(l)));
  // no session starts within 15 s of the answer (unless it ran already)
  await page.waitForTimeout(15_000);
  const sessAfter = await sessionsOf(projectId);
  check("no session started by the answer", mode === "running" ? sessAfter.length === sessionsBefore : sessAfter.length === sessionsBefore && !sessAfter.some((r) => r.working), { sessionsBefore, after: sessAfter.map((r) => [r.working, r.gist]) });
  const tasksAfter = await R.api(N, "GET", `/projects/${projectId}/tasks`);
  check("tasks before/after", true, { before: tasksBefore.map((t) => [t.title, t.status]), after: tasksAfter.map((t) => [t.title, t.status]) });
  if (mode === "running") {
    for (const r of sessAfter.filter((x) => x.working)) await R.waitForSession(N, r.id, 600_000);
    const fin = await R.api(N, "GET", `/projects/${projectId}/tasks`);
    check("after the running session ended", true, fin.map((t) => [t.title, t.status]));
    const s2 = await sessionsOf(projectId);
    check("session gist", true, s2.map((r) => r.gist));
  }
  await page.goto(`${R.bench(N).uiUrl}/changes`);
  await page.waitForTimeout(2000);
  const ch = await R.step(page, `${mode}-${pname}-changes`);
  const idx = ch.indexOf(pname);
  check("changes page", true, ch.slice(idx, idx + 700));
  if (mode === "restart") {
    const row = page.locator("article, section, li, div").filter({ hasText: "Split \"Style the page in styles.css\"" }).filter({ has: page.getByRole("button", { name: "Undo" }) }).last();
    if (await row.count()) {
      await row.getByRole("button", { name: "Undo" }).first().click();
      await page.waitForTimeout(1500);
      // a confirm dialog may appear
      const confirm = page.getByRole("dialog").getByRole("button", { name: /Undo/ });
      if (await confirm.count()) await confirm.first().click();
      await page.waitForTimeout(2500);
      const u = await R.step(page, `${mode}-${pname}-after-undo`);
      check("undo line", true, u.split("\n").filter((l) => /Undone|undone|Undo/.test(l)).slice(0, 6));
      const t3 = await R.api(N, "GET", `/projects/${projectId}/tasks`);
      check("tasks after undo", true, t3.map((t) => [t.title, t.status]));
    } else check("an Undo on the composed row", false);
  }
  fs.writeFileSync(`/tmp/frbench/${N}/steps/${mode}-${pname}-walk.json`, JSON.stringify({ projectId, ...out }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
