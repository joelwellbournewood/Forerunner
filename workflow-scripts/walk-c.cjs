// Walk C (after walk B, Wait answered): a chat question while the subscription rests, then the
// person changes their zone in Settings' profile and asks again (no restart).
const L = require("./walk-lib.cjs");
const { R, N } = L;
const out = { at: new Date().toISOString() };
(async () => {
  const projectId = JSON.parse(L.fs.readFileSync(L.path.join(R.bench(N).home, "..", "evidence", "walk-b-wait-project.json"), "utf8")).projectId;
  const { browser, page } = await R.openApp(N, { path: "/" });
  const a = await L.say(page, projectId, "What is left on this project?", "c chat held in zurich");
  out.zurich = a.reply;
  out.tz = (await R.api(N, "POST", "/setup/profile", { timezone: "America/New_York" })).timezone;
  const b = await L.say(page, projectId, "And what is next?", "c chat held in new york");
  out.newYork = b.reply;
  out.thinkButtons = await page.getByTestId("chat-think").count();
  out.runningAfterZone = (await R.api(N, "GET", "/running")).map((r) => r.text);
  out.rowsAfterZone = (await R.api(N, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`)).map((t) => t.display?.label);
  const inbox = await R.api(N, "GET", "/inbox");
  out.askCard = (inbox.requests ?? []).filter((r) => /Use your API key/.test(r.title ?? "")).map((r) => ({ title: r.title, status: r.status, done: r.answeredLine ?? r.doneLine ?? r.outcome ?? null }));
  await R.api(N, "POST", "/setup/profile", { timezone: "Europe/Zurich" });
  out.apiRequests = L.fs.readFileSync(R.bench(N).apiRequestLog, "utf8").split("\n").filter(Boolean).length;
  console.log(L.save("walk-c.json", out));
  await browser.close();
})().catch((e) => {
  out.error = String(e.stack || e);
  console.log(L.save("walk-c.json", out));
  process.exit(1);
});
