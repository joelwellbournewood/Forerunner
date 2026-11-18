// Prepares run L4's fix run: applies the owner's answers of 2026-11-17 to /tmp/frbench/runL4-plan.json,
// copies the run L4 areas, their triage items and shared_files rules into /tmp/frbench/phaseE.json (the fix
// workflow reads areas by key there), and writes the args builder's inputs. Idempotent.
const fs = require("fs");
const P = "/tmp/frbench/runL4-plan.json";
const E = "/tmp/frbench/phaseE.json";
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const e = JSON.parse(fs.readFileSync(E, "utf8"));
if (!fs.existsSync("/tmp/frbench/phaseE.before-L4.json")) fs.copyFileSync(E, "/tmp/frbench/phaseE.before-L4.json");
if (!fs.existsSync("/tmp/frbench/runL4-plan.before-answers.json")) fs.copyFileSync(P, "/tmp/frbench/runL4-plan.before-answers.json");

// 1. The owner's answers (owner-decisions-2026-11-09.md, section 2026-11-17).
const set = (id, f) => {
  const it = p.items.find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  f(it);
};
set("L4-chat-309", (it) => {
  it.final_decision = "not_a_problem";
  it.owner_answer = "2026-11-17: keep asking first while a failed task's card is open, even when nothing is flagged.";
});
set("L4-chat-310", (it) => {
  it.final_decision = "not_a_problem";
  it.owner_answer = "2026-11-17: chat's fixed lines stay English, like every other screen.";
});
set("L4-selftasks-117", (it) => {
  it.owner_answer = "2026-11-17: every chat read-back waits until the person answers it (no 10-minute lapse), as design section 3.9 says.";
});
const a117 = p.areas.find((a) => (a.problems || []).some((x) => String(x).includes("L4-selftasks-117")));
if (a117) {
  const tag = "OWNER 2026-11-17 (L4-selftasks-117):";
  a117.decisions = (a117.decisions || []).filter((d) => !String(d).startsWith(tag));
  a117.decisions.push(`${tag} the owner answered that every chat read-back waits until the person answers it, as design section 3.9 says: no read-back lapses after 10 minutes (PENDING_TTL_MS no longer expires a read-back); 'fix the tasks' and every other chat change card stay open in chat and the Inbox until Yes or No, across a restart. Build it for every read-back, not only 'fix the tasks'.`);
  a117.acceptance = (a117.acceptance || []).filter((d) => !String(d).startsWith(tag));
  a117.acceptance.push(`${tag} a chat read-back (a plain task change, not only 'fix the tasks') left unanswered for more than 10 minutes, and across a daemon restart, is still open in chat and the Inbox, and Yes then makes the change (composed test with a clock moved past 10 minutes, and a real-daemon case).`);
}
set("L4-github-130", (it) => {
  it.final_decision = "fix";
  it.final_area = "l4-github-merge";
  it.severity = "minor";
  it.owner_answer = "2026-11-18: add a Close button; one press closes the cancelled task's pull request on GitHub (it can be reopened there).";
});
const gm = p.areas.find((a) => a.key === "l4-github-merge");
{
  const tag = "OWNER 2026-11-18 (L4-github-130):";
  gm.problems = gm.problems.filter((x) => !String(x).includes(tag));
  gm.problems.push(`[minor] L4-github-130: ${tag} a cancelled task whose pull request is still open on GitHub is listed on the Overview under 'Cancelled, still open on GitHub' with Open only, and the person must go to GitHub to close it. The owner answered: add a Close button. Evidence: the plan check's item L4-github-130 (LL-5); ADR 0105 point 4 (amended 2026-11-15). Root cause: no close route or button for that row.`);
  gm.decisions = (gm.decisions || []).filter((d) => !String(d).startsWith(tag));
  gm.decisions.push(`${tag} Close beside Open on the 'Cancelled, still open on GitHub' row, with its one-line consequence ('Closes this pull request on GitHub; you can reopen it there.'); it closes only that pull request, on GitHub with the project's own token, never deletes its branch, and the row goes once GitHub answers; amend ADR 0105 point 4 (dated).`);
  gm.acceptance = (gm.acceptance || []).filter((d) => !String(d).startsWith(tag));
  gm.acceptance.push(`${tag} pressing Close on a cancelled task's open pull request closes it on the stand-in GitHub (real-daemon case for the new route, the fake daemon in step, a UI test that clicks and asserts what is sent and what the row then says); the branch is kept. May end in not_done only with the reason (cut line: minor).`);
}
p.owner_questions = (p.owner_questions || []).filter((q) => !/L4-chat-309|L4-chat-310|L4-github-130/.test(JSON.stringify(q)));
p.owner_answers_2026_11_17 = JSON.parse(fs.readFileSync("/tmp/frbench/runL4-owner-answers.json", "utf8"));

// 2. Areas, triage items and shared_files into phaseE.json.
e.areas = e.areas.filter((a) => !a.key.startsWith("l4-"));
for (const a of p.areas) e.areas.push(a);
e.triage = (e.triage || []).filter((t) => !String(t.area || "").startsWith("l4-") && !String(t.item || "").startsWith("L4-"));
let n = 0;
for (const it of p.items) {
  const area = it.final_area || it.triage_area;
  if (!area || !String(area).startsWith("l4-")) continue;
  e.triage.push({ n: `L4-${++n}`, item: `${it.id}: ${it.title}`, decision: it.final_decision || it.decision, area, evidence: it.evidence, note: [it.root_cause_at_head, it.fix_sketch, it.test_boundary, it.session_lead_note, it.owner_answer].filter(Boolean).join(" | ") });
}
e.shared_files = (e.shared_files || []).filter((s) => !String(s).includes("(run L4)"));
for (const s of p.shared_files) e.shared_files.push(String(s).includes("(run L4)") ? s : `(run L4) ${s}`);

fs.writeFileSync(P, JSON.stringify(p, null, 1));
fs.writeFileSync(E, JSON.stringify(e, null, 1));
console.log("areas", p.areas.length, "triage items", n, "shared_files", p.shared_files.length, "owner questions open", p.owner_questions.length, "117 area", a117 && a117.key);
