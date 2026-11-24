const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const n = process.argv[2];
(async () => {
  const projects = await R.api(n, "GET", "/projects");
  const out = {};
  for (const p of projects.projects ?? projects) {
    const card = await R.api(n, "GET", `/projects/${p.id}`);
    const prs = await R.api(n, "GET", `/projects/${p.id}/pull-requests`);
    out[p.name] = {
      repositoryElsewhere: card.repositoryElsewhere ?? null,
      waiting: prs.waiting.map((r) => `${r.kind} #${r.number} ${r.title} rebuilt=${r.rebuilt ?? false}`),
    };
    // A second Try again / a Close on a gone row through the routes.
    if (p.name === "Kite flyers")
      out[p.name].retryAgain = await R.apiRaw(n, "POST", `/projects/${p.id}/take-over/retry`, {});
    if (p.name === "Kite club") {
      out[p.name].closeAgain = await R.apiRaw(n, "POST", `/projects/${p.id}/pull-requests/2/close`, {});
      out[p.name].closeBad = await R.apiRaw(n, "POST", `/projects/${p.id}/pull-requests/abc/close`, {});
      out[p.name].closeDone = await R.apiRaw(n, "POST", `/projects/${p.id}/pull-requests/3/close`, {});
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
