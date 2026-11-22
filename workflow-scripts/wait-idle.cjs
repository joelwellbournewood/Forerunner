const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
(async () => {
  await R.until(async () => {
    const s = await R.api(N, "GET", "/sessions");
    const live = s.filter((x) => ["running", "paused", "planned"].includes(x.status));
    return live.length === 0 ? true : null;
  }, Number(process.argv[2] || 300000), 1000, "no running session");
  const s = await R.api(N, "GET", "/sessions");
  console.log(JSON.stringify(s.slice(0, 6).map((x) => [x.id, x.projectId, x.status, x.stopReason, (x.summary || "").slice(0, 120)]), null, 1));
})().catch((e) => { console.error(String(e)); process.exit(1); });
