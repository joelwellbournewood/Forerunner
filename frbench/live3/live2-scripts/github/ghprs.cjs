// usage: node ghprs.cjs <label> <n> [n...]  -> saves PR state (head sha, base, body, files, commits, merged) to evidence/<label>.json
const { gh, save } = require("./h.cjs");
(async () => {
  const [label, ...nums] = process.argv.slice(2);
  const out = {};
  for (const n of nums) {
    const p = (await gh("GET", "/pulls/" + n)).body;
    const files = (await gh("GET", "/pulls/" + n + "/files?per_page=100")).body.map((f) => f.filename + " " + f.status + " +" + f.additions + "-" + f.deletions);
    const commits = (await gh("GET", "/pulls/" + n + "/commits?per_page=100")).body.map((c) => c.sha.slice(0, 10) + " parents=" + c.parents.length + " " + c.commit.message.split("\n")[0]);
    const comments = (await gh("GET", "/issues/" + n + "/comments?per_page=100")).body.map((c) => c.created_at + " " + c.body.slice(0, 400));
    out[n] = { title: p.title, state: p.state, merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha, mergeable: p.mergeable, mergeable_state: p.mergeable_state, head: p.head.ref + "@" + p.head.sha, base: p.base.ref, body: p.body, files, commits, comments };
    console.log("#" + n, p.state, p.merged ? "merged" : "", "head", p.head.sha.slice(0, 10), "base", p.base.ref, "mergeable", p.mergeable, p.mergeable_state, "| files:", files.join("; "), "| commits:", commits.length);
  }
  console.log("saved", save(label + ".json", out));
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
