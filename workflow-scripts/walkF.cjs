// Review walk F (R-planningstart): Start session on one project while a New project's planning call
// runs. Expected: the start waits for the planning call ("Queued: ..."), then runs by itself.
const [NAME, LABEL, ROOT] = process.argv.slice(2);
const R = require(`${ROOT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const enc = encodeURIComponent;
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = R.bench(NAME);
  const notes = await R.api(NAME, "POST", "/projects", { name: "Notes", goal: "Two notes" });
  for (const [title, file] of [
    ["Write notes/a.md", "notes/a.md"],
    ["Write notes/b.md", "notes/b.md"],
  ])
    await R.api(NAME, "POST", `/projects/${enc(notes.id)}/tasks`, {
      title,
      outcome: `${file} exists with a short note`,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "writer",
      riskTier: 0,
    });
  out.notes = notes.id;
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(1000);
    if (await page.getByText("Set up later").count()) await R.skipSetup(page);
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(1000);
    await page.getByTestId("new-project").first().click();
    await page.locator('input[name="name"]').fill("Garden page");
    await page.locator('textarea[name="brief"]').fill("A one-page site for the garden club");
    await page.getByTestId("create-project").click();
    const t0 = Date.now();
    await page.waitForTimeout(1500);
    out.planningScreen = await R.step(page, `${LABEL}-01-planning`);
    // At once: the other project, Start session.
    await page.goto(`${b.uiUrl}/projects/${enc(notes.id)}/summary`);
    await page.getByTestId("start-session").first().click();
    await page.getByTestId("start-session-dialog").waitFor();
    await page.waitForTimeout(1200);
    out.dialogBefore = await R.step(page, `${LABEL}-02-start-dialog`);
    out.intakeAtStart = (await R.api(NAME, "GET", "/projects")).map((p) => [p.name, p.intake?.state ?? p.planning ?? null]);
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    out.notice = await page.getByTestId("start-session-notice").textContent().catch(() => null);
    out.error = await page.locator('[role="alert"]').allTextContents().catch(() => []);
    out.dialogAfter = await R.step(page, `${LABEL}-03-after-start`);
    out.secondsIntoPlanning = (Date.now() - t0) / 1000;
    await page.keyboard.press("Escape");
    // Wait: planning ends, then the Notes session runs and its tasks finish.
    const done = await R.until(
      async () => {
        const s = await R.api(NAME, "GET", `/sessions?projectId=${enc(notes.id)}`);
        const tasks = await R.api(NAME, "GET", `/projects/${enc(notes.id)}/tasks`);
        return s.length && tasks.every((t) => t.status === "done") ? { s, tasks } : null;
      },
      240000,
      3000,
      "the queued Notes session to run and finish",
    ).catch((e) => ({ error: String(e) }));
    out.sessions = (await R.api(NAME, "GET", `/sessions?projectId=${enc(notes.id)}`)).map((s) => ({
      status: s.status,
      trigger: s.trigger,
      startedAt: s.startedAt,
      summary: s.summary,
    }));
    out.tasks = (await R.api(NAME, "GET", `/projects/${enc(notes.id)}/tasks`)).map((t) => `${t.title}: ${t.status}`);
    out.finished = !done.error;
    out.waited = done.error ?? null;
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    out.inbox = await R.step(page, `${LABEL}-04-inbox`);
    await page.goto(`${b.uiUrl}/projects/${enc(notes.id)}/summary`);
    await page.waitForTimeout(1500);
    out.notesOverview = await R.step(page, `${LABEL}-05-notes-overview`);
  } finally {
    await browser.close();
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-walkF.json`, JSON.stringify(out, null, 2));
    const { planningScreen, dialogBefore, dialogAfter, inbox, notesOverview, ...rest } = out;
    console.log(JSON.stringify(rest, null, 2));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
