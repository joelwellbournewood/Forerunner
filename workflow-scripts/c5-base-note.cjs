const fs=require("fs");const f="/tmp/frbench/runC-C5-args.json";const a=JSON.parse(fs.readFileSync(f,"utf8"));
const anchor="Base c4583eb095c04e2c9ef1d10d451208cc546463e9 (sub-run C4b merged).";
if(!a.note.includes(anchor)) throw new Error("anchor");
const note=" Base note: c4583eb is the merge of fix/d1116-budget-all (C4b), with CI and the Desktop app workflow on Windows and Linux green before this run started. C4b had no fix-up (its review passed with nothing blocking), so its notes_for_other_areas are in /tmp/frbench/runC-C4b-fix-d1116-budget-all.json: read them before you touch runner.ts, executor.ts, the critic port, the estimates model or the budget cards (workRunCapOf, reviewCallUsdMicro, TaskReviewRequest.onCost and .budgetUsdMicro, needs_usd_micro, room_usd_micro, PLAN_COUNTS_ALL, costLedger.byTaskOf; the next migration number is 0011). A composed test of yours that runs a session waits with settleSessions(rt) before each close and removes its homes with removeHomes(homes) (packages/runtime/test/helpers.ts; CI runs on Windows and Linux). C4b-left-3 (d1109-run-visible) is a flaky real-daemon case from C4 that can fail CI: fix it early.";
if(!a.note.includes(" Base note: c4583eb")) a.note=a.note.replace(anchor, anchor+note);
fs.writeFileSync(f, JSON.stringify(a,null,2));
console.log(a.note.length);
