// The project's newest session: wait for its end, print tasks and the session review lines.
// Usage: node sess.cjs <repo> <bench> <projectName>
const path = require("node:path");
const [repo, n, projectName] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
(async () => {
  const ps = await R.api(n, "GET", "/projects");
  const p = (ps.projects ?? ps).find((x) => x.name === projectName);
  const sid = await R.until(
    async () => (await R.api(n, "GET", `/sessions?projectId=${p.id}`))[0]?.id ?? null,
    60_000,
    1000,
    "a session",
  );
  await R.waitForSession(n, sid, 600_000);
  await new Promise((r) => setTimeout(r, 5000));
  const tasks = (await R.api(n, "GET", `/projects/${p.id}/tasks`)).map((t) => [t.title, t.status]);
  const ev = await R.api(n, "GET", `/sessions/${sid}/events?afterSeq=0`);
  const lines = (ev.events ?? ev)
    .filter((e) => /session_review/.test(e.type))
    .map((e) => ({ type: e.type, text: e.text, summary: e.payload?.summary, metrics: e.payload?.metrics }));
  console.log(JSON.stringify({ projectId: p.id, sid, tasks, lines }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
