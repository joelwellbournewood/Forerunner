const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
(async () => {
  const inbox = await R.api("review-continuity", "GET", "/inbox");
  for (const r of inbox.requests.filter((r) => r.status === "open"))
    console.log(
      JSON.stringify({
        id: r.id,
        title: r.title,
        body: r.body,
        project: r.projectName ?? r.projectId,
        task: r.taskId,
        choices: (r.choices ?? []).map((c) => `${c.label} — ${c.explain}`),
      }),
    );
})();
