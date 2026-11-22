const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");
(async () => {
  const projects = await R.api("review-budget-stop", "GET", "/projects");
  const p = projects.find((x) => /Review month cap \(n\)/.test(x.name));
  const s = await R.startSession(
    "review-budget-stop",
    p.id,
    "reviewer: a start with no typed budget (as a schedule or the chat)",
  );
  console.log(JSON.stringify({ project: p.id, session: s.session?.id, status: s.session?.status }));
  const done = await R.waitForSession("review-budget-stop", s.session.id, 300000);
  console.log(JSON.stringify({ status: done.status, summary: done.summary }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
