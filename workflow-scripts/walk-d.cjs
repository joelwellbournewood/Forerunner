// Walk D: 'then wait', the subscription at its limit, a new project with one ready task and no
// kept start: what chat's "start a session" does (L4-creds-8 part 3, left in not_done), and what
// the Start dialog says beside it.
const L = require("./walk-lib.cjs");
const { R, N, enc } = L;
const out = { at: new Date().toISOString() };
(async () => {
  out.policy = (await L.cmd([{ name: "settings.set", params: { key: "credential_policy", value: "subscription_then_wait" } }])).status;
  const until = new Date(Date.now() + 40 * 60_000);
  until.setUTCSeconds(0, 0);
  out.restingUntil = until.toISOString();
  L.patchLimits("subscription", (l) => ({ ...l, restingUntil: out.restingUntil }));
  const project = await R.api(N, "POST", "/projects", { name: "Map notes", goal: "Map notes" });
  await R.api(N, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write notes/map.md",
    outcome: "The notes are written",
    acceptanceCriteria: ["notes/map.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
  });
  const { browser, page } = await R.openApp(N, { path: "/" });
  const q = await L.say(page, project.id, "What is next?", "d chat held then wait");
  out.held = q.reply;
  const s = await L.say(page, project.id, "start a session", "d chat start while resting");
  out.start = s.reply;
  out.yesButtons = await page.getByRole("button", { name: /^Yes$/ }).count();
  if (out.yesButtons) {
    await page.getByRole("button", { name: /^Yes$/ }).last().click();
    await page.waitForTimeout(8000);
    out.afterYes = await R.step(page, "d chat after yes");
  }
  out.sessions = L.q("select status, trigger, summary from session where project_id = ?", project.id);
  out.startCheck = (await R.api(N, "GET", `/projects/${enc(project.id)}/start-check`)).blocked ?? null;
  out.credential = (await R.api(N, "GET", `/projects/${enc(project.id)}/start-check`)).credential ?? null;
  out.running = (await R.api(N, "GET", "/running")).map((r) => r.text);
  out.apiRequests = L.fs.readFileSync(R.bench(N).apiRequestLog, "utf8").split("\n").filter(Boolean).length;
  console.log(L.save("walk-d.json", out));
  await browser.close();
})().catch((e) => {
  out.error = String(e.stack || e);
  console.log(L.save("walk-d.json", out));
  process.exit(1);
});
