// Builds the triage inputs for run L4 (the fix run after live check 4): /tmp/frbench/runL4/sources-<group>.json,
// one bundle per subsystem group, from live check 4's verified findings and step results and the run C / run L3
// leftovers files. Every source item lands in exactly one group (first matching rule), with a stable key.
const fs = require("fs");
const D = "/tmp/frbench/";
fs.mkdirSync(D + "runL4", { recursive: true });
const r = JSON.parse(fs.readFileSync(D + "live4/result.json", "utf8"));

const GROUPS = [
  ["selftasks", /selftasks|task.check|fix the tasks|fix_tasks|task-list/i],
  ["creds", /cred-|credential|person-zone|SDK driver|subscription|api key|ask card|refus/i],
  ["chat", /chat|recall|plain-words|conversation/i],
  ["github", /onerepo|l3-merge|merge-w|github|pull request|repositor|take.over|work together/i],
  ["money", /starts-engine|oversize|budget|sessions|run-visible|money|handoff|session-result|notification|estimate|costs?\b/i],
];
const groupOf = (text) => {
  for (const [g, re] of GROUPS) if (re.test(text)) return g;
  return "other";
};

const bundles = Object.fromEntries([...GROUPS.map((g) => g[0]), "other"].map((g) => [g, { live_findings: [], live_steps: [], leftovers: [] }]));

// Live check 4 findings with their verdicts.
for (const v of r.verified) {
  const f = v.finding;
  const d = v.verdict || {};
  const g = groupOf(`${d.area_hint || ""} ${f.title || ""} ${f.journey || ""}`);
  bundles[g].live_findings.push({ key: `live4:${f.id}`, finding: f, verdict: d });
}
// Live check 4 step results that did not pass (their observed text may hold problems without a finding).
for (const j of r.live) {
  for (const s of j.steps || []) {
    if (["pass", "recorded_earlier"].includes(s.result)) continue;
    const g = groupOf(`${j.journey} ${s.step || ""}`);
    bundles[g].live_steps.push({ key: `live4-step:${j.journey}:${s.id}`, journey: j.journey, pass: j.pass, ...s });
  }
}
// Leftovers files.
for (const f of fs.readdirSync(D).filter((x) => /^leftovers-.*\.json$/.test(x)).sort()) {
  const j = JSON.parse(fs.readFileSync(D + f, "utf8"));
  const tag = f.replace(/^leftovers-|\.json$/g, "");
  for (const it of j.items || []) {
    const g = groupOf(`${it.from || ""} ${it.text || ""}`);
    bundles[g].leftovers.push({ key: `${tag}:${it.id}`, file: D + f, ...it });
  }
}
const ownerChecklist = [];
for (const j of r.live) for (const x of j.owner_checklist_items || []) ownerChecklist.push({ journey: j.journey, pass: j.pass, item: x });

const summary = {};
for (const [g, b] of Object.entries(bundles)) {
  fs.writeFileSync(D + `runL4/sources-${g}.json`, JSON.stringify({ group: g, base: "4cf11fd", ...b }, null, 1));
  summary[g] = { live_findings: b.live_findings.length, live_steps: b.live_steps.length, leftovers: b.leftovers.length };
}
fs.writeFileSync(D + "runL4/owner-checklist-live4.json", JSON.stringify(ownerChecklist, null, 1));
console.log(JSON.stringify(summary), "owner checklist", ownerChecklist.length);
