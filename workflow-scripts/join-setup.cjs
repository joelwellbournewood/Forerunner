// d1109-onerepo-join bench: two projects that work in one folder, made before one repository was
// one project. "Site" is made with the folder; "Kite club" is planned and worked (a session with
// the stand-in), then its row is given the same folder (as a project made before the rule).
const fs = require("node:fs");
const path = require("node:path");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-1";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fix-d1109-onerepo-join";
const B = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));

(async () => {
  const folder = `/tmp/frbench/${N}/work/site`;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "index.html"), "<h1>Site</h1>\n");
  const site = await R.api(N, "POST", "/projects", { name: "Site", goal: "The club's site", repos: [folder] });
  console.log("site", site.id, JSON.stringify(site.repos ?? null));
  const kite = await R.createPlannedProject(N, {
    project: "Kite club",
    goal: "A page for the kite club",
    brief: "A one-page site for a kite club.",
  });
  console.log("kite", kite.projectId, kite.tasks.length, "tasks");
  // Approve and start started a session: wait for it to end.
  const sessions = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/sessions?projectId=${encodeURIComponent(kite.projectId)}`).catch(() => null);
      const list = Array.isArray(s) ? s : s?.sessions ?? [];
      return list.length ? list : null;
    },
    60_000,
    1000,
    "Kite club's session",
  ).catch(() => []);
  for (const s of sessions) await R.waitForSession(N, s.id).catch((e) => console.log("wait", String(e)));
  fs.writeFileSync(
    `/tmp/frbench/${N}/pair.json`,
    JSON.stringify({ site: site.id, kite: kite.projectId, folder }, null, 2),
  );
  console.log("ok", JSON.stringify((await R.api(N, "GET", `/projects/${kite.projectId}/tasks`)).map((t) => t.status)));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
