// Places run L3's leftovers: into run C areas (problems + acceptance) where an area owns the code,
// otherwise into /tmp/frbench/leftovers-L3.json for the triage after live check 4.
// Also adds live check 4's LC-L3 step, the owner checklist line and the owner question.
// Idempotent: earlier L3-left / LC-L3 entries are replaced.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const src = (k) => `/tmp/frbench/runL3-${k}-fix.json and -fixup.json (not_done, new_problems, notes_for_other_areas)`;

const toAreas = {
  "d1109-oversize-pause": [
    ["L3-left-1", "words", "l3-handoff-checks", "After a Continue, the session line names only this run's spend ('The run paused before its budget of CHF 0.30 ran out: it spent CHF 0.12') while the card names the task's total ('It spent CHF 0.24 of its budget of CHF 0.30'). The call is executor.ts pauseSentence inside the `if (handoff)` block (about :1747-1792 at 7aa7add). OP-7 words the pause sentences: each figure says what it counts, and the line and the card agree."],
    ["L3-left-2", "words", "l3-handoff-checks", "The specialist-limit wrap-up card does not say what was spent (its body: 'It has no budget of its own: it may spend CHF b per run.'; card.spent_usd_micro is the task's total while the limit is per run). Its title phrase \"paused before the <specialist>'s limit per run ran out\" is always cut in the 60-character notification title, and any wrap-up pause's notification title is cut when the project name is long (notifications/producers.ts titled/fit; bench: 'Club guide after: \"Write the…\" paused before its budget…'). Titles that fit say the one thing; the body says what was spent of what."],
    ["L3-left-3", "words", "l3-handoff-checks", "The Tasks tab, the Overview's 'Next' and the drawer still label a wrap-up pause 'Paused at its budget' (task-words.ts:318) beside the card, session row, result, gist and chat fact, which now say 'paused before its budget of CHF x ran out' (run L3, L3-research-2). One label that agrees with them; update the assertions that use the old label."],
    ["L3-left-4", "model-facing", "l3-handoff-checks", "The wrap-up words (wrapUpText, WRAP_UP_BRIEF_LINE), which OP-1 rewrites: add that a caveat or what the run did not cover goes under 'Where I stopped:', not 'Left to do:' (the verifier's sketch (c) for L3-research-1, left to OP-1 so the text is changed and asserted once on both drivers). Keep run L3's parseHandoff rule: 'Nothing … for the criteria: <reason>' (and its near siblings) means nothing is left, so the task goes to its review."],
  ],
  "d1109-chat-recall": [
    ["L3-left-5", "minor", "l3-merge", "The chat's '# Your files' keeps a cancelled task's open pull request line after that pull request is closed on GitHub (project-facts.ts, from L3-github-10's fix): the fact follows the pull request's state, as the Overview's does."],
    ["L3-left-6", "model-facing", "l3-chat-claims", "transcript.ts changeSentence falls back to the internal kind ('The app did: task.create.') when a result has no sentence: the history line names the change in words. Also: run L3's history scan reads the model's own earlier prose, so a reply that quoted an instruction-like record makes every later turn read back every change while that reply stays in the history. Keep the safe side (a record's words never become instructions), but make the selective recall not re-trigger on the model's own quoting; decide and test it (pnpm test:injection's record and chat_history channels)."],
    ["L3-left-7", "words", "l3-small", "Memory lessons still carry the critic's no-fix placeholder ('Resolve it and show the evidence'). Run L3 removed it from Reviews, the drawer, the cards and specialistReason (findingView and its siblings in task-display.ts): the lessons recall stores and quotes do the same (a finding with no fix reads as what it found)."],
  ],
  "d1109-onerepo-link": [
    ["L3-left-8", "words", "l3-small", "The intake docs pull request's branch name still carries the project's id (fr/intake-<project id>-docs; L3-github-6's second half, on run L3's cut line). isProjectDocsPr (loop/docs.ts) finds a project's docs pull request by it (/^fr\\/intake-(.+)-docs$/ against safeSegment(project.id)), intake.ts reuses an open one by that head, and intake.test.ts requires two projects made in one minute to differ. With D1 the repository names its one project: name the branch for the person (for example from the project's name) and find the docs pull request by the marker, still finding the old branch names."],
  ],
  "d1109-chat-depth": [
    ["L3-left-9", "minor", "l3-chat-claims", "Run L3's claim guard cannot take back text already streamed: while its nudge step runs (about 1 s on Haiku), Talk's live bubble can show the first call's false claim, and a spoken turn has already said it. The stored reply is the true one. Needs a stream frame that resets the live text (chat-stream.ts, Conversation.tsx), or holding the stream while a claim is checked; it must work with the waiting indicator D3 adds."],
    ["L3-left-10", "words", "l3-chat-claims", "A reply the guard replaced on a turn with two or more done changes shows their joined sentences above the change rows, because Conversation.tsx hides the reply text only when it equals one action's sentence."],
    ["L3-left-11", "words", "l3-money-engine", "The chat's timeout reply reads 'I could not answer (run timeout).', a raw state in brackets. With thinking longer (D3), the reply says in one sentence what happened and what the person can do."],
  ],
  "d1109-starts-engine": [
    ["L3-left-12", "minor", "l3-money-engine", "A review-only session (the review pass on finished work) shows the writer's estimate as its plan line ('Plan: 1 task, about CHF 0.03.'), and its session review measures 'the work cost CHF 0.00 against an estimate of CHF 0.03' (L3-run-10's second half, run L3's cut line: the review-only pass has no plan line of its own). The Start dialog's promise and the plan line of a review-only start name the review's own estimate."],
  ],
  "d1109-selftasks-run": [
    ["L3-left-13", "minor", "l3-small", "queueNote records author_human for notes an agent actor queues, and the reason sent with /transition and /dependencies no longer reaches a brief (l3-small's new_problems). With D7 the agent's own changes are recorded as the agent's (the person sees who changed what), and a reason given with a change reaches the next brief quoted as data."],
  ],
  "d1109-cred-engine": [
    ["L3-left-14", "money", "l3-money-engine", "Run L3 books a call that Stop now cuts off (loop.ts abort branch through afterModelCall). On a routed provider it is booked on the run's current billing source, which can differ from the source the cut-off call used: book it on the call's own source, as a finished call is."],
  ],
  "d1109-run-visible": [
    ["L3-left-15", "words", "l3-small", "The session page's level filter chips read raw words with zero counts ('info (20) warning (0) escalation (0) error (0)'): person words, and no chip for a zero count (design section 5)."],
  ],
  "d1109-selftasks-chat": [
    ["L3-left-16", "words", "l3-money-engine", "A session review whose 'revise' has another cause (an overrun) still reads 'sent back for changes' (session-review.ts): the review names the cause it found. Keep run L3's retry words ('one task tried 3 times', '2 tasks tried again')."],
  ],
};

const triage = [
  ["LL-1", "minor", "l3-merge", "Merge cards stay open when their pull request is closed on GitHub without a merge (run L3 closes them on every merge only)."],
  ["LL-2", "minor", "l3-merge", "A Merge press on a pull request whose check failed, or that stopped merging cleanly, after Forerunner's last look still answers 'Merging #N.' first (a sibling of L3-github-3, which now says a head move at once)."],
  ["LL-3", "words", "l3-merge", "notCheckedSentence (the press's 'could not check' path) has no boundary test and is two sentences."],
  ["LL-4", "major", "l3-merge", "L3-github-1 part 3: when B, still holding closed A, is merged on GitHub's website before any poll, A's record says only '#A was closed without merging.'; no card says A's change reached main through #B, and nothing offers Take this work out on A."],
  ["LL-5", "minor", "l3-merge", "The optional Close button on a cancelled task's open pull request (ADR 0105 point 4's amendment of 2026-11-15 records it as an option for later)."],
  ["LL-6", "words", "l3-merge", "After a press-time check A's Tasks row reads 'Accepted · waiting for you to merge' until the next poll; the Overview's cancelled block is plural with one row; a rebuilt-without row still sits under 'Reviewed by the critic'; the press-time rebuild costs a listPullRequests call and a git fetch per waiting dependent per retry."],
  ["LL-7", "minor", "l3-handoff-checks", "The node --test marker check runs every script directly in test/, tests/ or __tests__/: a helper that never exits hits the check timeout and blocks the accept."],
  ["LL-8", "minor", "l3-handoff-checks", "Optional: one line in the intake prompt naming the checks Forerunner can run (the verifier's sketch item 4 for L3-research-4)."],
  ["LL-9", "minor", "l3-money-screens", "No vitest can render a screen against the real daemon (jsdom cannot bundle node:sqlite in packages/state); and the Tasks row's 'left' figure equals 'This run may spend' only at the run's start."],
  ["LL-10", "words", "l3-chat-claims", "The chat's own correction lines (NOTHING_CHANGED_REPLY, NOTHING_CHANGED_CARD_WAITS_REPLY, NO_ANSWER_REPLY, like 'Yes to what? …') are English only, so a German conversation gets an English line: whether the app's own chat lines follow the conversation's language is a decision."],
  ["LL-11", "minor", "l3-small", "Refs refs/forerunner/before|first/<task> show in `git log --all --decorate=full` and in git GUIs on the person's folder."],
  ["LL-12", "words", "l3-small", "A finding the critic named no fix for has no 'To fix' line now (L3-research-3); naming an action would be a critic prompt change (ask the critic for one)."],
  ["LL-13", "owner", "l3-money-screens", "Owner question (told 2026-11-15): a task's budget counts only the work, not the critic's reviews; run L3 made the screens say which figure each line counts. Should the budget count the reviews too?"],
];

function place(areas) {
  for (const [key, items] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("L3-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("L3-left-")));
    for (const [id, sev, from, text] of items) {
      a.problems.push(`[${sev}] ${id} (run L3's leftover, from ${from}; read ${src(from)}): ${text}`);
    }
    a.acceptance.push(`Run L3's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason.`);
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync("/tmp/frbench/leftovers-L3.json", JSON.stringify({
  why: "Run L3's leftovers that no run C area owns. Triage them with live check 4's findings (the next leftovers run). Sources: /tmp/frbench/runL3-<area>-{fix,review,fixup}.json and runL3-merge.json problems_left.",
  base: "7aa7add2ee13db95d051fa4fa3d6fec375ff2d6e",
  items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
}, null, 1));

// Live check 4: run L3's check_in_the_app steps.
const r = JSON.parse(fs.readFileSync("/tmp/frbench/runL3-result.json", "utf8"));
const checks = [];
for (const a of r.areas) for (const s of ["fix", "fixup"]) for (const f of a[s]?.fixed || []) if (f.check_in_the_app) checks.push(`${a.key}/${s}: ${(f.u_ids || []).join(",") || f.problem.slice(0, 40)}`);
const l = p.live_check_4;
l.steps = l.steps.filter((x) => x.id !== "LC-L3");
l.steps.push({
  id: "LC-L3",
  priority: 2,
  est_usd: 0.6,
  after_sub_run: "C6",
  step: `LC-L3 (run L3's fixes, merged at 7aa7add): run the check_in_the_app steps of run L3's fixed items (${checks.length} in /tmp/frbench/runL3-<area>-fix.json and -fixup.json, fixed[].check_in_the_app), folded into the journeys the other steps already make (the GitHub chain on forerunner-sandbox, the research run, the chat, the money screens) so that no step is paid twice. Priority 1 inside it: L3-github-1 (close A on GitHub, press Merge on B before the next look: refused at once, nothing merged, one card), L3-github-2 (cards close when merged on GitHub, through a restart), L3-run-1 (Haiku calls settings_set on 'research may read any public website again' and never claims a confirmation it did not ask for; the reply guard's line if it does), L3-research-1 and L3-research-4 (a finished research run goes to its review; the node --test criterion is checked). The rest at priority 3. Live check 3's model-only items too: the L3-run-1 Haiku settings_set behaviour and the steps X5 to X9 it skipped at its cap.`,
  sources: checks,
});
l.cap_usd = 7;
l.estimate_usd = { all: 7.05, priority_1: 4.37, priority_2: 2.68 }; // before run L3: 6.45, 4.37, 2.08
l.rules = l.rules.map((x) => x.replace(/^Cap USD 6\.00 \(estimate USD 6\.45 for every step; USD 4\.37 at priority 1, USD 2\.08 at priority 2\)/, "Cap USD 7.00, raised on 2026-11-15 for run L3's step LC-L3 (estimate USD 7.05 for every step; USD 4.37 at priority 1, USD 2.68 at priority 2)").replace("under USD 5.40 (no new step after USD 5.40)", "under USD 6.30 (no new step after USD 6.30)"));

// Owner checklist: the aborted-call line.
p.owner_checklist_additions = p.owner_checklist_additions.filter((x) => !x.startsWith("Anthropic console: after a day with a Stop now"));
p.owner_checklist_additions.push("Anthropic console: after a day with a Stop now and a Cancel, the console's usage matches Costs within a few centimes (run L3 books a call that Stop now cuts off; this replaces the old line 'aborted calls are booked at CHF 0 today').");

// Owner question.
p.owner_questions = p.owner_questions.filter((x) => !String(x.question).startsWith("Owner (run L3):"));
p.owner_questions.push({
  question: "Owner (run L3): a task's budget counts only the work, not the critic's reviews of it, so a task's cost can read higher than its budget. Run L3 made the screens say which figure each line counts. Should the budget count the reviews too?",
  default_built: "The budget counts the work only; the Tasks row, the drawer and Costs say what each figure counts (run L3, L3-run-3).",
  why: "Counting the reviews would change when a task pauses at its budget and every estimate; the owner was asked on 2026-11-15.",
});

p.run_L3.merged = { head: "7aa7add2ee13db95d051fa4fa3d6fec375ff2d6e", leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.map((i) => i[0])])), leftovers_for_triage: "/tmp/frbench/leftovers-L3.json" };

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("placed", Object.values(toAreas).flat().length, "in", Object.keys(toAreas).length, "areas; triage", triage.length, "; LC-L3 sources", checks.length, "; cap", l.cap_usd, l.estimate_usd);
