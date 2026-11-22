// Probes on the joined project: New task, a note for the next session, a start.
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-3/scripts/bench/recorder.cjs");
const N = "review-d1109-onerepo-join";
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
(async () => {
  const r = await R.apiRaw(N, "POST", `/projects/${pair.kite}/tasks`, {
    title: "Probe task on the joined project",
    outcome: "the probe file is written",
    riskTier: 1,
    specialist: "coder",
  });
  console.log("create task on joined:", r.status, JSON.stringify(r.body).slice(0, 500));
  const me = await R.api(N, "GET", "/me");
  const s = await R.apiRaw(N, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: pair.kite,
    trigger: "manual",
  });
  console.log("start on joined:", s.status, JSON.stringify(s.body).slice(0, 300));
  const prs = await R.api(N, "GET", `/projects/${pair.site}/pull-requests`);
  console.log("site prs", JSON.stringify(prs.waiting.map((w) => [w.number, w.kind, w.merge?.state])));
  const kt = await R.api(N, "GET", `/projects/${pair.kite}/tasks`);
  console.log("kite tasks", kt.map((t) => `${t.title}=${t.status}`));
  const st = await R.api(N, "GET", `/projects/${pair.site}/tasks`);
  console.log("site tasks", st.map((t) => `${t.title}=${t.status}`));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
