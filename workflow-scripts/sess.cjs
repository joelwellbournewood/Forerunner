"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-d1109-oversize-start";
(async () => {
  const key = process.argv[2];
  const walk = JSON.parse(fs.readFileSync("/tmp/frbench/review-d1109-oversize-start/walk1.json", "utf8"));
  const pid = key.includes("-") ? key : walk[key].project;
  const ss = await R.api(N, "GET", `/sessions?projectId=${pid}`);
  const list = Array.isArray(ss) ? ss : (ss.sessions ?? []);
  for (const s of list) {
    const d = await R.api(N, "GET", `/sessions/${s.id}`);
    console.log(
      JSON.stringify(
        { id: s.id, status: d.status, stopReason: d.stopReason, summary: d.summary, title: d.title },
        null,
        1,
      ),
    );
    const ev = await R.api(N, "GET", `/sessions/${s.id}/events`);
    for (const e of ev) console.log(`  [${e.audience}] ${e.type}: ${e.text}`);
  }
  const tasks = await R.api(N, "GET", `/projects/${pid}/tasks`);
  for (const t of Array.isArray(tasks) ? tasks : (tasks.tasks ?? []))
    console.log("TASK", t.title, "|", t.status, "|", JSON.stringify(t.statusText ?? t.statusWords ?? ""), "| spent", JSON.stringify(t.spent ?? t.actual ?? ""));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
