// usage: node wait-idle.cjs <projectName> [maxSec]  -> waits until no session of the project runs
const { R, N, log } = require("./h.cjs");
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const p = (projects.projects || projects).find((x) => x.name === process.argv[2]);
  const max = Number(process.argv[3] || 900) * 1000;
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < max) {
    const s = await R.apiRaw(N, "GET", "/sessions?projectId=" + p.id);
    const ss = s.body.sessions || s.body || [];
    const run = ss.filter((x) => x.status === "running" || x.status === "starting");
    const t = await R.apiRaw(N, "GET", "/projects/" + p.id + "/tasks");
    const st = (t.body || []).map((x) => x.status[0] + x.status.slice(1, 4)).join(",");
    const line = run.length + " running; tasks " + st;
    if (line !== last) { log(line); last = line; }
    if (!run.length) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
