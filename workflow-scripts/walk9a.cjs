// Review walk 9a (R-dirtyworktree): a task on bench/seeded runs slowly; as soon as its worktree
// holds uncommitted files this script returns (the caller then crashes the daemon).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-3/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const N = "review-leftovers7-merge";
const DIR = "/tmp/frbench/review-leftovers7-merge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const project = await R.api(N, "POST", "/projects", { name: "Crash notes", goal: "Notes that survive a crash", repos: ["bench/seeded"] });
  const P = project.id;
  const t = await R.api(N, "POST", `/projects/${P}/tasks`, {
    title: "Write the notes in crash-notes.md",
    outcome: "crash-notes.md is written",
    specialist: "coder",
    riskTier: 1,
  });
  const T = t.task?.id ?? t.id;
  await R.startSession(N, P, "review walk 9a");
  const wt = `${DIR}/home/worktrees/${T}`;
  let status = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    if (fs.existsSync(`${wt}/.git`)) {
      try {
        status = execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" }).trim();
      } catch {}
      if (status) break;
    }
    await sleep(300);
  }
  fs.writeFileSync(`${DIR}/walk9.json`, JSON.stringify({ projectId: P, taskId: T, worktree: wt, dirtyBeforeCrash: status }, null, 2));
  console.log(JSON.stringify({ P, T, wt, status }));
})().catch((e) => {
  console.error("WALK FAILED", e);
  process.exit(1);
});
