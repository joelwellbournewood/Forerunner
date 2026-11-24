// Puts wave 8's areas (from /tmp/frbench/wave8-plan.json, after its re-plan and four checks) into /tmp/frbench/phaseE.json,
// replacing any earlier copy of the same keys, and adds one triage entry per area problem tagged "(wave 8)". Idempotent.
const fs = require("fs");
const TAG = "(wave 8)";
const plan = JSON.parse(fs.readFileSync("/tmp/frbench/wave8-plan.json", "utf8"));
const P = "/tmp/frbench/phaseE.json";
const d = JSON.parse(fs.readFileSync(P, "utf8"));
const keys = new Set(plan.areas.map((a) => a.key));
d.areas = d.areas.filter((a) => !keys.has(a.key));
for (const a of plan.areas) d.areas.push(JSON.parse(JSON.stringify(a)));
d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
let n = 0;
for (const a of plan.areas) {
  for (const p of a.problems || []) {
    const s = typeof p === "string" ? p : JSON.stringify(p);
    const m = s.match(/^\[([^\]]+)\]\s*([^:]+):\s*/);
    const id = m ? m[2].trim() : `${a.key}-${++n}`;
    const never = m ? /never cut/i.test(m[1]) : false;
    d.triage.push({ n: id, item: s, decision: "fix", area: a.key, evidence: "wave8-plan.json (wave 8 re-plan wf_c1e0c5cc-9d7) and its inputs", note: `${TAG}${never ? " never cut" : ""}` });
  }
}
if (plan.shared_files) d.shared_files_wave8 = plan.shared_files;
fs.writeFileSync(P, JSON.stringify(d, null, 1));
console.log("areas", plan.areas.length, "triage", d.triage.filter((t) => String(t.note).includes(TAG)).length);
