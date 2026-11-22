const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
(async () => {
  const name = process.argv[2];
  const r = await R.createPlannedProject(N, {
    project: name,
    goal: "A page that greets the visitor",
    brief: "A small web page in index.html with styles.css and script.js that greets the visitor by the time of day.",
    timeoutMs: 180000,
  });
  console.log(JSON.stringify({ projectId: r.projectId, tasks: r.tasks.map((t) => [t.title, t.status]) }));
})().catch((e) => { console.error(e); process.exit(1); });
