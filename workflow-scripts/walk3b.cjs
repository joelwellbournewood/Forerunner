// What Bob's Forerunner wrote on the stand-in GitHub, the pull requests, the issues and comments.
const WT = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-5";
const R = require(`${WT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const A = "review-w8-together";
const B = "review-w8-together-bob";
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const ids = JSON.parse(
  fs.readFileSync("/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/walk/ids.json", "utf8"),
);
async function ghApi(login, path) {
  const r = await fetch(`${gh.url}${path}`, {
    headers: { authorization: `token ${gh.users[login].token}`, accept: "application/vnd.github+json" },
  });
  return r.json();
}
(async () => {
  const ss = await R.api(B, "GET", `/sessions?projectId=${ids.kite}`).catch((e) => String(e));
  console.log("sessions", JSON.stringify(ss).slice(0, 300));
  const reqs = fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const bobW = reqs.filter(
    (r) => r.login === "bob" && !["GET", "HEAD"].includes(r.method) && !/git-upload-pack/.test(r.path ?? ""),
  );
  console.log("bob writes (all)", bobW.map((r) => `${r.method} ${r.path}${r.operation ? ` ${r.operation}` : ""}`));
  const prs = await ghApi("ada", "/repos/team/shared/pulls?state=all");
  console.log("prs", JSON.stringify(prs.map((p) => [p.number, p.state, p.head.ref, p.user?.login, p.title])));
  const issues = await ghApi("ada", "/repos/team/shared/issues?state=all");
  for (const i of issues) {
    if (i.pull_request) continue;
    console.log("issue", i.number, i.title, i.user?.login);
    const cs = await ghApi("ada", `/repos/team/shared/issues/${i.number}/comments`);
    for (const c of cs) console.log("  comment by", c.user?.login, JSON.stringify(c.body).slice(0, 900));
  }
})();
