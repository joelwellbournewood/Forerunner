// fixup-d1109-onerepo-join bench: "Kite club" on bench/seeded (planned, worked by one session,
// status pull request on), "Site" without a repository; the pair is then made through the
// database (fj-pair-db.mjs) as before one repository was one project.
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-4";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fixup-d1109-onerepo-join";

(async () => {
  const created = await R.api(N, "POST", "/projects", {
    name: "Kite club",
    goal: "A page for the kite club",
    brief: "A one-page site for a kite club.",
    repos: ["bench/seeded"],
    intake: true,
  });
  const kite = created.id;
  const pending = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/projects/${kite}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    120_000,
    1000,
    "the intake's plan",
  );
  const inbox = await R.api(N, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.id === pending.requestId);
  await R.api(N, "POST", `/requests/${card.id}/answer`, { version: card.version, answer: "approve" });
  const sessions = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/sessions?projectId=${kite}`).catch(() => null);
      const list = Array.isArray(s) ? s : (s?.sessions ?? []);
      return list.length ? list : null;
    },
    60_000,
    1000,
    "Kite club's session",
  );
  for (const s of sessions) await R.waitForSession(N, s.id).catch((e) => console.log("wait", String(e)));
  const site = await R.api(N, "POST", "/projects", { name: "Site", goal: "The club's site" });
  fs.writeFileSync(`/tmp/frbench/${N}/pair.json`, JSON.stringify({ site: site.id, kite }, null, 2));
  const tasks = await R.api(N, "GET", `/projects/${kite}/tasks`);
  console.log("ok", kite, site.id, JSON.stringify(tasks.map((t) => [t.title, t.status, t.prUrl])));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
