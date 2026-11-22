// Small API probe of the review bench: node probe.cjs METHOD ROUTE [jsonBody]
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
(async () => {
  const [method, route, body] = process.argv.slice(2);
  const r = await R.apiRaw("review-polish-screens", method, route, body ? JSON.parse(body) : undefined);
  console.log(r.status);
  console.log(JSON.stringify(r.body, null, 1).slice(0, Number(process.env.MAX || 6000)));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
