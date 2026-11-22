// Walk A: a refused API key (bench-api --api-key refused). The person sets their zone, makes a
// project with one task, presses Start in the dialog, then reads the Inbox, the notifications,
// the Tasks tab, asks chat, tells chat to start, and opens the Start dialog again.
const L = require("./walk-lib.cjs");
const { R, N, enc } = L;
const out = { at: new Date().toISOString() };
(async () => {
  out.tz = await R.api(N, "POST", "/setup/profile", { timezone: "Europe/Zurich" });
  const me = await R.api(N, "GET", "/me");
  out.meTz = me.timezone;
  const project = await R.api(N, "POST", "/projects", { name: "Field notes", goal: "Field notes" });
  out.projectId = project.id;
  await R.api(N, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write notes/field.md",
    outcome: "The notes are written",
    acceptanceCriteria: ["notes/field.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
  });
  const { browser, page } = await R.openApp(N, { path: `/projects/${enc(project.id)}` });
  await L.goto(page, `/projects/${enc(project.id)}`, 2000);
  out.overviewBefore = await R.step(page, "a overview before start");
  await page.getByTestId("start-session").first().click();
  await page.waitForTimeout(2000);
  out.dialogBefore = await R.step(page, "a start dialog before");
  await page.getByTestId("confirm-start-session").click();
  await page.waitForTimeout(12000);
  await L.goto(page, "/inbox", 2500);
  out.inboxText = await R.step(page, "a inbox after start");
  const inbox = await R.api(N, "GET", "/inbox");
  out.inbox = {
    requests: (inbox.requests ?? []).map((c) => ({ title: c.title, body: c.body, status: c.status, links: c.links, choices: (c.choices ?? []).map((x) => x.label) })),
    messages: (inbox.messages ?? []).map((m) => ({ title: m.title, body: m.body })),
  };
  out.notifications = ((await R.api(N, "GET", "/notifications/recent?limit=50")).notifications ?? []).map((n) => ({ kind: n.kind, title: n.title, body: n.body, link: n.link }));
  await L.goto(page, `/projects/${enc(project.id)}/tasks`, 2000);
  out.tasksText = await R.step(page, "a tasks tab after start");
  out.rows = (await R.api(N, "GET", `/projects/${enc(project.id)}/tasks`)).map((t) => ({ title: t.title, status: t.status, label: t.display?.label }));
  const q1 = await L.say(page, project.id, "What is next on this project?", "a chat question refused key");
  out.chatQuestion = q1.reply;
  const q2 = await L.say(page, project.id, "start a session", "a chat start refused key");
  out.chatStart = q2.reply;
  out.chatStartHasYes = await page.getByRole("button", { name: /^Yes$/ }).count();
  await L.goto(page, `/projects/${enc(project.id)}`, 2000);
  out.overviewAfter = await R.step(page, "a overview after");
  await page.getByTestId("start-session").first().click();
  await page.waitForTimeout(2500);
  out.dialogAfter = await R.step(page, "a start dialog after refusal");
  out.dialogBlocked = await page.getByTestId("start-session-blocked").innerText().catch(() => null);
  out.confirmDisabled = await page.getByTestId("confirm-start-session").isDisabled().catch(() => null);
  await page.keyboard.press("Escape");
  await L.goto(page, "/settings", 2500);
  out.settings = await R.step(page, "a settings after refusal");
  out.policy = await R.api(N, "GET", "/settings/credential-policy").catch((e) => String(e));
  out.sessions = L.q("select id, status, summary from session where project_id = ?", project.id);
  out.apiRequests = L.fs.existsSync(R.bench(N).apiRequestLog)
    ? L.fs.readFileSync(R.bench(N).apiRequestLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => ({ path: r.path, status: r.status, answer: r.answer }))
    : [];
  out.problems = R.problems(N);
  console.log(L.save("walk-a.json", out));
  await browser.close();
})().catch((e) => {
  out.error = String(e.stack || e);
  console.log(L.save("walk-a.json", out));
  process.exit(1);
});
