const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-1/scripts/bench/recorder.cjs");
const N = "fix-d1109-onerepo-link";
(async () => {
  const me = await R.api(N, "GET", "/me");
  const ps = await R.api(N, "GET", "/projects");
  const site = ps.find((p) => p.name === "Site");
  const chat = await R.apiRaw(N, "POST", "/chat", {
    humanId: me.id,
    agentId: me.agent.id,
    projectId: site.id,
    text: 'tool: project_create {"name":"Shop two","goal":"g","repos":["bench/seeded"]}',
  });
  console.log("chat", chat.status, JSON.stringify(chat.body).slice(0, 900));
  const after = await R.api(N, "GET", "/projects");
  console.log("projects after chat", after.map((p) => `${p.name} ${JSON.stringify(p.repos)}`));
})();
