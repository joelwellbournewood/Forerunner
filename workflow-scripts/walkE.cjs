// Review walk E (R-refusedstays): with the only key refused and two tasks waiting, save a Claude
// subscription token as the setup assistant does; does the wait end and a session start by itself?
const [NAME, LABEL, ROOT] = process.argv.slice(2);
const R = require(`${ROOT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const enc = encodeURIComponent;
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const projects = await R.api(NAME, "GET", "/projects");
  const project = projects.filter((p) => /^Credentials/.test(p.name)).at(-1);
  out.project = project.id;
  const rows = async () =>
    (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).map((t) => ({
      title: t.title,
      status: t.status,
      label: t.display?.label,
    }));
  const sessions = async () =>
    (await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`)).map((s) => ({
      id: s.id,
      status: s.status,
      trigger: s.trigger,
      summary: s.summary,
    }));
  out.rowsBefore = await rows();
  out.sessionsBefore = await sessions();
  const token = `sk-ant-oat01-bench-${require("node:crypto").randomBytes(30).toString("hex")}`;
  out.saved = await R.apiRaw(NAME, "POST", "/setup/anthropic", { value: token });
  const t0 = Date.now();
  out.timeline = [];
  while (Date.now() - t0 < 60000) {
    await sleep(3000);
    const s = await sessions();
    const r = await rows();
    out.timeline.push({ t: Date.now() - t0, sessions: s.length, last: s[0], rows: r.map((x) => `${x.status}/${x.label}`) });
    if (s.length > out.sessionsBefore.length && !["running", "planned"].includes(s[0]?.status)) break;
  }
  out.rowsAfter = await rows();
  out.sessionsAfter = await sessions();
  out.check = await R.api(NAME, "GET", `/projects/${enc(project.id)}/start-check`);
  const { browser, page } = await R.openApp(NAME);
  const b = R.bench(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(1500);
    out.tasksText = await R.step(page, `${LABEL}-01-tasks-after-subscription`);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(1500);
    out.overviewText = await R.step(page, `${LABEL}-02-overview-after-subscription`);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(1500);
    out.inboxText = await R.step(page, `${LABEL}-03-inbox-after-subscription`);
  } finally {
    await browser.close();
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-walkE.json`, JSON.stringify(out, null, 2));
    const { tasksText, overviewText, inboxText, ...rest } = out;
    console.log(JSON.stringify(rest, null, 2));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
