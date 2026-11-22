const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-8/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const st = JSON.parse(fs.readFileSync("/tmp/frbench/review-d1109-oversize-pause/walk-state.json", "utf8"));
(async () => {
  const sid = st[process.argv[2]];
  const ev = await R.api("review-d1109-oversize-pause", "GET", `/sessions/${sid}/events?limit=500`);
  const rows = Array.isArray(ev) ? ev : (ev.events ?? ev.items ?? []);
  if (!rows.length) console.log(JSON.stringify(ev).slice(0, 500));
  for (const e of rows) {
    if (/llm|tool\.|token|\.step$/.test(e.type) && !process.argv[3]) continue;
    console.log(e.type, "|", e.audience ?? "", "|", String(e.line ?? e.text ?? "").slice(0, 220));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
