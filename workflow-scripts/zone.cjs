// A session on the API key, then the session page, the Sessions tab and Costs in a browser whose
// zone (UTC) differs from the person's (Europe/Zurich): L4-creds-20 and L4-creds-25's By credential.
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[2];
const label = process.argv[3] || "before";
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const { DatabaseSync } = require("node:sqlite");
const N = "fix-l4-cred-screens";
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const db = new DatabaseSync(path.join(bench.home, "data", "state.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");
function setPolicy(p) {
  const h = db.prepare("select id, notify_prefs from human").get();
  db.prepare("update human set notify_prefs = ?, timezone = 'Europe/Zurich' where id = ?").run(
    JSON.stringify({ ...JSON.parse(h.notify_prefs), credential_policy: p }),
    h.id,
  );
}
(async () => {
  setPolicy("key_then_subscription");
  const p = await R.api(N, "POST", "/projects", { name: `Zone notes ${label}`, goal: "Zone goal" });
  await R.api(N, "POST", `/projects/${p.id}/tasks`, {
    title: "Write the zone notes in zone.md",
    outcome: "zone.md is written",
    acceptanceCriteria: ["zone.md exists"],
  });
  const started = await R.startSession(N, p.id);
  const sid = started.session?.id ?? started.sessionId;
  const out = { started, sid };
  if (sid) out.session = await R.waitForSession(N, sid, 240_000).catch((e) => String(e));
  const { browser, page } = await R.openApp(N, { path: `/sessions/${sid}` });
  out.browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  out.sessionPage = await R.step(page, `${label}-z-session-page-zone`, { waitMs: 2000 });
  await page.goto(`${bench.uiUrl}/projects/${p.id}/sessions`, { waitUntil: "domcontentloaded" });
  out.sessionsTab = await R.step(page, `${label}-z-sessions-tab-zone`, { waitMs: 2000 });
  await page.goto(`${bench.uiUrl}/projects/${p.id}/costs`, { waitUntil: "domcontentloaded" });
  out.costs = await R.step(page, `${label}-z-costs-by-credential`, { waitMs: 2000 });
  out.costView = await R.api(N, "GET", `/projects/${p.id}/costs`).catch((e) => String(e));
  fs.writeFileSync(`/tmp/frbench/${N}/steps/${label}-zone.json`, JSON.stringify(out, null, 1));
  await browser.close();
  console.log(JSON.stringify({ browserZone: out.browserZone, sid, status: out.session?.status }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
