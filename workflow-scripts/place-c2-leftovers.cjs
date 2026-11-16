// Places run C step 2's leftovers (C2 merged at b5fb66f): into later run C areas (problems + acceptance)
// where an area owns the code, otherwise into /tmp/frbench/leftovers-C2.json for the triage after
// live check 4. Folds C2's real-model checks into existing live check 4 steps (no new step, no new cost),
// adds session lead decisions and a wave 8 amendment.
// Idempotent: earlier C2-left / "C2 adds:" / "(C2)" entries are replaced.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "b5fb66f5d2977deea413cd158ce72308f2ba6f6a";
const src = (k) => `/tmp/frbench/runC-C2-fix-${k}.json, -review- and -fixup- (not_done, new_problems, notes_for_other_areas)`;
const D4 = `Owner's words (D4): "when the budget will run out, it should be the case that the agent will do as much as it can, and wrap up in an organized and error free way such that the work can be continued in the next run."`;

const toAreas = {
  "d1109-starts-engine": [
    ["C2-left-1", "words", "d1109-oversize-pause", "After a pause that got no further (OP-4), the Tasks row and the Overview's 'Next' read 'Paused before the session's budget ran out' (or 'Paused at the project's budget'), while the card's title reads 'paused again without getting further' (bench 23-e-tasks-after-no-progress.png). The session lead's wording: the label reads 'Paused again without getting further' and the drawer detail 'Its card in the Inbox asks what to do differently.' One label that agrees with the card (L3-left-3's aim); update the assertions that use the old label."],
    ["C2-left-2", "words", "d1109-oversize-pause", "With only a no-progress pause waiting, the Start dialog says 'Nothing can run: no task is ready. … Give your agent work first: add a task …' instead of naming the card that waits on the person. Design section 3.6's example is 'Nothing can run: \"Step 3\" needs your answer [Open it]'. This area rewords start-check's nothing_runnable sentence: a task that waits on a card is named with its card."],
    ["C2-left-3", "major", "d1109-oversize-pause", `madeProgress (session/runner.ts keepPausedWork) compares only the fingerprint of the changed files and the length of the Left-to-do list. A task whose work is in its report (a researcher writing up findings, or a run that wrote no file) and keeps a list of the same length counts as 'no progress', so its next pause stops for the person instead of going on. Count a changed report or handoff (what 'Where I stopped:' and 'Left to do:' say) as progress; failing test first: a research task that wrote more of its report between two pauses goes on, and one that wrote nothing new still asks. ${D4}`],
    ["C2-left-4", "major", "d1109-oversize-pause", "From d1109-oversize-pause's note: keepPausedWork now compares against the newest earlier work run with outcome 'paused' or 'budget_exceeded', so a pause that got no further is also produced at an outer limit (the project's budget, the month's cap). When this area changes wakeBudgetWaits to prepare instead of start, a task with a no-progress card stays out of every automatic start (the hands-off setting, a continuation, a raised limit) until the person answers it (askAfterNoProgress kept), with a restart case."],
    ["C2-left-5", "minor", "d1109-oversize-pause", "The executor makes run ids with platform newId (random within a millisecond; session/executor.ts:1053), not the store's monotonicId. Under a SimulatedClock that does not move, two runs of one task sort at random by (created_at, id), and task-context's workerRuns can read the older run as 'the last run' (OP-4's composed case failed 2 of 4 concurrent runs until the test moved the clock). Take run ids from monotonicId so composed tests that run two sessions are stable on Windows and Linux CI."],
  ],
  "d1109-chat-depth": [
    ["C2-left-6", "words", "d1109-chat-recall", "Only the read and recall tools call ChatRequest.onStep; the command tools do not (agent.ts registers commands.tools without it), so 'Preparing the change…' and 'Keeping that for later…' exist only in recall-steps.ts and its unit test. When this area draws the step lines, wire the command tools too, and put back the user guide's Chat sentence the recall fix-up removed ('While it looks it says what it is doing (\"Looking through last week's sessions…\")') once the app does it."],
    ["C2-left-7", "minor", "d1109-chat-recall", "The From line's links (recall's RecordSource): the conversation outside any project links to '/talk', which is not a route (routes.tsx has no talk: NotFoundPage), and '/inbox?answered=<id>', '/inbox?request=<id>', '/projects/:id?decision=<id>' and '/changes?projectId=<id>' open the page but those pages do not read the parameter (only Tasks ?task= and Files ?path= do). The From line opens the record it names (the page reads the parameter and shows that record) or draws no link; a null link draws none."],
    ["C2-left-8", "minor", "d1109-chat-recall", "CI risk: packages/runtime/test/conversation.test.ts 'l3-money-engine, run L3: a chat call its timeout cuts off > a typed turn its timeout cuts off before any token records no time to first token' failed under load for the recall fixer and its fix-up ('the chat turn had not answered after 60 s of simulated time'): its pastTimeout helper gives each simulated second only 8 setImmediate ticks, so a real-time wait before the first model call lets the 60 simulated seconds run out first. This area changes the chat's model path and its timeout: make the test wait for the model call to start before it moves the clock (deterministic, not more ticks), keeping what it asserts."],
  ],
  "d1109-onerepo-join": [
    ["C2-left-9", "major, security", "d1109-onerepo-link", "No case in evals/injection/cases covers the repository-marker channel (a project name read from a repository's marker or from a pull request's mark, quoted in the New project offer, the Overview line, the take-over and the chat's tool answers). markerNameOf drops flagged names, and real-daemon cases check the UNTRUSTED_CONTENT envelope, but the round's rule is that the injection suite covers each new channel: add the channel and its cases (hostile names and controls) to pnpm test:injection; this area reads the same markers for Make one project."],
    ["C2-left-10", "major", "d1109-onerepo-link", "readRepository runs on every creation with a repository link (and for this area's Overview reads), and the GitHub host has no request timeout: a GitHub that hangs, rather than refusing, hangs POST /projects, because the fail-open covers only errors. Give the read a timeout that follows the same rule as an error, tested with a host that never answers. Also, pull requests whose authorLogin is null never count as another account's activity: an unknown author counts as another account's (the safe side: no Take it over offered), with a test."],
    ["C2-left-11", "minor", "d1109-onerepo-link", "The take-over sentence does not say when its docs pull request could not be opened (writeMarker swallows a scaffold failure). And when the project's own fr/docs-scaffold pull request was opened before main gained the other project's marker, a later take-over leaves that pull request without the take-over line, and its marker conflicts with main's on merge (reviewer's walk C). The take-over says what it did and what it could not do, and the earlier docs pull request carries the take-over or is replaced."],
    ["C2-left-12", "minor", "d1109-onerepo-link", "The Data tab's import answers a link refusal with 400 while POST /projects and Sources answer 409 with details.cause (one answer at every entry point); MemoryGitHost compares owner and name case-sensitively while GitHub does not (the stand-in agrees with GitHub)."],
    ["C2-left-13", "words", "d1109-onerepo-link", "A together project's Docs rows say 'not written yet' for missing docs, although a together project never writes docs (they say whose project's docs they are, or that this project does not write them); SummaryTab's Take it over error path shows a raw e.message (design section 5 rule 8)."],
  ],
  "d1109-selftasks-run": [
    ["C2-left-14", "minor, security", "d1109-oversize-pause", "The end of a kept-work check's output (OP-3) is quoted in the next brief as JSON-quoted data under '(as data)', like the handoff note and the Left-to-do list, and no injection case covers that channel (a 'brief' channel in evals/src/injection-runner.ts would be new suite work). This area adds the 'report' channel to the injection runner: add the brief's quoted parts (a check output, a handoff note, a Left-to-do list that read like instructions) as cases there or in a 'brief' channel, with controls."],
  ],
};

const triage = [
  ["CL-1", "minor", "d1109-onerepo-link", "OR-12 (cut line): GitHub's repository id is read (RepoInfo.id) but not stored on projects or used by the index, so a renamed or transferred repository is a new link until the project's link is updated (ADR 0117 Consequences)."],
  ["CL-2", "minor", "d1109-onerepo-link", "OR-15's chat path (cut line): project.create has no together flag; for a repository whose project is not on this computer the tool answer ends 'Open New project to work on it together.' (CHAT_TOGETHER_HINT)."],
  ["CL-3", "words", "d1109-onerepo-link", "L3-left-8, carried (not built in C2): the intake docs pull request's branch name still carries the project's id (fr/intake-<id>-docs; intake.ts:158). Renaming it needs the branch-to-project detection (projectIdsNamedBy, isProjectDocsPr) to keep reading every open pull request an earlier version opened, and the take-over and undo checks read that branch. A together project writes no intake branch."],
  ["CL-4", "minor", "d1109-chat-recall", "L3-left-5, carried (not built in C2): after a cancelled task's pull request is closed on GitHub, the chat's '# Your files' still says it was 'Left open on GitHub when their task was cancelled'. The chat never waits on GitHub (d1109-chat-guard) and nothing stores the pull request's state once it is closed there; triage with LL-1 (merge cards stay open after a close on GitHub)."],
  ["CL-5", "words", "d1109-onerepo-link", "Add to it shows no 'Drafting the plan…' state: POST /projects/:id/intake is synchronous, so the dialog shows 'Adding…' for the whole planning call (design 3.3). LC-C2 times the wait on the real model."],
  ["CL-6", "minor", "d1109-onerepo-link", "IntakeProposalBody.docs is now IntakeDocs.default({}) for the first-plan form too: a first-plan reply missing 'docs' is accepted silently (no decision record on the card) instead of being asked again. Require docs unless the plan is plan-only."],
  ["CL-7", "minor", "d1109-onerepo-link", "create-project.ts:113 and :153 use new Date().toISOString() for settings.together.at (AGENTS.md: time goes through a Clock); discovery.ts reads a folder candidate's marker with node:fs readFileSync instead of the discovery's injected fs."],
  ["CL-8", "words", "d1109-onerepo-link", "otherHostSentence hardcodes 'github.com', untrue for an install configured with a GitHub Enterprise API base; takeOverLine can pass 100 characters with a 60-character marker name."],
  ["CL-9", "minor", "d1109-onerepo-link", "The 'Updated by Forerunner from the project's brief' comment path (W15B-13) lost its words test; it is nearly unreachable now: remove it or test it."],
  ["CL-10", "minor", "d1109-chat-recall", "Recall's merge date comes from merge_record.updated_at (recall.ts:487): a later patch, such as the take-out pull request's state, moves it, and a merged record whose work was taken out still reads 'merged on …'."],
  ["CL-11", "minor", "d1109-chat-recall", "Recall ranking: the person's own earlier question lines can outrank the record asked about (after the restart, recall {words: 'the FAQ'} ranked 'what happened to the FAQ task? (you)' r1 ahead of the task 'Write the FAQ'); down-weight the person's question lines, measured against the golden set. Card hits on cards with several questions cut the answer at 160 characters before the later answers, and snippetOf centres on the first query term, not the rarest. LC-C10 watches the real model's choice."],
  ["CL-12", "minor", "d1109-chat-recall", "Recall reads the store once per record (mergeRecord.forTask per done task, sessionRowView per session, statSync per document): fine for the homes measured; watch the chat's latency on a large home (LC-C10) before batching."],
  ["CL-13", "words", "d1109-oversize-pause", "OP-7's drawer line (cut line): the drawer has no line of its own about the spend past the estimate; the card and the result carry the sentence."],
  ["CL-14", "minor", "d1109-oversize-pause", "Test gaps (cut line): OP-5 (the run again in the session) has no composed real-daemon test with a test registry (coder limit per run USD 0.50, session USD 2.00, asserted through the ledger and the model-call log), because the real-daemon harness has no test registry; no real-daemon GET /requests case reads kept_checks from a real kept-work check (no sandbox in that harness). Both are covered at the runner and on the bench."],
  ["CL-15", "minor", "d1109-oversize-pause", "The learned estimate swings a lot (the first Start said the shop 'needs about CHF 6.40'; after one session the card said 'more than its estimate of CHF 1.65'), and OP-7's new sentence shows the swing to the person."],
  ["CL-16", "words", "d1109-oversize-pause", "During OP-5's run again, that run's 'The coder finished … (CHF 0.33)' line is Details-only (the retry audience), so the person's log shows no spend for the second run; the task row and the session total include it."],
];

function place(areas) {
  for (const [key, items] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("C2-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("C2-left-")));
    for (const [id, sev, from, text] of items) {
      a.problems.push(`[${sev}] ${id} (run C step 2's leftover, from ${from}; read ${src(from)}): ${text}`);
    }
    a.acceptance.push(`Run C step 2's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason.`);
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync("/tmp/frbench/leftovers-C2.json", JSON.stringify({
  why: "Run C step 2's leftovers that no later run C area owns. Triage them with live check 4's findings and /tmp/frbench/leftovers-L3.json (the next leftovers run). Sources: /tmp/frbench/runC-C2-{fix,review,fixup}-<key>.json and runC-C2-merge.json problems_left.",
  base: HEAD,
  items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
}, null, 1));

// Live check 4: fold C2's real-model checks into the steps that already make those journeys.
const adds = {
  "LC-C1": "C2 adds (d1109-onerepo-link's review): on home B (another login) link the sandbox repository: the sentence says another GitHub account worked on it on <day> and offers to work on it together here, with only Work together and Cancel; Work together creates no branch, pull request or comment on GitHub; a plan-only card's total line has no docs clause; the Changes row names the project; Undo, then Work together again, brings the same project back.",
  "LC-C2": "C2 adds: time the Add to it wait (the dialog shows 'Adding…' for the whole planning call; no drafting state, CL-5), and check that the real model follows the plan-only rule (the stand-in re-planned all 5 existing titles on the bench).",
  "LC-C8": "C2 adds (d1109-oversize-pause): the wrap-up report's 'Left to do:' starts with the next step and a caveat goes under 'Where I stopped:'; a continuing run whose kept-work check failed follows 'Make a failed check pass first'.",
  "LC-C9": "C2 adds: to see the no-progress question card at the project's budget, set the project budget just below the task's first steps and raise it only a little (a pause at an outer limit wakes only when the spend is under 80% of the raised limit).",
  "LC-C10": "C2 adds (d1109-chat-recall): a question that matches nothing gets the 'what I looked through' wording (the stand-in shows it only when nothing matches at all); on a repeated question, note which hit the real model opens (its own earlier question line ranked first on the bench, CL-11); 'when was the README merged?' gives the merge date, and a task whose pull request was closed on GitHub reads as closed without merging, never as waiting for your Merge; note the latency on the largest home (CL-12).",
};
const l = p.live_check_4;
for (const s of l.steps) {
  s.step = s.step.replace(/ C2 adds(?:(?! C\d\w? adds)[^])*/, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C2)"));
p.session_lead_decisions.push(
  "(C2) CR-9's bound: the agreed recall texts (CHAT_RECALL_RULES and the two definitions, about 640 tokens, plus about 150 of schemas) cannot fit 'at most 700 more input tokens' on a status turn. The test keeps fixed + 160 and at most 1000 over the base re-measured at C2's merge (8355); accepted. Prompt caching (LC-C15) keeps the cost of the fixed part down; revisit if LC-C15 shows the tools are not cached.",
  "(C2) After a pause that got no further, the Tasks row reads 'Paused again without getting further' and the drawer 'Its card in the Inbox asks what to do differently.' (built in C3 as C2-left-1).",
  "(C2) The forerunner-registry repository does not exist yet (BLOCKERS: the owner creates it; the session never creates repositories). evals/registry/ stays the source of truth, so 'sync conversation-agent 1.3.0' (and C3's 1.4.0) waits until it exists: scripts/sync-registry.ts --apply then copies the mirror.",
);

// Wave 8.
p.wave8_amendments = p.wave8_amendments.filter((x) => !String(x).startsWith("(C2)"));
p.wave8_amendments.push("(C2) Recall's spending kind sums the whole project ledger, so in a project two people share, the other person's chat counts as 'the work'. collab-privacy's rule (which replaces scopeOf's) splits it by human_id (d1109-chat-recall's review, non-blocking 10).");

const c2 = p.sub_runs.find((s) => s.name === "C2");
c2.merged = {
  head: HEAD,
  ci: "pending at placement (CI run 43769772412, Desktop app run 43769772305)",
  leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.map((i) => i[0])])),
  leftovers_for_triage: "/tmp/frbench/leftovers-C2.json",
};

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("placed", Object.values(toAreas).flat().length, "in", Object.keys(toAreas).length, "areas; triage", triage.length, "; live steps amended", Object.keys(adds).join(","), "; cap", l.cap_usd);
