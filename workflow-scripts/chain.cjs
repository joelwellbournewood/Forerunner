// Regression probe: the session-engine journey's (a) "one Start runs every task of the chain"
// on a bench started with FORERUNNER_BENCH_PLAN=chain, through the daemon API.
"use strict";
const REPO = process.argv[2] || "/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-8";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const NAME = process.argv[3] || "review-bench";
(async () => {
  const chain = await R.createPlannedProject(NAME, {
    project: `Chain page ${new Date().toISOString().slice(11, 19)}`,
    goal: "A page built in seven steps",
    brief: "A one-page website that shows today's date and a greeting; plain HTML",
  });
  console.log(`tasks: ${chain.tasks.length}`);
  const started = await R.startSession(NAME, chain.projectId);
  const sid = started.session?.id;
  const end = await R.waitForSession(NAME, sid, 600_000);
  const tasks = await R.api(NAME, "GET", `/projects/${encodeURIComponent(chain.projectId)}/tasks`);
  const list = Array.isArray(tasks) ? tasks : tasks.tasks;
  for (const t of list) console.log(`${t.status.padEnd(12)} ${t.title}  ${t.reason ?? ""}`.slice(0, 220));
  console.log("session:", end.status, JSON.stringify(end.summary));
  const reviews = await R.api(NAME, "GET", `/projects/${encodeURIComponent(chain.projectId)}/reviews`);
  for (const r of (Array.isArray(reviews) ? reviews : reviews.reviews ?? []).filter((x) => x.verdict !== "accept"))
    console.log("sent back:", r.taskTitle, "|", r.summary, "|", JSON.stringify(r.evidence).slice(0, 300));
  const done = list.filter((t) => t.status === "done").length;
  console.log(`one Start runs every task of the chain: ${done === list.length} (${done} of ${list.length})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
