const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-3/scripts/bench/recorder.cjs");
const N = "fix-d1109-oversize-pause";
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const list = projects.rows ?? projects;
  const p = list.find((x) => x.name === (process.argv[2] ?? "Shop walk 3895"));
  console.log("project", p.id);
  const sessions = ((await R.api(N, "GET", "/sessions?limit=20")) ?? []).filter((x) => x.projectId === p.id);
  for (const s of sessions) console.log("session", s.id, s.status, s.startedAt ?? s.createdAt, JSON.stringify(s.summary ?? s.result ?? "").slice(0, 700));
  const reqs = await R.api(N, "GET", `/requests?status=all`).catch((e) => String(e));
  const rows = (reqs.rows ?? reqs).filter?.((r) => r.projectId === p.id) ?? reqs;
  console.log(JSON.stringify(rows, null, 1).slice(0, 4000));
  const tasks = await R.api(N, "GET", `/projects/${p.id}/tasks`);
  for (const t of (tasks.rows ?? tasks)) console.log("task", t.title, t.status, JSON.stringify(t.display ?? {}));
})().catch((e) => { console.error(e); process.exit(1); });
