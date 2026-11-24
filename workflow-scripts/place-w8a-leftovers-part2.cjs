// Applies /tmp/frbench/w8a-leftovers-routed.json (routing workflow wf_b5e59eaf-846, checked and revised) to wave8-plan.json
// and phaseE.json: each item into its target area's problems and items (and a triage entry), the area_additions into the
// area's files and size notes, and the shared_files_amendments (by rule index) into shared_files. Phase H items go to
// leftovers-phaseH.json and session-lead items to phaseG-notes.json. Idempotent: tagged "(W8a leftovers)".
const fs = require("fs");
const TAG = "(W8a leftovers)";
const R = JSON.parse(fs.readFileSync("/tmp/frbench/w8a-leftovers-routed.json", "utf8"));
const SRC = "Sources: /tmp/frbench/w8a-leftovers-routed.json (routing wf_b5e59eaf-846, checked) and runW8-W8a-*.json.";
const line = (i) => `[${i.severity}${i.never_cut ? ", never cut" : ""}${i.for_reviewer ? ", for the reviewer" : ""}] ${i.id}: ${i.text} ${TAG} ${SRC}`;
const toAreas = R.items.filter((i) => !["phase-H", "session-lead"].includes(i.target));
for (const P of ["/tmp/frbench/wave8-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  for (const a of d.areas.filter((x) => String(x.key).startsWith("w8-"))) {
    const mine = toAreas.filter((i) => i.target === a.key);
    a.problems = a.problems.filter((p) => !String(p).includes(TAG) || /W8a-left-[12]:/.test(String(p))).concat(mine.map(line));
    a.items = a.items.filter((x) => !/^W8a-left-(\d+)$/.test(x) || ["W8a-left-1", "W8a-left-2"].includes(x)).concat(mine.map((i) => i.id));
    const add = R.area_additions && R.area_additions[a.key];
    if (add) {
      const files = Array.isArray(a.files) ? a.files : [String(a.files)];
      a.files = files.filter((f) => !String(f).includes(TAG)).concat(add.files ? [`${add.files} ${TAG}`] : []);
      if (add.size) a.size = String(a.size).replace(/ \| W8a leftovers: .*$/, "") + ` | W8a leftovers: ${add.size}`;
    }
  }
  const sfKey = P.endsWith("wave8-plan.json") ? "shared_files" : "shared_files_wave8";
  if (Array.isArray(d[sfKey])) {
    for (const am of R.shared_files_amendments || []) {
      const m = String(am.rule).match(/shared_files\[(\d+)\]/);
      if (m && d[sfKey][+m[1]] !== undefined && typeof d[sfKey][+m[1]] === "string" && d[sfKey][+m[1]] === am.old) d[sfKey][+m[1]] = am.new;
      else if (m && d[sfKey][+m[1]] !== am.new) console.log("shared_files", sfKey, am.rule, "did not match its old text; appended as a note");
      if (m && d[sfKey][+m[1]] !== am.new && !d[sfKey].includes(`${am.new} ${TAG}`)) d[sfKey].push(`${am.new} ${TAG}`);
    }
  }
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !(String(t.note || "").includes(TAG) && !/^W8a-left-[12]$/.test(t.n)));
    for (const i of toAreas) d.triage.push({ n: i.id, item: `${i.id}: ${i.text}`, decision: "fix", area: i.target, evidence: SRC, note: `${TAG}${i.never_cut ? " never cut" : ""}${i.for_reviewer ? " for the reviewer" : ""}` });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
const H = "/tmp/frbench/leftovers-phaseH.json";
const h = fs.existsSync(H) ? JSON.parse(fs.readFileSync(H, "utf8")) : { why: "Phone-round (phase H) leftovers collected during the desktop round.", items: [] };
h.items = h.items.filter((x) => !String(x.id).startsWith("W8a-left-")).concat(R.items.filter((i) => i.target === "phase-H"));
fs.writeFileSync(H, JSON.stringify(h, null, 1));
const G = "/tmp/frbench/phaseG-notes.json";
const g = fs.existsSync(G) ? JSON.parse(fs.readFileSync(G, "utf8")) : { why: "Session-lead items for phase G (UPDATE-LOG, CHANGELOG, requirements, live checks).", items: [] };
g.items = g.items.filter((x) => !String(x.id).startsWith("W8a-left-")).concat(R.items.filter((i) => i.target === "session-lead"));
fs.writeFileSync(G, JSON.stringify(g, null, 1));
const by = {}; for (const i of R.items) by[i.target] = (by[i.target] || 0) + 1;
console.log("applied", JSON.stringify(by));
