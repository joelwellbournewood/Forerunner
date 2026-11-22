"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-5/scripts/bench/recorder.cjs");
const N = "review-d1109-oversize-start";
(async () => {
  const pid = process.argv[2];
  const budget = process.argv[3];
  const c = await R.api(
    N,
    "GET",
    `/projects/${pid}/start-check${budget ? `?budgetUsdMicro=${budget}` : ""}`,
  );
  console.log(
    JSON.stringify(
      {
        sessionBudget: c.sessionBudget,
        workBudget: c.workBudget,
        runnable: c.runnable,
        overBudget: c.overBudget,
        oversized: c.oversized,
        blocked: c.blocked,
        busy: c.busy,
      },
      null,
      1,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
