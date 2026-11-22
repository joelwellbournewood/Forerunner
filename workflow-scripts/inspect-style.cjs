const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
const title = process.argv[2] || "Style the page in styles.css";
const project = process.argv[3] || "Chess";
const calls = R.modelCalls("review-continuity", "specialist").filter(
  (c) =>
    String(c.messages?.[0]?.content ?? "").includes(title) &&
    String(c.messages?.[0]?.content ?? "").includes(project),
);
console.log("calls", calls.length);
const last = calls.at(-1);
for (const m of last.messages.slice(1)) {
  const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  for (const p of parts) {
    if (p.type === "tool_result") console.log("RESULT:", JSON.stringify(p.content).slice(0, 700));
    if (p.type === "tool_use") console.log("USE:", p.name, JSON.stringify(p.input).slice(0, 200));
  }
}
