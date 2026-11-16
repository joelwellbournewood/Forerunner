// Puts sub-run C4b (d1116-budget-all, the owner's answer of 2026-11-16) into the run C plan.
// Idempotent: every change checks first. Backs up runC-plan.json and phaseE.json once.
const fs = require("fs");
const FB = "/tmp/frbench";
const D = JSON.parse(fs.readFileSync(`${FB}/d1116-budget-all-design.json`, "utf8")).final;
const A = D.area;
const KEY = "d1116-budget-all";
const TAG = "C4b adds (d1116-budget-all)";

for (const f of ["runC-plan", "phaseE"]) {
  const b = `${FB}/${f}.before-C4b.json`;
  if (!fs.existsSync(b)) fs.copyFileSync(`${FB}/${f}.json`, b);
}
const p = JSON.parse(fs.readFileSync(`${FB}/runC-plan.json`, "utf8"));
const e = JSON.parse(fs.readFileSync(`${FB}/phaseE.json`, "utf8"));
const done = [];
const area = (k) => p.areas.find((x) => x.key === k);
const addOnce = (arr, s, what) => {
  if (!arr.includes(s)) {
    arr.push(s);
    done.push(what);
  }
};

// 1. The area, in both files; its shared_files rules, appended (existing indices keep their meaning).
A.sub_run = "C4b";
A.wave = 24;
if (!area(KEY)) (p.areas.push(A), done.push("area in runC-plan"));
if (!e.areas.find((x) => x.key === KEY)) (e.areas.push(A), done.push("area in phaseE"));
for (const r of D.placement.shared_files_rules) {
  addOnce(p.shared_files, r, "rule runC");
  addOnce(e.shared_files, r, "rule phaseE");
}

// 2. Sub-run C4b between C4 and C5; C5 and C6 depend on it; C5's base.
if (!p.sub_runs.find((s) => s.name === "C4b")) {
  const i = p.sub_runs.findIndex((s) => s.name === "C4");
  p.sub_runs.splice(i + 1, 0, {
    name: "C4b",
    wave: 24,
    keys: [KEY],
    depends_on_sub_runs: ["C1", "C2", "C3", "C4"],
    note:
      "Base: C4 merged, with CI and the Desktop app workflow green on Windows and Linux. One area, the owner's answer of 2026-11-16 to run L3's question (the last section of /tmp/frbench/owner-decisions-2026-11-09.md, verbatim: \"yes it should count critics reviews, and fixes.\"): d1116-budget-all makes a task's budget count everything spent on the task (its work, the critic's reviews and the fixes) as one figure, caps the review at what is left of the task's budget, keeps room for the review in each work run when the budget can hold it, pauses a review that does not fit cleanly with the work kept (one Continue gives it what it needs), puts the review in every estimate (the plan card equal to the Start dialog) and sets one figure against the budget on every screen and in the session review. It replaces run L3's work-only default (L3-run-3: the 'reviews are not counted' words go). It builds on C4's head: task.split, the task check booked to no task (it stays out of every task's budget), and Make one project, which leaves a moved task's earlier ledger rows on the closed project (the task's figure reads the ledger by task). Fixed numbers: migration 0010 (data only; 0009 is d1109-selftasks-run's); ADR 0112 gets a dated amendment after d1109-selftasks-run's, and ADRs 0019, 0115 and 0119 one dated line each (no new number); U-042 carries it (the session lead writes the U-entry from the area's u_entries). One area alone in the sub-run: it owns the regions the shared_files rules marked '(run C, C4b)' name; C5 and C6 build on its head. The shared append-only test files keep one describe 'd1116-budget-all, run C' after C4's blocks. Live check 4 checks it with the real critic (LC-C32, and lines added to LC-L3, LC-C8 and LC-C27).",
  });
  done.push("sub_run C4b");
}
for (const n of ["C5", "C6"]) {
  const s = p.sub_runs.find((x) => x.name === n);
  if (!s.depends_on_sub_runs.includes("C4b")) {
    s.depends_on_sub_runs.splice(s.depends_on_sub_runs.indexOf("C4") + 1, 0, "C4b");
    done.push(`${n} depends on C4b`);
  }
}
const c5 = p.sub_runs.find((x) => x.name === "C5");
if (c5.note.startsWith("Base: C4 merged.")) {
  c5.note = c5.note.replace("Base: C4 merged.", "Base: C4b merged (C4b is d1116-budget-all alone, after C4).");
  done.push("C5 base");
}

// 3. The answered question leaves owner_questions; its record goes to the decisions and an answered list.
const qi = p.owner_questions.findIndex((q) => q.question.startsWith("Owner (run L3)"));
if (qi >= 0) {
  const [q] = p.owner_questions.splice(qi, 1);
  p.answered_owner_questions = p.answered_owner_questions || [];
  p.answered_owner_questions.push(q);
  done.push("question moved to answered_owner_questions");
}
addOnce(
  p.session_lead_decisions,
  "(C4b) Owner, 2026-11-16, to run L3's question: \"yes it should count critics reviews, and fixes.\" A task's budget counts its work, the critic's reviews and the fixes (the work again after a review sent it back, and any later rounds); built by d1116-budget-all (sub-run C4b, wave 24) before C5. Spend the words do not clearly cover, decided by the owner's intent (the budget is what the task costs): a Redo, Try again and Redo from main count against the same budget and never reset or raise it; retries, the ladder's next rung and web searches inside a run count; a refused or cut-off review counts what it booked; the agent's task check (C4), the session review, lesson reviews, the calibration, planning and chat stay out of every task's budget (they count against the session, the project and the monthly cap as built); a task without a budget of its own keeps no per-task cap.",
  "decision: owner answer",
);

// 4. Other decisions this changes.
const sld = p.session_lead_decisions;
const mi = sld.findIndex((d) => d.startsWith("Migration 0009 is d1109-selftasks-run's"));
if (mi >= 0 && !sld[mi].includes("C4b")) {
  sld[mi] += " Amended 2026-11-16: except C4b's d1116-budget-all, migration 0010 (data only), after 0009.";
  done.push("migration decision");
}
const oi = sld.findIndex((d) => d.startsWith("Order: six sub-runs"));
if (oi >= 0 && !sld[oi].includes("C4b")) {
  sld[oi] += " Amended 2026-11-16: seven sub-runs, with C4b (d1116-budget-all alone, the owner's answer of 2026-11-16) after C4 and before C5.";
  done.push("order decision");
}
const si = sld.findIndex((d) => d.startsWith("(C3) S-8"));
if (si >= 0 && !sld[si].includes("C4b")) {
  sld[si] += " Amended 2026-11-16 (C4b): the estimate shown at Start, which the plan keeps and the session review measures against, now includes each task's review and its learned fixes; the refresh never runs between the dialog and the plan, so S-8 holds.";
  done.push("S-8 decision");
}

// 5. Notes: how to run.
const ni = p.notes.findIndex((x) => /How to run/.test(x));
if (ni >= 0 && p.notes[ni].includes("{wave: <17..22>")) {
  p.notes[ni] = p.notes[ni].replace("{wave: <17..22>", "{wave: <17..22; 24 for C4b>");
  done.push("how-to-run note");
}

// 6. Areas of C5 and C6.
addOnce(
  area("d1109-cred-engine").depends_on,
  "d1116-budget-all merged (sub-run C4b): a task's figure counts its work, reviews and fixes; runner.ts' reviewTask, reviewStopSource and review-refusal block and executor.ts' cap block (workRunCapOf beside runCapOf) and task_budget pause figures changed; RunResult.error carries estimateUsdMicro. Re-find them on C4b's head. CE-7's askEstimate and CE-11's switched sums include the reviews. Read its fixup's notes_for_other_areas.",
  "cred-engine depends_on",
);
addOnce(
  area("d1109-run-visible").depends_on,
  "d1116-budget-all merged (sub-run C4b): this area's base is C4b's head; no other change.",
  "run-visible depends_on",
);
addOnce(
  area("d1109-cred-screens").depends_on,
  "d1116-budget-all merged (sub-run C4b): TaskCap shows one figure against the budget; TaskView.cap is the budget less the task's whole figure; TaskView.spent and Costs > By task read costLedger.byTaskOf; l3-money-screens' 'reviews are not counted' words are gone. Read its fixup's notes_for_other_areas.",
  "cred-screens depends_on",
);
const sc = area("d1109-selftasks-chat");
const pi = sc.problems.findIndex((x) => x.includes("L3-left-16"));
if (pi >= 0 && !sc.problems[pi].includes("d1116-budget-all")) {
  sc.problems[pi] +=
    " Amended 2026-11-16 (C4b): for a plan marked counts all (d1116-budget-all), the cause is the planned tasks' cost against that estimate, the task check's spend named apart; session-review.ts' overrun finding and the metrics line are C4b's, SC-13 is unchanged.";
  done.push("selftasks-chat L3-left-16");
}
addOnce(
  sc.depends_on,
  "d1116-budget-all merged (sub-run C4b): session-review.ts' counts mark, the planned tasks' figure with the other spend apart, the overrun finding's words and metrics.counts are C4b's; build L3-left-16 and SC-13 on them. Read its fixup's notes_for_other_areas.",
  "selftasks-chat depends_on",
);

// 7. Live check 4.
const lc = p.live_check_4;
const st = (id) => lc.steps.find((s) => s.id === id);
const byId = (id) => D.live_check_4_steps.find((s) => s.id.startsWith(id));
if (!st("LC-C32")) {
  const s = byId("LC-C32");
  lc.steps.push({
    id: "LC-C32",
    step: `LC-C32 (d1116-budget-all, the owner's answer of 2026-11-16: a task's budget counts its review): ${s.journey}\n${s.steps}\nPass if:\n${s.pass_if}`,
    source: "d1116-budget-all design (wf_5df2fe4b-667), live_check_4_steps",
    needs: "FORERUNNER_ANTHROPIC_API_KEY on the bench in live mode (bench-live provider), the merged run C build; in LC-C18's bench home after LC-C18",
    est_usd: s.est_usd,
    priority: 1,
    after_sub_run: "C6",
  });
  done.push("LC-C32");
}
for (const id of ["LC-L3", "LC-C8", "LC-C27"]) {
  const t = st(id);
  if (!t.step.includes(TAG)) {
    const s = byId(id);
    const head = id === "LC-L3" ? "for L3-run-3, its check_in_the_app steps 3 to 6 are replaced by (priority 3 inside LC-L3, no added cost): " : "";
    t.step += ` ${TAG}: ${head}${s.steps.replace(/\n+/g, " ")} Pass if: ${s.pass_if.replace(/\n+/g, " ")}`;
    done.push(`${id} line`);
  }
}
const est = Math.round(lc.steps.reduce((a, s) => a + (s.est_usd || 0), 0) * 100) / 100;
const p1 = Math.round(lc.steps.filter((s) => s.priority === 1).reduce((a, s) => a + (s.est_usd || 0), 0) * 100) / 100;
lc.estimate_usd.all = est;
lc.estimate_usd.priority_1 = p1;
if (!lc.rules[1].includes("C4b")) {
  lc.rules[1] += ` Amended 2026-11-16 (C4b's LC-C32, USD 0.15 at priority 1): estimate USD ${est.toFixed(2)} for every step, USD ${p1.toFixed(2)} at priority 1; the cap and the order rules are unchanged, so LC-L3 (the last priority 2 step) is likely not reached and its parts go to the owner's checklist or the leftovers as this rule says. The send-back ('fixes') half cannot be forced with the real critic: it is checked on the bench and in the composed tests, and live only if the real critic sends a task back.`;
  done.push("live check rule");
}

// 8. ADR plan, U-entries, design doc changes, run L3's superseded notes.
if (!p.adr_plan.find((a) => a.number === "0112" && a.written_by === KEY)) {
  p.adr_plan.splice(
    p.adr_plan.findIndex((a) => a.number === "rule"),
    0,
    {
      number: "0112",
      title: "A budget stop is a clean pause (amended: a task's budget counts its reviews and fixes)",
      file: "docs/decisions/0112-a-budget-stop-is-a-clean-pause.md",
      decision: "Owner, 2026-11-16",
      written_by: KEY,
      sub_run: "C4b",
      appended_by: [],
      amendments: ["0112 (dated amendment appended after d1109-selftasks-run's C4 amendment and before d1109-cred-engine's C5 one)", "0019, 0115 and 0119: one dated line each"],
      summary: D.adr,
    },
  );
  done.push("adr_plan 0112");
}
const ux = p.u_entries.find((u) => u.id === "existing");
addOnce(ux.areas, "U-042 (a task's budget counts its work, reviews and fixes: d1116-budget-all C4b)", "U-042 line");
for (const s of [
  "(C4b, d1116-budget-all) §4.2: '(their estimates, a fifth kept for reviews)' becomes '(their estimates, each with its review; a fifth of the session kept for the last reviews)'.",
  "(C4b, d1116-budget-all) §3.5 Tasks gains the row's budget line words (one figure against the budget, reviews and fixes included; no 'reviews are not counted').",
  "(C4b, d1116-budget-all) A paused task's drawer line 'Spent CHF 4.00 of about CHF 6.00.' (OP-7, CL-13) now counts the reviews in both figures.",
])
  addOnce(p.design_doc_changes, s, "design doc change");
p.run_L3.superseded_2026_11_16 =
  "The owner's answer of 2026-11-16 (a task's budget counts its reviews and fixes; C4b d1116-budget-all) supersedes: l3-money-screens' 'reviews are not counted' words and its note to d1109-oversize-pause ('The work spent CHF 4.00 of about CHF 6.00', compare with actual not spent); its suggested CHANGELOG line quoting 'reviews are not counted' must not be used; LC-L3's L3-run-3 check_in_the_app is replaced by the C4b line in LC-L3.";

// 9. Leftovers for the triage: notes on existing items, and the new ones.
const note = (file, id, text) => {
  const j = JSON.parse(fs.readFileSync(`${FB}/${file}`, "utf8"));
  const it = (j.items || j).find((x) => x.id === id);
  if (it && !it.note_2026_11_16) {
    it.note_2026_11_16 = text;
    fs.writeFileSync(`${FB}/${file}`, JSON.stringify(j, null, 2));
    done.push(`${file} ${id}`);
  } else if (!it) done.push(`NOT FOUND ${file} ${id}`);
};
note("leftovers-L3.json", "LL-13", "Closed 2026-11-16: the owner answered ('yes it should count critics reviews, and fixes.'); built by C4b d1116-budget-all.");
note("leftovers-L3.json", "LL-9", "Second half closed by C4b d1116-budget-all (the row reads 'of CHF 0.20 budget' and the run's own line names the room kept for its review); the first half (no vitest renders against the real daemon) stays a test-infra leftover.");
note("leftovers-C3.json", "C3L-1", "2026-11-16: not built in C4b, but now buildable: the review estimate it needs exists after C4b (reviewPartUsdMicro); its plan line is views.ts lineOf's session.planned case (C1's region) and its price is start-check.ts'.");
note("leftovers-C2.json", "CL-15", "2026-11-16: not closed by C4b. The review part is learned on its own ratio, so a send-back no longer swings the work's ratio twice, and one sample per task stops a task tried twice from counting twice.");
const lf = `${FB}/leftovers-C4b-design.json`;
if (!fs.existsSync(lf)) {
  fs.writeFileSync(
    lf,
    JSON.stringify(
      {
        why: "Points the d1116-budget-all design (wf_5df2fe4b-667) left for the triage after live check 4 or for phase G; not built in C4b.",
        base: "ba9874a (design), C4b builds on C4's merged head",
        items: [
          { id: "C4bD-1", severity: "minor", from: "design leftovers_resolved 6", text: "Run L3 l3-money-engine fixup not_done[0] (a room check before the critic's checks run): C4b meets it when what is left is below the review's output floor (no checks, no Run row); between that floor and the real first call it stays a leftover." },
          { id: "C4bD-2", severity: "minor", from: "design leftovers_resolved 13", text: "Requirement I.4 ('15 to 25% of the session budget reserved for review and fixes by default'): its words stay, but work runs (fixes included) stop below the session's reserve so the reserve pays reviews only (packages/runtime/src/enforcement/budget.ts:318-326). Phase G: the session lead reconciles the requirement's words with the code." },
          { id: "C4bD-3", severity: "minor", from: "design live_check_4_steps LC-C32", text: "Record each real review's first-call worst case and real cost from LC-C32 and tune REVIEW_EVIDENCE_ALLOWANCE_TOKENS and the tier 1 review start from them." },
        ],
        suggested_session_lead_lines: D.suggested_session_lead_lines,
        unclear_spend_kinds: D.unclear_spend_kinds,
      },
      null,
      2,
    ),
  );
  done.push("leftovers-C4b-design.json");
}

fs.writeFileSync(`${FB}/runC-plan.json`, JSON.stringify(p, null, 2));
fs.writeFileSync(`${FB}/phaseE.json`, JSON.stringify(e, null, 2));
console.log(done.length ? done.join("\n") : "nothing to do (already placed)");
console.log("live check 4 estimate:", JSON.stringify(lc.estimate_usd), "sub_runs:", p.sub_runs.map((s) => s.name).join(" "));
