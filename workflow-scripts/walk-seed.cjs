// Seeds the bench with 21 ended sessions of one project (real sessions through the API).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-8/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-d1109-sessions";
const OUT = "/tmp/frbench/fixup-d1109-sessions-evidence";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const p = await R.api(N, "POST", "/projects", { name: "Many sessions", goal: "Many small pages" });
  const pid = p.id;
  const ids = [];
  for (let i = 0; i < 21; i++) {
    await R.api(N, "POST", `/projects/${pid}/tasks`, {
      title: `Write page ${i + 1} in page${i + 1}.html`,
      outcome: `page${i + 1}.html exists`,
      riskTier: 1,
      specialist: "coder",
    });
    const s = await R.startSession(N, pid);
    const id = s.session?.id;
    if (!id) throw new Error(`no session: ${JSON.stringify(s)}`);
    const ended = await R.waitForSession(N, id);
    ids.push(id);
    console.log(i + 1, id, ended.status);
  }
  fs.writeFileSync(`${OUT}/seed.json`, JSON.stringify({ projectId: pid, sessions: ids }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
