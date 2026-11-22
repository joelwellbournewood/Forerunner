const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-3/scripts/bench/recorder.cjs");
const N = "fix-d1109-oversize-pause";
(async () => {
  const id = process.argv[2];
  const ev = await R.api(N, "GET", `/sessions/${id}/events?afterSeq=0`);
  const rows = ev.rows ?? ev.events ?? ev;
  for (const e of rows) {
    const t = e.type ?? e.event ?? "";
    if (/token|delta|tool|progress|heartbeat/.test(t)) continue;
    console.log(t, JSON.stringify(e.payload ?? e.data ?? e).slice(0, 400));
  }
  const tasks = await R.api(N, "GET", `/sessions/${id}/tasks`);
  console.log(JSON.stringify(tasks, null, 1).slice(0, 2500));
})().catch((e) => { console.error(e); process.exit(1); });
