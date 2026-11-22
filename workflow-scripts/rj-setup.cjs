// Review bench setup: "Kite club" on bench/seeded runs a session (task PR, status PR); "Site" is
// made without a repository and gets a task; the repos column of Site is set afterwards (DB edit,
// daemon restarted) to make a pair "made before the rule".
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-3";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "review-d1109-onerepo-join";
const OUT = `/tmp/frbench/${N}/pair.json`;

(async () => {
  const kite = await R.api(N, "POST", "/projects", {
    name: "Kite club",
    goal: "A page for the kite club",
    repos: ["bench/seeded"],
  });
  console.log("kite", kite.id, kite.repos);
  const on = await R.api(N, "POST", "/commands/execute", {
    commands: [
      { name: "settings.set", params: { key: "status_pull_request", value: true, project: kite.id } },
    ],
    source: "ui",
    confirm: "tap",
  });
  console.log("status pr on", on.status);
  const t1 = await R.api(N, "POST", `/projects/${kite.id}/tasks`, {
    title: "Write the club notes in club-notes.md",
    outcome: "club-notes.md says when the club meets",
    riskTier: 1,
    specialist: "coder",
  });
  console.log("kite task", JSON.stringify(t1).slice(0, 200));
  const s = await R.startSession(N, kite.id);
  const sid = s.session?.id ?? s.sessionId ?? s.id;
  console.log("kite session", sid, JSON.stringify(s).slice(0, 200));
  const ended = await R.waitForSession(N, sid, 240_000);
  console.log("kite session ended", ended.status);
  const site = await R.api(N, "POST", "/projects", { name: "Site", goal: "The club's web site" });
  console.log("site", site.id);
  const t2 = await R.api(N, "POST", `/projects/${site.id}/tasks`, {
    title: "Write the opening hours in hours.md",
    outcome: "hours.md lists the opening hours",
    riskTier: 1,
    specialist: "coder",
  });
  console.log("site task", JSON.stringify(t2).slice(0, 200));
  fs.writeFileSync(OUT, JSON.stringify({ kite: kite.id, site: site.id }, null, 2));
  const prs = await R.api(N, "GET", `/projects/${kite.id}/pull-requests`).catch((e) => String(e));
  console.log("kite prs", JSON.stringify(prs).slice(0, 1500));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
