const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2] || "/tmp/frbench/review-web-search/home/data/state.sqlite", { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
const t = tables.find((n) => n === "run") || tables.find((n) => /^runs?$/.test(n));
if (!t) {
  console.log(tables.join(" "));
  process.exit(0);
}
const cols = db.prepare(`pragma table_info(${t})`).all().map((c) => c.name);
const order = cols.includes("started_at") ? "started_at" : "rowid";
for (const r of db.prepare(`select * from ${t} order by ${order}`).all())
  console.log(r.specialist, r.outcome ?? r.status, r.cost_usd_micro, String(r.artifacts).replace(/"webSources":\[[^\]]*\]/, "webSources:[..]").slice(0, 300));
