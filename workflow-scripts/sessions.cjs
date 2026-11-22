const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
(async () => {
  const projectId = process.argv[2];
  const s = await R.api("review-continuity", "GET", `/sessions?projectId=${projectId}`);
  for (const x of s) console.log(JSON.stringify({ id: x.id.slice(0, 8), status: x.status, stop: x.stopReason, summary: x.summary }));
})();
