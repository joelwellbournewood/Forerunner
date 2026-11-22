// Cancel the task the wake loop keeps starting, then confirm no new session starts.
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-4/scripts/bench/recorder.cjs");
const NAME = "review-budget-resume";
(async () => {
  const { project, task } = JSON.parse(fs.readFileSync("/tmp/frbench/review-budget-resume/walk4.json", "utf8"));
  await R.until(async () => {
    const l = await R.api(NAME, "GET", `/sessions?projectId=${project}`);
    const all = Array.isArray(l) ? l : l.sessions ?? [];
    return all.every((s) => s.status !== "running") ? true : null;
  }, 60_000, 500, "no running session");
  const t = (await R.api(NAME, "GET", `/projects/${project}/tasks`)).find((x) => x.id === task);
  const r = await R.api(NAME, "POST", `/tasks/${task}/action`, { version: t.version, action: "cancel" });
  console.log(JSON.stringify(r.change?.sentence ?? r));
  const l0 = await R.api(NAME, "GET", `/sessions?projectId=${project}`);
  console.log("sessions at cancel", (Array.isArray(l0) ? l0 : l0.sessions ?? []).length);
  await new Promise((res) => setTimeout(res, 65_000));
  const l = await R.api(NAME, "GET", `/sessions?projectId=${project}`);
  console.log("sessions 65 s later", (Array.isArray(l) ? l : l.sessions ?? []).length);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
