// Print sessions, tasks of a project, spend.
const { R, N, enc } = require("./h.cjs");
(async () => {
  const pid = process.argv[2];
  const tasks = await R.api(N, "GET", `/projects/${enc(pid)}/tasks`).catch((e) => String(e));
  const sessions = await R.api(N, "GET", `/sessions?projectId=${enc(pid)}`).catch((e) => String(e));
  const ts = Array.isArray(tasks) ? tasks : tasks.tasks ?? tasks;
  for (const t of Array.isArray(ts) ? ts : []) console.log("task", t.id?.slice(-6), t.state, t.statusText ?? t.status ?? "", "|", t.title, "| usd", t.actualCostUsdMicro ?? t.actual_cost_usd_micro ?? "");
  const ss = Array.isArray(sessions) ? sessions : sessions.sessions ?? [];
  for (const s of ss.slice(-3)) console.log("session", s.id?.slice(-6), s.state ?? s.status, s.endedAt ?? "", (s.summary ?? "").slice(0, 200));
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
