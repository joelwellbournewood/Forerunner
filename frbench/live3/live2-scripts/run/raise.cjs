const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const pid = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Club motto").id;
    const t1 = Date.now();
    out.set2 = await L.setProjectSetting(page, NAME, "Club motto", "project.budget", "1", "cb07 raise project budget");
    const s2 = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t1 - 3000); }, 120000, 2000, "a session after raising").catch(() => null);
    out.autoStarted = !!s2;
    if (s2) {
      out.trigger = s2.trigger;
      const d2 = await R.waitForSession(NAME, s2.id, 600000);
      out.session2 = { status: d2.status, summary: d2.summary };
      out.calls2 = R.modelCalls(NAME).filter((c) => c.sessionId === s2.id).map((c) => `${c.role}:${c.usd}`);
      const ev2 = await R.api(NAME, "GET", `/sessions/${enc(s2.id)}/events`);
      out.events2 = (ev2.events ?? ev2).map((e) => e.text).filter(Boolean);
    }
    const t2 = (await L.tasks(NAME, pid))[0];
    out.row2 = { status: t2.status, display: t2.display?.label };
    const inbox2 = await R.api(NAME, "GET", "/inbox");
    out.cards2 = (inbox2.requests ?? []).filter((r) => r.status === "open" && r.projectId === pid).map((r) => r.title);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t2.id)}`, 2500);
    await R.step(page, "cb08 drawer after raise");
  } finally { save(NAME, "raise.json", out); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
