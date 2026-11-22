const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const n = "verify-run4";
(async () => {
  const { projectId, tasks } = await R.createPlannedProject(n, {
    project: "Quote page",
    goal: "A quote page",
    brief: "Build a page that shows a random quote each time it is opened.",
  });
  console.log("tasks", tasks.map((t) => [t.title, t.status]));
  const t0 = Date.now();
  let lastLine = "";
  while (Date.now() - t0 < 240000) {
    const ts = await R.api(n, "GET", `/projects/${projectId}/tasks`);
    const sessions = await R.api(n, "GET", `/sessions?projectId=${projectId}`).catch(() => null);
    const calls = R.modelCalls(n, "specialist");
    const running = ts.find((t) => ["in_progress", "claimed"].includes(t.status));
    let det = null;
    if (running) det = await R.api(n, "GET", `/tasks/${running.id}`);
    let sess = null;
    const list = Array.isArray(sessions) ? sessions : sessions?.sessions ?? sessions?.items ?? [];
    const s0 = list[0];
    if (s0) sess = await R.api(n, "GET", `/sessions/${s0.id}`).catch(() => null);
    const line = JSON.stringify({
      tasks: ts.map((t) => `${t.title.slice(0, 20)}|${t.status}|${t.actual?.chf ?? JSON.stringify(t.actual)}`),
      runs: det?.runs.map((r) => `${r.kind}|${r.outcome}|${JSON.stringify(r.cost)}`),
      sessSpent: sess ? (sess.spent ?? sess.spend ?? sess.cost ?? Object.keys(sess)) : null,
      specialistCalls: calls.length,
    });
    if (line !== lastLine) {
      console.log(new Date().toISOString().slice(11, 19), line);
      lastLine = line;
    }
    if (ts.every((t) => ["done", "failed", "cancelled", "needs_human"].includes(t.status))) break;
    await new Promise((r) => setTimeout(r, 700));
  }
})().catch((e) => { console.error(e); process.exit(1); });
