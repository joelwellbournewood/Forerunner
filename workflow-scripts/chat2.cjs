const R = require("/home/user/Forerunner/.claude/worktrees/wf_dbd51cc4-c3a-7/scripts/bench/recorder.cjs");
(async () => {
  const N = "review-cost";
  const me = await R.api(N, "GET", "/me");
  const ps = await R.api(N, "GET", "/projects");
  const p = ps[0];
  for (const text of ["What is the state of the project?", "Which files did the coder write?", "Is there anything left to do?"]) {
    const r = await R.api(N, "POST", "/chat", { humanId: me.id, agentId: me.agent.id, projectId: p.id, projectTab: true, text, source: "text" });
    console.log(JSON.stringify(r).slice(0, 160));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
