const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-3";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "review-d1109-onerepo-join";
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
(async () => {
  const s = await R.startSession(N, pair.site);
  const sid = s.session?.id;
  console.log("site session", s.result, sid);
  if (sid) console.log("ended", (await R.waitForSession(N, sid, 240_000)).status);
  for (const id of [pair.site, pair.kite]) {
    const prs = await R.api(N, "GET", `/projects/${id}/pull-requests`);
    console.log(id === pair.site ? "SITE" : "KITE", JSON.stringify(prs.waiting.map((w) => ({ k: w.kind, n: w.number, b: w.branch, t: w.title }))));
    const card = await R.api(N, "GET", `/projects/${id}`);
    console.log(" shares:", JSON.stringify(card.sharesRepositoryWith), "status:", card.statusLine?.text);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
