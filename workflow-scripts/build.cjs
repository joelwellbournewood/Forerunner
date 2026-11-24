const path = require("path");
const d = __dirname;
const { meta, carried_decisions, stays } = require(path.join(d, "p1.cjs"));
const { changes, shrinks } = require(path.join(d, "p2.cjs"));
const { goes, new_work, amendments, notes } = require(path.join(d, "p3.cjs"));
const old = require("/tmp/frbench/collab/collab-areas.json");
const areas = [...stays, ...changes, ...shrinks, ...goes];
const oldKeys = old.areas.map(a => a.key).sort();
const newKeys = areas.map(a => a.old_key).sort();
if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) { console.error("key mismatch", oldKeys, newKeys); process.exit(1); }
const counts = {};
for (const a of areas) {
  counts[a.verdict] = (counts[a.verdict] || 0) + 1;
  for (const f of ["old_key","verdict","new_scope","kept_problems","kept_acceptance","kept_tests","dropped"]) if (!(f in a)) { console.error("missing", f, a.old_key); process.exit(1); }
  for (const x of a.dropped) if (!x.what || !x.why) { console.error("bad dropped", a.old_key); process.exit(1); }
  a.old_order = old.areas.findIndex(o => o.key === a.old_key) + 1;
}
console.log(counts);
if (counts.stays !== 4 || counts.changes !== 6 || counts.shrinks !== 1 || counts.goes !== 5) { console.error("totals off"); process.exit(1); }
const ams = require("/tmp/frbench/runC-plan.json").wave8_amendments;
if (ams.length !== amendments.length) { console.error("amendments count", ams.length, amendments.length); process.exit(1); }
amendments.forEach((a, i) => { if (a.index !== i) { console.error("index", i); process.exit(1); } a.text_head = ams[i].slice(0, 160); });
const out = { ...meta, carried_decisions, areas, new_work, amendments, notes };
const s = JSON.stringify(out, null, 1);
if (/\$\{/.test(s)) { console.error("template leak"); process.exit(1); }
require("fs").writeFileSync("/tmp/frbench/wave8-oldplan-mapped.json", s + "\n");
console.log("bytes", s.length, "areas", areas.length, "new_work", new_work.length, "amendments", amendments.length);
