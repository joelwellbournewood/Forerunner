// Starts the review bench on the Messages API stand-in with a refused key.
const { spawnSync } = require("node:child_process");
const repo = "/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7";
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
    "bench-api",
    "--api-key",
    "refused",
  ],
  { cwd: repo, stdio: "inherit" },
);
process.exit(r.status ?? 1);
