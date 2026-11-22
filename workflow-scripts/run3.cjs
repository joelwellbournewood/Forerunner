const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const n = "verify-run3";
(async () => {
  const { projectId, tasks } = await R.createPlannedProject(n, {
    project: "Club notes",
    goal: "A welcome note for the club",
    brief: "Write a welcome note for the chess club in notes/welcome.md.",
  });
  console.log("tasks", tasks.map((t) => [t.id, t.title, t.status, t.riskTier]));
  // Approve may have started a session already; wait for any session to end, then start if needed.
  let sessions = [];
  for (let i = 0; i < 3; i++) {
    const runnable = (await R.api(n, "GET", `/projects/${projectId}/tasks`)).filter((t) => ["ready","claimed","in_progress","in_review"].includes(t.status));
    if (!runnable.length) break;
    const list = await R.api(n, "GET", `/sessions?projectId=${projectId}`).catch(() => null);
    const running = (Array.isArray(list) ? list : list?.sessions ?? []).find((s) => s.status === "running");
    let sid = running?.id;
    if (!sid) { const s = await R.startSession(n, projectId); sid = s.sessionId ?? s.id ?? s.session?.id; }
    sessions.push(sid);
    await R.waitForSession(n, sid, 240000);
  }
  const after = await R.api(n, "GET", `/projects/${projectId}/tasks`);
  const costs = await R.api(n, "GET", `/costs?projectId=${projectId}`);
  for (const t of after) {
    const d = await R.api(n, "GET", `/tasks/${t.id}`);
    const runs = d.runs.map((r) => `${r.kind}/${r.specialist} ${r.cost.chfMicro}`);
    const b = costs.byTask.find((x) => x.key === t.id);
    console.log(JSON.stringify({ title: t.title, status: t.status, tier: t.riskTier, actualChfMicro: t.actual.chfMicro, runs, costsByTaskChfMicro: b?.cost.chfMicro, sumRuns: d.runs.reduce((s, r) => s + r.cost.chfMicro, 0) }));
  }
  console.log("totals", costs.totals, "sessions", sessions);
})().catch((e) => { console.error(e); process.exit(1); });
