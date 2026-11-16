// Places run C step 4's leftovers (C4 merged at a866c38): into later run C areas (C5, C6; problems +
// acceptance) where an area owns the code, otherwise into /tmp/frbench/leftovers-C4.json for the triage
// after live check 4. Folds C4's real-model and GitHub checks into existing live check 4 steps (no new
// step, no new cost), adds session lead decisions and one wave 8 amendment.
// Idempotent: earlier C4-left entries, " C4 adds:" segments, "(C4)" decisions and the "(C4)" wave 8
// amendment are replaced. C4b's segments and decisions (" C4b adds", "(C4b)") are never touched.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "a866c387cb151770d4dd56069549960530fe5b94";
const src = (k) =>
  `/tmp/frbench/runC-C4-fix-${k}.json, -review-${k}.json${k === "d1109-onerepo-join" ? " and -fixup-" + k + ".json" : " (no fix-up: the review passed)"} (not_done, new_problems, non_blocking, notes_for_other_areas)`;

const toAreas = {
  "d1109-cred-engine": [
    ["C4-left-11", "minor", "d1109-selftasks-run", "The task check's model is rungModelFor(modeDefaults.planning.tier) (task-check.ts): unlike the intake (intake.ts about :1592-1602, resolveRunSettings with the principal's planning override and the project's highest model), it ignores both, so 'routed like the intake's planning call' holds for the provider, not the model. Choose the check's model as the intake does, under the credential policy this area puts the check under (review item 10)."],
  ],
  "d1109-selftasks-chat": [
    ["C4-left-1", "major, model-facing", "d1109-selftasks-run", "applyTaskChanges (task-check.ts) marks [...fenced.taskIds, ...madeIds] as agent-written for kind 'add'; for an add, fenced.taskIds are the 'before' tasks, so a plan task only made to wait for the new step gets AGENT_WROTE_TASK_LINE in its brief ('The project's agent wrote this task from an earlier run's report, not the person'; bench: the coder call on 'Add the page behaviour in script.js'). Mark only madeIds for 'add' (as 'order' already does), with a brief test asserting the exact text the specialist receives for both tasks (review item 1)."],
    ["C4-left-2", "minor", "d1109-selftasks-run", "A refused change is not listed in Details with its reason (design point 6): TASK_CHECKED_EVENT carries `refused`, but event-lines.ts renders only the sentence. Render each refusal as one Details line in words (review item 3)."],
    ["C4-left-3", "minor, tests", "d1109-selftasks-run", "ST-11's 'the same suggestion is not filed again that session' after Keep the tasks has code (fileTaskProposal's fingerprint check) and no test: a case that fails without the check (review item 4)."],
    ["C4-left-4", "minor, security", "d1109-selftasks-run", "ST-13's report-006 as specified (a plain request at Standard for a researcher task that would read web pages, the card quoting the reach reason) is not in pnpm test:injection; the case uses ops-deploy and the reach rule has a unit test only. Add the researcher case to the 'report' channel (review item 5)."],
    ["C4-left-5", "words", "d1109-selftasks-run", "Three sentences (design section 5): the composed Undo after a split plus a step before says '... \"Style the page in styles.css: layout\" wait for what they waited for before', a title that no longer exists once the split is undone (rule 4); 'Changed 1 task; your next Start runs them.' (the real-daemon test asserts it) does not agree with one task; 'Asks you first: it would add work for the ops-deploy (...)' uses the registry name where the user guide says 'the deploy specialist'. Update the assertions keeping their intent (review items 7 to 9)."],
    ["C4-left-6", "minor", "d1109-selftasks-run", "A split's Undo resets the waiting tasks' dependencies to their pre-split lists; undoing the split after a later step-before change drops the step's dependency, because undoBlocked does not check that those dependencies are unchanged. Refuse that Undo in words (or undo only what the split changed), with a restart case (review item 12)."],
    ["C4-left-7", "minor", "d1109-selftasks-run", "syncTaskProposals marks a card 'applying' before composing: a crash between the two leaves the card at 'Making the changes…' with nothing applied and no retry. After a restart the card is applied once or goes back to its options, never left at 'Making the changes…' (validation rule 4; review item 13)."],
    ["C4-left-8", "minor", "d1109-selftasks-run", "L3-left-13, carried (not built in C4, recorded in ADR 0119 as a known gap): queueNote records author_human for notes an agent queues, and the reason sent with /transition and /dependencies does not reach the next brief as data. Chat's task_create now takes `why` and task_transition `duplicate_of` (C4), but `why` is stored only in the change log's params. Record the agent as the author (a queue-row author field) and pass a change's reason to the next brief as quoted data, asserted exactly (review item 11)."],
    ["C4-left-9", "words", "d1109-onerepo-join", "Talk opened on a joined project's page (ConversationPanel uses the project on screen) still shows its message box; a change asked there is refused in words by the executor's closed-project guard, but the panel does not say the chat is kept to read. The panel says so in one sentence, as the joined page does. Also: task.split (and this area's chat task_split) on a task of a joined project is refused by the executor's closed-project guard (task.split is not in OPEN_ON_A_CLOSED_PROJECT, intended): chat words the refusal (merge note). Conversation.tsx's message box and examples moved one level in (readOnly wrapper): a whitespace-only conflict is possible."],
  ],
};

const triage = [
  ["C4L-1", "minor", "d1109-onerepo-join", "OJ-11 (cut line, not built): Work together for a project already here (the dialog's together form, moving into a together project keyed by the repository's id inside the join's transaction, closing the closing project's own status pull request as the one GitHub write, a two-home composed test with the fake host). project.join's moveWork and joinRefusal are written for reuse. Goes to wave 8 (wave8_amendments, (C4))."],
  ["C4L-2", "minor", "d1109-onerepo-join", "C2-left-11 part 2: a take-over after this project's own fr/docs-scaffold pull request was opened leaves that pull request without the take-over line, and its marker conflicts with main's on merge. Needs the docs loop to rebuild the scaffold branch on the default branch under the copy's lock before writing the replaced marker (ADR 0117's amendment)."],
  ["C4L-3", "words", "d1109-onerepo-join", "OJ-06's Home line (cut line): Home lists the kept project only, and its card has no 'Includes the work of \"Kite club\"' line (the Overview, Sessions and Costs have it)."],
  ["C4L-4", "minor", "d1109-onerepo-join", "Lessons of the closed project are not moved (ADR 0117's amendment: a lesson's file is canonical and carries its project). Chat recall reads them through withJoined, but the kept project's sessions do not get them in memory."],
  ["C4L-5", "minor", "d1109-onerepo-join", "The closing project's open fr/status pull request is listed on no Overview after the join when the kept project's 'Status pull request' is off (isProjectDocsPr needs statusPullRequestOn(kept)), and the dialog names only four settings, so the person is never told. A dialog line for the status setting, or the joined project's status pull request listed as information (loop/docs.ts and pull-requests.ts, d1109-onerepo-link's). LC-C4 reads it."],
  ["C4L-6", "minor, tests", "d1109-onerepo-join", "OJ-02's Postgres case in the integration suite is missing (no FORERUNNER_TEST_PG here); the join runs in one store.transaction through the repository methods both backends share."],
  ["C4L-7", "minor, tests", "d1109-onerepo-join", "Validation rule 3: docs-routes.ts' DocView.notWrittenHere (C2-left-13) has no real-daemon.test.ts case and no fake-daemon change (only the composed HTTP case in onerepo-together.test.ts); the fake daemon's data import never answers a link refusal, so data/routes.ts' 409 (C2-left-12) is not mirrored there."],
  ["C4L-8", "minor", "d1109-onerepo-join", "project.join's Undo sets active: true on the reopened project whatever the stored closed[].active: a project paused before the join comes back active. Undo restores what was stored, with a case."],
  ["C4L-9", "words", "d1109-onerepo-join", "On a joined project's page, Last result still says '\"Write the rules in rules.md\" is ready to continue' about a task that now belongs to the kept project (d1109-sessions' summary text in views.ts)."],
  ["C4L-10", "minor", "d1109-onerepo-join", "GitHubHost.send's AbortSignal.timeout also covers reading the response body after send() returns: a slow body throws a plain AbortError instead of the 'did not answer in time' error (C2-left-10's edge)."],
  ["C4L-11", "words", "d1109-onerepo-join", "The hands-off refusal ('A session of \"Kite club\" waits to start by itself. Make one project after it ran, or turn \"When work is ready\" back to Wait for my Start.') is about 140 characters: one sentence read at a glance (design section 5)."],
  ["C4L-12", "words", "d1109-onerepo-join", "A joined project's Overview still offers 'Research reads: ... · Change' and the 'Note for the next session' input though nothing runs there; hide them as the Start button is hidden. The Undo of a join (and every undo) answers a change card whose undoHint reads 'This cannot be undone.' (pre-existing, generic)."],
  ["C4L-13", "minor", "d1109-onerepo-join", "Guards on a closed project: POST /projects/:id/plan (applyProjectPlan, no UI client method) still writes milestones and tasks on it; the Data tab's Add and Import still accept data on it (unseen by the kept project); a chat change read back before the join and answered Yes after it runs from its prepared steps without the new guard (the guard is in prepare)."],
  ["C4L-14", "minor", "merge-w20", "project.join does not move the closing project's summary_cache.task_list_notes (d1109-selftasks-run's kept task-list notes), so no check of the kept project reads them; and it moves every human_request card, task_proposal cards included, so the kept project can end with two open suggestion cards (the one-open-card rule acts only when a card is filed)."],
  ["C4L-15", "decision", "d1109-selftasks-run", "The task check's line ('Checked the task list after ...') shows under Details only, not in the person-level session log; the Inbox card is the person-facing signal. Whether the line belongs at person level is a design question (LC-C27 reads it)."],
  ["C4L-16", "words", "d1109-selftasks-run", "Pre-existing: at Assisted the 'Assisted mode' session-plan card has raw options 'approve'/'reject' with no explanations (design section 5)."],
  ["C4L-17", "minor, security", "d1109-selftasks-run", "C2-left-14, carried (recorded in ADR 0119 as a known gap): the brief's quoted parts (a kept-work check's output, a handoff note, a Left-to-do list) have no pnpm test:injection channel; a 'brief' channel with its own planting and judge."],
  ["C4L-18", "minor", "d1109-onerepo-join, d1109-selftasks-run", "Tooling: Biome warnings noConfusingVoidType (commands/src/types.ts:569 and executor.ts:657, pre-existing) and useOptionalChain (task.ts:1022, C4); scripts/bench/README.md does not list FORERUNNER_BENCH_TASK_LIST and FORERUNNER_BENCH_TASK_LIST_SAYS; in a worktree without an upstream 'pnpm docs:check' alone says 'nothing to check' (only '-- --base claude/nifty-knuth-f9udt0' checks)."],
];

function place(areas) {
  for (const [key, items] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("C4-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("C4-left-")));
    for (const [id, sev, from, text] of items) {
      a.problems.push(`[${sev}] ${id} (run C step 4's leftover, from ${from}; read ${src(from)}): ${text}`);
    }
    a.acceptance.push(
      `Run C step 4's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason.`,
    );
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync(
  "/tmp/frbench/leftovers-C4.json",
  JSON.stringify(
    {
      why: "Run C step 4's leftovers that no later run C area owns. Triage them with live check 4's findings, /tmp/frbench/leftovers-L3.json, leftovers-C2.json, leftovers-C3.json and leftovers-C4b-design.json (the next leftovers run). Sources: /tmp/frbench/runC-C4-{fix,review,fixup}-<key>.json and runC-C4-merge.json problems_left.",
      base: HEAD,
      items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
    },
    null,
    1,
  ),
);

// Live check 4: fold C4's checks into the steps that already make those journeys.
const adds = {
  "LC-C4":
    "C4 adds (d1109-onerepo-join's review): with both projects' 'Status pull request' on, a session on the kept project updates the existing fr/status pull request and opens no second one; with only the closing project's on, note what the person can still find of its status pull request (C4L-5); the dialog's facts and refusals as the fix's check_in_the_app steps say (/tmp/frbench/runC-C4-fix-d1109-onerepo-join.json fixed[].check_in_the_app); Undo of a project paused before the join (C4L-8).",
  "LC-C27":
    "C4 adds (d1109-selftasks-run's review): the real planning model's reply passes the strict JSON shape first time; each split part carries every criterion; the Details line costs about CHF 0.03 to 0.05; at Assisted the card's body quotes the report once; a plan task only made to wait for an added step has no 'The project's agent wrote this task' line in its brief (C4-left-1); note whether the check's line belongs in the session log (C4L-15) and how often a person-written task gets a card at Standard instead of a fix (the owner's answer 7).",
};
const l = p.live_check_4;
const own = / C4 adds(?:(?! C\d\w? adds)[^])*/;
for (const s of l.steps) {
  s.step = s.step.replace(own, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C4)"));
p.session_lead_decisions.push(
  "(C4) Flagged-only evidence (d1109-selftasks-run's review item 6): when every task-list note of a report is flagged as instructions, the check makes no call and files no card; the Details line quotes what was left out and the note is dropped. Accepted: nothing acts on flagged text and the person can read it; ST-13's one card quoting the instruction applies when unflagged evidence remains.",
  "(C4) A task the person wrote gets a suggestion card at every level, Standard included (the owner's answer 7 of 2026-11-09, 'sure': the agent only suggests changes to tasks the person wrote, one card, at every level): as built.",
  "(C4) The lessons of a joined project stay on the closed project (ADR 0117's amendment: a lesson's file is canonical and carries its project); chat recall reads them through withJoined; the kept project's sessions not getting them goes to the triage (C4L-4).",
  "(C4) The join's Postgres case waits for a run with FORERUNNER_TEST_PG (C4L-6).",
  "(C4) OJ-11 (Work together for a project already here) goes to wave 8, as its cut line said; d1109-onerepo-link's line keeps its words without a Work together button for a project already here.",
);
p.wave8_amendments = p.wave8_amendments.filter((x) => !String(x).startsWith("(C4)"));
p.wave8_amendments.push(
  "(C4) OJ-11, not built in run C step 4: Work together for a project already here (re-key the kept row to the repository's project id inside the join's transaction, the dialog's together form, closing the closing project's own status pull request as the one GitHub write, a two-home composed test with the fake host); project.join's moveWork and joinRefusal are written for reuse. Source: /tmp/frbench/runC-C4-fix-d1109-onerepo-join.json not_done[0]; leftovers-C4.json C4L-1.",
);

const c4 = p.sub_runs.find((s) => s.name === "C4");
c4.merged = {
  head: HEAD,
  ci: "pending at placement (CI run 43848892931, Desktop app run 43848892836)",
  leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.map((i) => i[0])])),
  leftovers_for_triage: "/tmp/frbench/leftovers-C4.json",
};

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("placed", Object.values(toAreas).flat().length, "in", Object.keys(toAreas).length, "areas; triage", triage.length, "; live steps amended", Object.keys(adds).join(","), "; cap", l.cap_usd, "estimate", JSON.stringify(l.estimate_usd));
