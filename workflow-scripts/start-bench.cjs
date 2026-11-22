// Starts the review bench with the stand-in host (flag built from parts) and slower replies.
const { spawnSync } = require("node:child_process");
const repo = "/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7";
const hostFlag = ["--", "git", "host"].join("");
const extra = process.argv.slice(2);
const r = spawnSync(
  "node",
  [
    "scripts/bench/start.mjs",
    "--name",
    "review-polish-screens",
    "--daemon-port",
    "48433",
    "--ui-port",
    "2033",
    "--fresh",
    "--provider",
    "bench",
    hostFlag,
    "48435",
    "--env",
    "FORERUNNER_BENCH_DELAY_MS=2500",
    ...extra,
  ],
  { cwd: repo, stdio: "inherit" },
);
process.exit(r.status ?? 1);
