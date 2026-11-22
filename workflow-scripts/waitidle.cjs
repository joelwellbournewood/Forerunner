const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-10/scripts/bench/recorder.cjs");
(async () => {
  await R.until(
    async () => {
      const ss = await R.api("fixup-polish-screens", "GET", "/sessions");
      const list = Array.isArray(ss) ? ss : ss.sessions || [];
      return list.every((s) => !["running", "queued", "starting"].includes(s.status)) ? true : null;
    },
    300000,
    2000,
    "idle",
  );
  console.log("idle");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
