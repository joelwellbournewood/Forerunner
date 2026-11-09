// usage: node st.cjs <projectName>  -> prints sessions, tasks, PR rows
const { R, N } = require("./h.cjs");
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const list = projects.projects || projects;
  const p = list.find((x) => x.name === process.argv[2]);
  if (!p) { console.log("projects:", list.map((x) => x.name)); return; }
  console.log("project", p.id, "|", p.statusSentence || p.status || "");
  const s = await R.apiRaw(N, "GET", "/sessions?projectId=" + p.id);
  const ss = (s.body.sessions || s.body || []);
  for (const x of ss.slice(0, 4)) console.log(" session", x.id, x.status, x.stopReason || "", "spent", JSON.stringify(x.spentUsdMicro ?? x.spent), (x.summary || "").slice(0, 160));
  const t = await R.apiRaw(N, "GET", "/projects/" + p.id + "/tasks");
  for (const x of (t.body.tasks || t.body || [])) console.log(" task", x.id, x.status, "|", x.title.slice(0, 50), "|", (x.prUrl || "").replace(/.*pull\//, "#"), "| deps", (x.dependsOn||[]).map(d=>d.slice(-6)).join(","), "| $", x.actual && x.actual.usdMicro);
  const pr = await R.apiRaw(N, "GET", "/projects/" + p.id + "/pull-requests");
  if (process.argv[3] === "pr") console.log(JSON.stringify(pr.body, null, 1).slice(0, 6000));
  else console.log(" prs:", JSON.stringify(pr.body).slice(0, 1500));
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
