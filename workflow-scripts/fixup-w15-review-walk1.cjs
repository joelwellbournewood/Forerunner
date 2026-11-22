// Fix-up walk for w15-review on the stand-in bench "fixup-w15-review":
// W15-51 (a tagged summary under "Waits for you" never says "Accepted:"), W15-58 (re-walk),
// W15-28 (re-walk: one notification), W15-42 (a person's own done task shows "—").
const R = require("/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-11/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "fixup-w15-review";
const STEPS = "/tmp/frbench/fixup-w15-review/steps";
const enc = encodeURIComponent;
const out = {};
(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: "Fixup walk",
    goal: "Two pages for the club and the club's logo",
  });
  out.projectId = project.id;
  const create = (title, outcome, file, specialist = "coder") =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome,
      acceptanceCriteria: file ? [`${file} exists`] : [],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist,
      riskTier: 1,
    });
  const rework = await create(
    "Write the Rework page in rework.html",
    "rework.html shows the club's rework notes",
    "rework.html",
  );
  const contact = await create(
    "Write the Contact page in contact.html",
    "contact.html shows how to reach the club",
    "contact.html",
  );
  const logo = await create(
    "Send the club logo",
    "The club's logo is in the project as logo.png",
    null,
    "person",
  ).catch((e) => ({ error: String(e) }));
  out.tasks = { rework: rework.id, contact: contact.id, logo: logo.id ?? logo };
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "fixup walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  out.session = { id: session.id, status: session.status, summary: session.summary };
  out.notifications = await R.api(NAME, "GET", "/notifications/recent").catch((e) => ({
    error: String(e),
  }));
  out.contactDetail = await R.api(NAME, "GET", `/tasks/${enc(contact.id)}`);

  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2500);
    out.sessionText = await R.step(page, "w1 session log");
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    out.tasksText = await R.step(page, "w1 tasks tab");
    await page.getByTestId("task-title").filter({ hasText: "Contact page" }).click();
    await page.waitForTimeout(2500);
    out.contactDrawer = await R.step(page, "w1 contact drawer");
    await page.keyboard.press("Escape");
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/reviews`);
    await page.waitForTimeout(2500);
    out.reviews = await R.step(page, "w1 reviews tab");
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    out.inbox = await R.step(page, "w1 inbox");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`${STEPS}/walk1.json`, JSON.stringify(out, null, 1));
  console.log("done", session.status, session.summary);
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${STEPS}/walk1-error.json`, JSON.stringify({ error: String(e?.stack ?? e), out }, null, 1));
  process.exit(1);
});
