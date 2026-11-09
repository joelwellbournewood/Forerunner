// Wait until the task titled argv[3] in project argv[2] leaves running/review states (max argv[4] s).
const { R, N, log, enc, sleep } = require("./h.cjs");
const [PID, TITLE, MAX] = process.argv.slice(2);
(async () => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < Number(MAX || 600) * 1000) {
    const tasks = await R.api(N, "GET", `/projects/${enc(PID)}/tasks`);
    const t = (tasks.tasks ?? tasks).find((x) => x.title.includes(TITLE));
    const st = t ? t.status : "missing";
    if (st !== last) { log("state", st); last = st; }
    if (t && !["ready", "claimed", "in_progress", "in_review"].includes(st)) break;
    await sleep(10000);
  }
  const sessions = await R.api(N, "GET", `/sessions?projectId=${enc(PID)}`);
  const s = (sessions.sessions ?? sessions).at(0);
  log("latest session", s?.id, s?.status, (s?.summary ?? "").slice(0, 300));
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
