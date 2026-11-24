// Collects run L4 sub-run L4i's leftovers from its saved stage reports into /tmp/frbench/leftovers-L4i.json,
// with the session lead's routing for each class. Read-only on the reports.
const fs = require("fs");
const R = (f) => { const v = JSON.parse(fs.readFileSync(f, "utf8")); return typeof v === "string" ? JSON.parse(v) : v; };
const keys = ["l4-starts-carried", "l4-chat-final", "l4-github-carried"];
const out = [];
for (const k of keys) {
  for (const st of ["fix", "review", "fixup"]) {
    const f = `/tmp/frbench/runL4-L4i-${st}-${k}.json`;
    if (!fs.existsSync(f)) continue;
    const o = R(f);
    for (const n of o.not_done || []) out.push({ area: k, stage: st, kind: "not_done", text: typeof n === "string" ? n : `${n.problem} — why: ${n.why}` });
    for (const n of o.new_problems || []) out.push({ area: k, stage: st, kind: "new_problem", text: typeof n === "string" ? n : JSON.stringify(n) });
    if (st === "review") for (const n of o.non_blocking || []) out.push({ area: k, stage: st, kind: "review_non_blocking", text: typeof n === "string" ? n : JSON.stringify(n) });
  }
}
const merge = R("/tmp/frbench/runL4-L4i-merge.json");
const routing = {
  never_cut: [
    "Phone plain 'start' (remote watcher, kind start) goes straight to scheduler.requestStart and skips POST /sessions' refusals (nothing runnable, a budget above the monthly cap, the one-wait rule): money rule. Route: phase H (the phone), never cut; wave 8 may take it if its area touches the remote watcher.",
    "W15-01's sole-linked rule: an unmarked open fr/docs-scaffold pull request of another project counts as this project's own when this project is the only one linked to the repository, so the scaffold and Try again write into it. Writing into another project's pull request breaks wave 8's 'Never' rule. Route: wave 8, never cut.",
  ],
  early: [
    "UpdatesPage.tsx:136 sends `me?.id ?? \"human\"`: a press before /me has loaded answers as 'human' (attribution), and e2e/updates.spec.ts failed once on this race. Route: wave 8's first group (a flaky UI test source).",
  ],
  decided: [
    "Assisted chat task_create description read-back: decided by the L4h-left-1 rule (session lead 2026-11-24): a description whose words are in the person's own message is the person's and is not read back; one the model wrote is read back.",
  ],
  phase_h: ["Phone Inbox renders <Badge>{message.type}</Badge> (apps/ui/src/mobile/screens/InboxScreen.tsx:240): the raw type 'warning' shows on the phone (desktop fixed in 0a16759)."],
};
fs.writeFileSync("/tmp/frbench/leftovers-L4i.json", JSON.stringify({ why: "Run L4 sub-run L4i's leftovers (merged and pushed at c15d75e). Run L4 is complete; these go to the wave 8 planner (an L4 leftovers area in its plan, sized there) and to phase H.", base: "c15d75e", routing, merge_problems_left: merge.problems_left, items: out }, null, 1));
const by = {}; for (const i of out) by[i.area + "/" + i.kind] = (by[i.area + "/" + i.kind] || 0) + 1;
console.log(out.length, JSON.stringify(by));
