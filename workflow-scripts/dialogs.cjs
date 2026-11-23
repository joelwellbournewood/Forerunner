// Re-shoot the Start dialogs of the before walk (the first pass missed the button's name).
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
const src = (kind) =>
  db
    .prepare("select id, kind, limits from billing_source")
    .all()
    .find((s) => s.kind === kind);
function setLimits(kind, fn) {
  const s = src(kind);
  db.prepare("update billing_source set limits = ? where id = ?").run(
    JSON.stringify(fn(JSON.parse(s.limits || "{}"))),
    s.id,
  );
}
function setPolicy(p) {
  const h = db.prepare("select id, notify_prefs from human").get();
  db.prepare("update human set notify_prefs = ? where id = ?").run(
    JSON.stringify({ ...JSON.parse(h.notify_prefs), credential_policy: p }),
    h.id,
  );
}
const iso = (ms) => new Date(ms).toISOString();
async function dialog(page, projectId, what) {
  await page.goto(`${bench.uiUrl}/projects/${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const start = page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first();
  if (await start.count()) await start.click().catch(() => undefined);
  await page.waitForTimeout(1500);
  const t = await R.step(page, what);
  await page.keyboard.press("Escape").catch(() => undefined);
  return t;
}
(async () => {
  const walk = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/steps/before-walk.json`, "utf8"));
  const { browser, page } = await R.openApp(N);
  setPolicy("subscription_then_ask");
  setLimits("subscription", (l) => ({ ...l, restingUntil: iso(Date.now() + 2 * 3600_000) }));
  await dialog(page, walk.projectA.id, `${label}-a-start-dialog-kept-start`);
  await page.goto(`${bench.uiUrl}/projects/${walk.projectA.id}`, { waitUntil: "domcontentloaded" });
  await R.step(page, `${label}-a-overview-kept-start`, { waitMs: 1500 });
  await dialog(page, walk.projectB.id, `${label}-b2-start-dialog-ask`);
  setPolicy("key_then_subscription");
  setLimits("subscription", (l) => {
    const { restingUntil, ...r } = l;
    return r;
  });
  setLimits("api_key", (l) => ({ ...l, restingUntil: iso(Date.now() + 3600_000) }));
  await dialog(page, walk.projectB.id, `${label}-b-start-dialog-key-rests`);
  setLimits("api_key", (l) => {
    const { restingUntil, ...r } = l;
    return r;
  });
  setPolicy("subscription_then_ask");
  setLimits("subscription", (l) => ({ ...l, refusedAt: iso(Date.now()) }));
  await dialog(page, walk.projectB.id, `${label}-c-start-dialog-sub-refused`);
  setLimits("subscription", (l) => {
    const { refusedAt, ...r } = l;
    return r;
  });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
