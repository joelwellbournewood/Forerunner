// Places run C sub-run C4b's leftovers (d1116-budget-all merged at c4583eb; the review passed, so no
// fix-up ran): into later run C areas (C5, C6; problems + acceptance) where an area owns the code,
// otherwise into /tmp/frbench/leftovers-C4b.json for the triage after live check 4. Folds C4b's merge
// notes into live check 4's LC-C32 (no new step, no new cost) and adds session lead decisions.
// Idempotent: earlier C4b-left entries, " C4b leftovers adds" segments and "(C4b-merge)" decisions are
// replaced. C4b's design segments and decisions (" C4b adds (d1116-budget-all)", "(C4b)") are never
// touched, nor any other sub-run's.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "c4583eb095c04e2c9ef1d10d451208cc546463e9";
const SRC =
  "/tmp/frbench/runC-C4b-fix-d1116-budget-all.json and -review-d1116-budget-all.json (no fix-up: the review passed; not_done, new_problems, non_blocking, notes_for_other_areas) and runC-C4b-merge.json problems_left";

const toAreas = {
  "d1109-cred-engine": [
    [
      "C4b-left-1",
      "minor, tests",
      "BA-7's composed restart cases and BA-3's composed effort-max case are not built (review non_blocking 3; only model-level coverage: estimates.test.ts 'BA-7: one sample per task', the live-versus-fold case, wiring.test.ts and review-price.test.ts). Build them in packages/runtime/test/task-budget-all.test.ts (C4b's file; settleSessions(rt) before each close, removeHomes(homes)): (a) a task done, Redo, done again; (b) failed, Try again, done; (c) the merge watcher closing it about 20 minutes later; (d) cancelled in the Inbox. In each, the estimate model holds one sample for the task, and after a restart the fold equals what was learned live, with the same Start dialog figures. And BA-3's case at effort max: the review's cap and its refusal use the max-effort worst case (CriticPort.reviewCallUsdMicro's maxEffort). If a case shows a real gap, fix it test-first.",
    ],
    [
      "C4b-left-2",
      "words",
      "The intake card's line 'a first-session plan of N task(s)' (packages/runtime/src/intake.ts about :1471-1475, the line C4b edited; the '(s)' predates C4b) reads '1 task' or 'N tasks' (design section 5), its assertions updated.",
    ],
  ],
  "d1109-run-visible": [
    [
      "C4b-left-3",
      "major, CI",
      "Flaky test from C4 (d1109-selftasks-run's block, not C4b's): apps/ui/test/real-daemon.test.ts (about :20525) 'the card in the Inbox names the project ... after a restart'. It passes alone and fails in full-file runs (the C4b reviewer: 3 of 6 on the branch, 1 of 3 on the base 136d4f6). composeWithRolePlayer's ShiftedClock is fixed at 2026-03-05T08:00 and starts again from that time at the second compose; runOrder ranks by priority, then created_at, so whether 'Check that the links work' (made after the restart) sorts before 'Send the logo' (made before it) depends on milliseconds. Give the second compose a later clock (or assert the order from the stored created_at), keeping the case's intent. Show it failing first by running that file in full several times (or by forcing the tie), then green 10 times in a row.",
    ],
    [
      "C4b-left-4",
      "minor, tooling",
      "Bench stand-ins and journeys (bench only, not the product): (1) on the bench-api path the stand-in critic ignores FORERUNNER_BENCH_CRITIC_REJECT_TIMES, because packages/testenv/src/bench/role-player.ts about :347-353 keys send-backs by req.origin?.runId, which that path does not send (C4b's walk: REJECT_TIMES=1 gave 4 send-backs and the 'failed 4 times' card); key it by what that path does carry (the task), with a testenv test. (2) Stale journey checks: budget.cjs's 'the tiny task's log line says it pauses and keeps its work' (fails in every walk since wave 15) and resume.cjs's 'Paused at its budget' and 'Done: ...; left:' (words changed by C2's cd9bece): update them to today's words, so that live check 4's journeys report real failures only.",
    ],
  ],
  "d1109-cred-screens": [
    [
      "C4b-left-5",
      "minor, words",
      "BA-12 (C4b's cut line, carried with its wording): the Start dialog warns when a task's budget cannot hold both its work and its review. Add StartCheck.reviewMayWait (start-check.ts: the task's whole estimate plus one critic call's worst case W, CriticPort.reviewCallUsdMicro, against what is left of its budget), the api-types field, the fake daemon mirror and one dialog line per task, worded exactly: '\"Add a footer line with the club's name to index.html\": its budget of CHF 0.10 may leave too little for its review, which then waits for Continue.' Tests: oversized-task.test.ts, d1109-oversize.test.tsx and a real-daemon case.",
    ],
    [
      "C4b-left-6",
      "words",
      "A task whose work is done and whose review waits for room in its budget: (1) its Inbox card's Continue explanation still reads 'Adds CHF 0.07 to its budget and starts a session that goes on from where it stopped.' (d1109-oversize-pause's words), though only the review is left: say that the next session runs only its review; (2) its row and drawer read only 'Paused at its budget · less than CHF 0.01 of CHF 0.07 budget': the drawer quotes the card's sentence ('The work is done; its review waits for room in the budget.'). Update the earlier assertions keeping their intent (C4b's screenshots: /tmp/frbench/fix-d1116-budget-all/steps/12-after2-06-inbox.png and 09-after2-03-drawer-swiss.png).",
    ],
  ],
};

const triage = [
  ["C4bL-1", "decision", "Validation rule 3 ('the fake is updated in the same commit') broke commit by commit on fix/d1116-budget-all: 1303798 and db706cb changed routes before the fake daemon and real-daemon cases (6d26ea7, b9c1503); the real-daemon suite was red in between. The merged head is consistent. Accepted (session lead decision (C4b-merge)); the merge commit stays (history is pushed and not rewritten)."],
  ["C4bL-2", "minor, bench", "Bench-only caveat: FORERUNNER_BENCH_USAGE and FORERUNNER_BENCH_CRITIC_USAGE add input tokens after the precheck, so a run they inflate can pass its work cap (real-daemon W15-14: 'after spending CHF 0.12' against a CHF 0.11 work cap). The task's own budget held. LC-C32 records whether a real run ever passes its work cap."],
  ["C4bL-3", "minor, tests", "wiring.test.ts now waits up to 30 s for the task's close, which includes the review, instead of the run's return. A slow Windows runner has a review's git and critic work inside that window: watch it on CI; widen with a reason if it flakes."],
  ["C4bL-4", "decision", "The BEFORE bench walk on the base 136d4f6 was not made (the auto-mode classifier denied checking the base code into the worktree, and one bench at a time). The before state comes from earlier walks of the same code: /tmp/frbench/fix-l3-money-screens/steps/23-after-tasks-after.png, 24-after-drawer-after.png and /tmp/frbench/fix-d1109-starts-engine/steps/13-after-retry-tasks.png, plus each item's failing test. Accepted."],
  ["C4bL-5", "decision", "Continue at a tiny budget adds much more than the budget, because one Continue must give what the task needs (the estimate left plus W, less what is left): CHF 0.004 gave 'Continue (CHF 0.07 more)', CHF 0.008 gave CHF 0.10. By the spec (BA-5, one Continue is enough) and the button names the amount. LC-C32 records how it reads to a person."],
];

const forSessionLead = {
  changelog_update_log_line:
    "A task's budget now counts its whole cost: its work, the critic's reviews and any fixes (the owner's answer of 2026-11-16). Each run keeps room for its review, one Continue is enough when a review waits, estimates include the review, and the Tasks row, drawer and Costs show one figure (\"of CHF 0.20 budget\").",
  owner_tunable: "REVIEW_STARTING_ESTIMATES_USD_MICRO {1: 30_000, 2: 90_000, 3: 300_000} in packages/runtime/src/estimates/model.ts is the one place to tune the review part of an estimate; REVIEW_EVIDENCE_ALLOWANCE_TOKENS = 8,000 in packages/critic/src/critic.ts sets W.",
  next_migration: "0011",
};

function place(areas) {
  for (const [key, items] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("C4b-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("C4b-left-")));
    for (const [id, sev, text] of items) {
      a.problems.push(`[${sev}] ${id} (run C sub-run C4b's leftover, from d1116-budget-all; read ${SRC}): ${text}`);
    }
    a.acceptance.push(
      `Run C sub-run C4b's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason; a coverage case that passes at once says so and names what it guards.`,
    );
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync(
  "/tmp/frbench/leftovers-C4b.json",
  JSON.stringify(
    {
      why: "Run C sub-run C4b's leftovers that no later run C area owns. Triage them with live check 4's findings, /tmp/frbench/leftovers-L3.json, leftovers-C2.json, leftovers-C3.json, leftovers-C4.json and leftovers-C4b-design.json (the next leftovers run). Sources: " + SRC + ".",
      base: HEAD,
      items: triage.map(([id, severity, text]) => ({ id, severity, from: "d1116-budget-all", text })),
      for_session_lead: forSessionLead,
    },
    null,
    1,
  ),
);

// Live check 4: fold into C4b's own step.
const TAG = " C4b leftovers adds";
const own = / C4b leftovers adds(?:(?! C\d\w?(?: leftovers)? adds)[^])*/;
const adds = {
  "LC-C32":
    "C4b leftovers adds (the merge's notes): record what one Continue adds at a tiny budget and whether its button reads as reasonable (C4bL-5: on the stand-in CHF 0.004 gave CHF 0.07 more); whether any real work run passes its work cap (C4bL-2); the waiting review's card and drawer words as C6 built them (C4b-left-6); and, if C6 built it, the Start dialog's line for a budget that may leave too little for its review (C4b-left-5).",
};
const l = p.live_check_4;
for (const s of l.steps) {
  s.step = s.step.replace(own, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);
if (!TAG) throw new Error("tag");

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C4b-merge)"));
p.session_lead_decisions.push(
  "(C4b-merge) d1116-budget-all's review passed with nothing blocking, so no fix-up ran; its notes_for_other_areas are in /tmp/frbench/runC-C4b-fix-d1116-budget-all.json (there is no runC-C4b-fixup file).",
  "(C4b-merge) Validation rule 3 broke between commits on the branch; the merged head is consistent and the history is pushed: accepted, not squashed (C4bL-1).",
  "(C4b-merge) BA-12's Start dialog warning (cut line) goes to d1109-cred-screens in C6 with its wording (C4b-left-5); BA-7's composed restart cases and BA-3's effort-max case go to d1109-cred-engine in C5 (C4b-left-1).",
  "(C4b-merge) C4's flaky real-daemon case goes to d1109-run-visible in C5 (C4b-left-3) unless CI on c4583eb fails on it first, in which case the session lead fixes it before C5.",
);

const c4b = p.sub_runs.find((s) => s.name === "C4b");
c4b.merged = {
  head: HEAD,
  ci: "green on Windows and Linux: CI 311 (43898132088) and Desktop app 76 (43898132035), 2026-11-16 16:10 UTC",
  review: "pass, nothing blocking; no fix-up",
  leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.map((i) => i[0])])),
  leftovers_for_triage: "/tmp/frbench/leftovers-C4b.json",
};

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("placed", Object.values(toAreas).flat().length, "in", Object.keys(toAreas).length, "areas; triage", triage.length, "; live steps amended", Object.keys(adds).join(","), "; cap", l.cap_usd, "estimate", JSON.stringify(l.estimate_usd));
