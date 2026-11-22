const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-8/scripts/bench/recorder.cjs");
const calls = R.modelCalls("review-d1109-oversize-pause", "specialist");
const shop = calls.filter((c) => JSON.stringify(c.messages?.[0] ?? "").includes("Build the shop page in shop.html"));
console.log("shop calls", shop.length);
const told = shop.filter((c) => JSON.stringify(c.messages ?? []).includes("Wrap up now:"));
console.log("calls that carry the wrap-up", told.length);
const first = told[0];
if (first) {
  const s = JSON.stringify(first.messages);
  const i = s.indexOf("Wrap up now:");
  console.log("WRAP:", s.slice(i, i + 760));
  console.log("count in that request", s.split("Wrap up now:").length - 1);
  const brief = JSON.stringify(first.messages[0]);
  const j = brief.indexOf("If Forerunner tells you to wrap up");
  console.log("BRIEF LINE:", brief.slice(j, j + 640));
}
// the continuing run's brief: kept checks lines
const cont = shop.find((c) => JSON.stringify(c.messages?.[0] ?? "").includes("## Where the last run stopped"));
if (cont) {
  const b = JSON.stringify(cont.messages[0]);
  const k = b.indexOf("## Where the last run stopped");
  console.log("WHERE:", b.slice(k, k + 1400));
}
