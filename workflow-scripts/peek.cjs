const L = require("./walk-lib.cjs");
const { R, N } = L;
(async () => {
  for (const id of process.argv.slice(2)) {
    const s = await R.api(N, "GET", `/sessions/${encodeURIComponent(id)}`);
    console.log(id, JSON.stringify(s.summary));
  }
  const sessions = L.q("select id, project_id, status, summary from session order by started_at");
  console.log(JSON.stringify(sessions.map((s) => [s.id.slice(-6), s.status, s.summary.slice(0, 80)])));
  const notes = (await R.api(N, "GET", "/notifications/recent?limit=50")).notifications ?? [];
  console.log(JSON.stringify(notes.map((n) => [n.kind, n.title, n.body])));
})();
