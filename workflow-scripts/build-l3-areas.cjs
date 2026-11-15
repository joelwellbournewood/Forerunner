// Builds run L3's areas (live check 3's fixes) into /tmp/frbench/phaseE.json and its args file.
// Usage: node build-l3-areas.cjs <base sha>
const fs = require("fs");
const base = process.argv[2];
if (!base) throw new Error("base sha needed");
const R = JSON.parse(fs.readFileSync("/tmp/frbench/live3-result.json", "utf8"));
const P = JSON.parse(fs.readFileSync("/tmp/frbench/phaseE.json", "utf8"));
const C = JSON.parse(fs.readFileSync("/tmp/frbench/runC-plan.json", "utf8"));

const F = {}; const V = {};
for (const j of R.results) {
  for (const f of j.live.findings) F[f.id] = { ...f, journey: j.journey };
  for (const v of j.verified) V[v.id] = v;
}

const AREAS = [
  {
    key: "l3-merge",
    ids: ["L3-github-1", "L3-github-2", "L3-github-3", "L3-github-10", "L3-github-7", "L3-github-9"],
    title: "Merge side after live check 3: Merge in the app never puts a closed pull request's work on main, a merge card closes as soon as the pull request is merged (also on GitHub), the Merge press answers a moved head with its own sentence at once, a cancelled task's open pull request stays listed where the person looks (Overview, chat, the cancel read-back), and the rebuilt-without card's words fit what happened",
    decisions: [
      "A pull request the person closed on GitHub is work they dropped: no Merge pressed in Forerunner (Overview, chat, palette, a card) ever puts its changes on main through a dependent. The press gets the same check of what the branch holds that the session's merge gets (dependentBranches.mergePort and PrTaskExecutor.rebuildTask), at the press and again in the merge step (R-lock, ADR 0111: merge never merges an unrebuilt head).",
      "Every merge sentence says what will happen: the press never answers 'Merging #N.' when the step is about to refuse; a record that is already merged answers that it is merged.",
      "A card is closed as soon as what it asks no longer needs the person: every open merge card of a task (head moved, rebuilt without, rebuild conflict, conflict notice) is withdrawn when its pull request is merged, by Forerunner or seen merged on GitHub; chat's open requests then no longer carry it.",
      "A cancelled task's pull request that is still open on GitHub stays named where the person looks (the Overview's own heading with Open and no Merge, the chat's file facts, the cancel read-back and Yes line) until GitHub says it is closed; Forerunner never merges or closes it by itself (ADR 0105 point 4).",
      "The verifiers' fix sketches below are a starting point, not a contract: follow them unless the code at the base shows a simpler way that keeps every decision above; say which in the report.",
    ],
    files: [
      "packages/runtime/src/daemon/pull-requests.ts (chainOf, merge(), the view's cancelled rows)",
      "packages/runtime/src/loop/merge.ts (the person's and retry authorities' check before claim)",
      "packages/runtime/src/session/dependent-branches.ts (checkBeforeMerge, closedOnHost, mergedOnHost closing cards)",
      "packages/runtime/src/session/pr-answers.ts (applyRebuildMerge on a merged record)",
      "packages/runtime/src/daemon/compose.ts (wiring only)",
      "packages/runtime/src/daemon/request-words.ts and the merge card words (the rebuilt-without card's steps, the head-moved title cut with balanced quotes)",
      "packages/runtime/src/conversation/project-facts.ts (cancelled tasks' open pull requests)",
      "packages/runtime/src/daemon/cancel-words.ts, packages/runtime/src/daemon/api-types.ts (a cancelled row kind if needed)",
      "apps/ui/src/pages/project/SummaryTab.tsx (the cancelled heading), apps/ui/test/fake-daemon.ts (mirror)",
      "tests: packages/runtime/test/dependent-branches-merge.test.ts, apps/ui/test/real-daemon.test.ts, commands.test.ts, tasks.test.tsx (append-only describe 'l3-merge, run L3')",
      "docs: ADR 0111 and ADR 0105 dated amendments, docs/maintainers/runtime.md (merge section), docs/maintainers/apps.md, the user guide's merge-card paragraph",
    ],
    size: "medium-large: 6 items; L3-github-1 and L3-github-2 are the larger ones (composed chain tests with the fake GitHub and real git, a restart case for the withdrawn cards), L3-github-3 and L3-github-10 medium, the two words items small. Cut line: L3-github-10's optional Close button and L3-github-1 part 3 (closed work that already reached main) may end in not_done with the reason.",
  },
  {
    key: "l3-handoff-checks",
    ids: ["L3-research-1", "L3-research-2", "L3-research-4"],
    title: "End of a run after live check 3: a finished run whose hand-over says nothing is left for the criteria goes to its review instead of a budget pause, the budget-pause card lists its items whole and agrees with the session on what was spent, and JavaScript tests in a folder with no package.json are run by a node --test marker check",
    decisions: [
      "Done work is reviewed (W15-14): a run's hand-over that says nothing is left for the criteria, with or without a reason after it, never pauses the task; caveats and what the run did not cover are notes for the critic, not Left to do.",
      "A code task's tests always run, whatever the language (the owner's C-3, ADR 0104, ADR 0110): JavaScript test files with no package.json test script are run with node --test like Python, Rust and Go marker checks; a failing node:test file blocks an accept.",
      "The budget-pause card's Done and Left items are listed whole as items (never cut in mid-phrase and joined), and its headline agrees with the session line on what was spent ('paused before its budget of CHF 0.15 ran out: it spent CHF 0.09').",
      "Run C's d1109-oversize-pause (C2) lists parseHandoff's rules under Do not touch and builds on this area: keep parseHandoff's signature and the leftToDo/optional fields; say in notes_for_other_areas exactly what the rules now accept.",
    ],
    files: [
      "packages/runtime/src/session/budget-pause.ts (NOTHING, parseHandoff), packages/runtime/src/session/executor.ts (only if the pause condition needs it)",
      "the budget-pause card's words (where the Done/left items are joined) and its title",
      "packages/runtime/src/loop/project-checks.ts (markerChecks JavaScript entry, untestedFiles), packages/runtime/src/loop/try-plan.ts (if node --test must be tried), packages/runtime/src/loop/verification.ts (the brief's list of checks)",
      "tests: budget-pause.test.ts and try-plan.test.ts / project-checks tests (append-only describe 'l3-handoff-checks, run L3'), executor-brief.test.ts for the brief line, a composed stand-in test with a folder that has wc.js and wc.test.js and no package.json",
      "docs: ADR 0112 (W15-14 amendment, dated line), ADR 0110 rule 5 amendment, docs/maintainers/runtime.md (the Paused paragraph and 'Other languages' tests')",
    ],
    size: "medium: 3 items; L3-research-4 is the larger one (a sandboxed marker check with its probe and notRun reasons, a composed test), L3-research-1 medium (regex plus list rule with the live reply as a fixture), L3-research-2 small.",
  },
  {
    key: "l3-money-engine",
    ids: ["L3-run-5", "L3-run-2", "L3-run-8", "L3-run-10"],
    title: "Money and the session review after live check 3: a call cut off by Stop now is booked once on the ledger, the session and the task, the session review compares the work with the plan's estimate the person was shown (a task tried again is counted once), a session whose task only waits for the person's answers is not 'sent back for changes', and a review-only pass says it is a review",
    decisions: [
      "Every model call's cost is booked once, on the ledger, the session and the task, also when Stop now cuts it off: Costs, the session and the task agree, and Costs can be compared with the Anthropic console.",
      "The session review's 'estimate' is the plan's estimate the person saw on the plan line and the Start dialog; a task taken again after a send-back is one planned task, and its second attempt's cost is named as such in an overrun finding.",
      "Session review words say what the person can do: a session whose only task waits for the person's answers says the work waits for their answers, not 'sent back for changes'.",
      "No log line says a review started that never ran; a review-only pass plans and names the review's cost, not the writer's estimate.",
      "Run C's d1109-selftasks-chat (C6) also edits critic/src/session-review.ts (SC-13 at the split or dropped task count) and d1109-chat-depth (C3) relies on the loop's abort branch for D3-12: say in notes_for_other_areas what changed in planEstimateOf, the duplicate check and the abort branch.",
    ],
    files: [
      "packages/runtime/src/agent/loop.ts (the abort branch books the cut-off call through hooks.afterModelCall and emits model_call_end), packages/runtime/src/enforcement/hooks.ts (afterStop booking if needed)",
      "packages/runtime/src/session/runner.ts (replan marks a retaken task and leaves the plan total alone; the review-only plan line), packages/critic/src/session-review.ts (planEstimateOf, the same-task-twice check, the questions-only verdict words)",
      "packages/runtime/src/daemon/views.ts (the 'Session review measured' line), packages/testenv/src/bench/role-player.ts (stand-in usage on message_start, if needed)",
      "tests: loop and runner unit tests, a composed Stop-now test that compares the ledger, the session's spend and the task's cost, session-review tests (append-only describe 'l3-money-engine, run L3')",
      "docs: docs/maintainers/critic.md (Session review), docs/maintainers/runtime.md (replan, kill mid-run), docs/maintainers/adding-a-provider.md:33-36; remove the owner-checklist line 'aborted calls are booked at CHF 0 today' from wherever the checklist keeps it in the repository (say where in the report)",
    ],
    size: "medium: 4 items; L3-run-5 and L3-run-2 medium (each with a composed test), L3-run-8 and L3-run-10 small words items. Cut line: L3-run-10's plan line may end in not_done with the reason if the review-only pass has no plan line of its own today.",
  },
  {
    key: "l3-money-screens",
    ids: ["L3-run-3", "L3-run-4", "L3-run-13"],
    title: "Money on the screens after live check 3: the Tasks row's budget line says which figure the task budget counts (the work, not the reviews), the task drawer's run line follows the spend while a run goes on, and Costs leaves out zero lines",
    decisions: [
      "Every money number on a screen says what it counts, and two numbers side by side measure the same thing: the row's cost stays the ledger's figure (ADR 0112 amendment 6); the budget line beside it states the work's figure the budget counts (the daemon's task.cap, the same figure as the run's 'This run may spend CHF X' line). Making the task budget count reviews too is an engine change the owner has not asked for: not in this area.",
      "A screen that shows a running figure follows it: the drawer's run line moves with each call, without bumping the task's version (ADR 0112 point 6).",
      "No zero counts (design section 5.5): a Savings line of CHF 0.00 and 0 tokens is left out.",
      "Run C's d1109-oversize-pause (C2) adds a drawer line 'Spent CHF X of about CHF Y' and d1109-cred-screens (C6) owns the drawer's run line words (drawerRunLine): keep to the useAsync key and TaskCap; say in notes_for_other_areas which figure each line uses.",
    ],
    files: [
      "apps/ui/src/pages/project/TasksTab.tsx (TaskCap and its tooltip), apps/ui/src/pages/project/TaskDrawer.tsx (the detail's re-read key only), the Costs tab's savings rows",
      "apps/ui/test/fake-daemon.ts (mirror), apps/ui tests (append-only describe 'l3-money-screens, run L3'), a Playwright check of the drawer during a run against the real daemon with the stand-in",
      "docs: ADR 0112 amendment 6 (dated line), docs/maintainers/apps.md (tasks tab, TaskCap, TaskDrawer), the user guide's budget line",
    ],
    size: "small-medium: 3 items, all UI; L3-run-4 needs a test that shows the run line moving while the version stays.",
  },
  {
    key: "l3-chat-claims",
    ids: ["L3-run-1", "L3-run-9"],
    title: "Chat after live check 3: the chat never says it changed something or asked for a yes unless a tool did in that turn (the history carries what each turn actually did, the prompt says so, and a guard catches a claim with no tool), and the read-back of 'any public website' says only that when nothing is listed",
    decisions: [
      "The chat never says a setting changed, a request was sent or a change waits for the person's yes unless a command in that same turn answered so (design: a sentence promises only what the app does). When it called no tool it says nothing changed.",
      "The history the model reads carries what each earlier turn actually did (the reply's own action sentences, from the stored rows, deterministic), so the prompt-cache prefix stays byte-stable (keep the R-chatcache test green).",
      "Model-facing prompts are code: change conversation-agent.md (bump its version) and CHAT_RETRIEVAL_RULES in the repository and assert the exact text the model receives; the guard's patterns are English and German like the rest of the chat's patterns.",
      "Run C's d1109-chat-recall (C2) and d1109-chat-depth (C3) rework agent.ts, the history and conversation-agent.md after this area: keep historyMessages' signature, say in notes_for_other_areas the exact lines added to the history and the prompt, and where the guard sits so they can keep it.",
      "What only the real model shows (that Haiku now calls settings_set for 'research may read any public website again') is a live check 4 step: write it as check_in_the_app.",
    ],
    files: [
      "packages/runtime/src/conversation/transcript.ts (historyMessages), packages/runtime/src/conversation/agent.ts (history into the request, the reply guard after the run, CHAT_RETRIEVAL_RULES)",
      "evals/registry/principals/conversation-agent.md (the 'Say so plainly when asked' line and the new rule; version bump)",
      "packages/commands/src/commands/settings.ts and its words (the web access read-back and confirmation line when the never list is empty)",
      "tests: conversation agent unit tests asserting the exact request (append-only describe 'l3-chat-claims, run L3'), the R-chatcache/PromptCacheSim test, the injection suite (pnpm test:injection) since the history now carries more stored text, commands.test.ts for the read-back",
      "docs: docs/maintainers/conversation.md (or the chat's maintainer page), ADR 0091 or the chat ADR that owns the history (dated amendment)",
    ],
    size: "medium: 2 items; L3-run-1 is the larger one (history, prompt, guard, each asserted), L3-run-9 small.",
  },
  {
    key: "l3-small",
    ids: ["L3-github-4", "L3-run-6", "L3-github-6", "L3-github-8", "L3-run-7", "L3-run-11", "L3-run-12", "L3-research-3"],
    title: "Small fixes after live check 3: the brief's 'person's note' holds only what the person typed, a same-title word from a refusal keeps picking its task after a pause or a state change, and no ids or raw labels in what Forerunner writes or shows (the status file and the docs branch on GitHub, commit messages in the person's folder, the session Details, the specialist's quoted reason, a refused write, possessives of project names)",
    decisions: [
      "The brief tells the agent only what the person said: a Changes-page label (Redo, Edit <title>) is never 'the person's note'; a typed note reaches the brief once.",
      "A word the app offered to tell two tasks apart keeps working after a pause, a pull request or a state change: any kind of tag that tells the tasks apart picks one (pull request number, state word, age word); the refusal's own sentence stays as W15-37 built it.",
      "No ids in text Forerunner writes for a person (W15-08, design section 5.3): the status file on GitHub, the intake docs branch name if it can change without breaking how existing branches are found (else say why in not_done), the commit messages in the person's folder, the session Details (events in words, no raw JSON), the specialist's quoted reason (no severity tag), a refused step's line names what was refused.",
      "Possessives of project names read as plain English ('on the Overview of Kite trips', not 'Kite trips's Overview'), as P7-28 did for host names.",
      "Run C's d1109-oversize-pause (C2) edits task-context.ts (whereTheLastRunStopped and its call): keep to personNoteOn and its section. d1109-chat-recall's CR-2 reuses the same-title pickers: export them and say so in notes_for_other_areas. d1109-selftasks-run/-chat (C4/C6) record agent-actor command turns: say how personNoteOn now tells the person's typed note from an agent's.",
      "The words items were found on screen and not checked in code: confirm each at the base first; one already right goes in not_done with the evidence.",
    ],
    files: [
      "packages/runtime/src/session/task-context.ts (personNoteOn and its section), packages/runtime/src/daemon/server.ts (labels only if needed)",
      "packages/commands/src/commands/task.ts (sameTitleTags, findTask: the pickers)",
      "packages/runtime/src/loop/docs.ts (the status file's heading and note line), the intake docs branch name (packages/runtime/src/session/intake.ts) only if safe",
      "the workspace snapshot commit message (where 'Workspace before ... (task <id>)' is written)",
      "packages/runtime/src/session/runner.ts stepLine (the refused step's words only)",
      "apps/ui: the session Details events, the Settings rows and the Who merges dialog (possessives)",
      "the questions card's quoted reason (where 'The specialist said:' takes the findings text) and the Reviews 'To fix' line",
      "tests: executor-brief.test.ts, commands tests, docs and UI tests (append-only describe 'l3-small, run L3')",
      "docs: docs/maintainers/commands.md (W15-37 note), the brief's maintainer page, docs/maintainers/apps.md",
    ],
    size: "medium: 8 small items; L3-github-4 and L3-run-6 are code with a composed or unit test each, L3-run-12 the largest words item (event words in Details). Cut line: L3-run-12 may keep the raw view behind a 'Show the raw events' disclosure if words for every event type would be too much; the intake branch name may end in not_done.",
  },
];

const str = (x) => (x == null ? "" : typeof x === "string" ? x : JSON.stringify(x));
const areas = AREAS.map((A) => {
  const problems = []; const root_causes = []; const acceptance = []; const fixes = [];
  for (const id of A.ids) {
    const f = F[id]; const v = V[id];
    if (!f) throw new Error("no finding " + id);
    problems.push(
      `[${f.severity}] ${id} (live check 3, step ${f.step}): ${f.title}. The person sees: ${str(f.what_the_person_sees)} Expected: ${str(f.expected)} Evidence: ${str(f.evidence)} Repro: ${str(f.repro)}` +
        (v ? ` Verified real at 7d6b34a, still at ${base.slice(0, 7)} ${v.still_at_head === "yes" ? "(yes)" : "(" + v.still_at_head + ")"}: ${str(v.head_note)}` : ` Not checked in code (a words item found on screen); suspected cause: ${str(f.suspected_cause) || "not given"}.`),
    );
    if (v) {
      root_causes.push(`${id}: ${str(v.root_cause)} Where: ${str(v.where)}`);
      fixes.push(`${id} (the verifier's sketch): ${str(v.fix_sketch)}`);
      acceptance.push(`${id}: failing test first, at the person's boundary where the person uses it: ${str(v.failing_test_idea)}`);
      if (v.notes) root_causes.push(`${id} verifier's notes: ${str(v.notes)}`);
    } else {
      acceptance.push(`${id}: a test asserting the exact new words where they are made, plus the screen or GitHub text the person sees (UI test or the real-daemon case); judged by design section 5.`);
    }
  }
  acceptance.push(
    "Every item: the failing test written and seen failing at the base first; then the fix; full suite green (pnpm check, pnpm test:integration, pnpm test:e2e, the UI suite, pnpm test:injection where the chat or a record channel is touched); a restart case wherever a state must survive (validation rule 4); the siblings of each fix checked and named (validation rule 8); a bench before/after walk with the stand-in for the person-facing items; check_in_the_app steps for live check 4 in the report.",
  );
  return {
    key: A.key,
    title: A.title,
    problems,
    decisions: [...A.decisions, ...fixes],
    u_entries: [
      "No new U-entry: give check_in_the_app steps for each fixed item in the report (what to do, what the person should see); the session lead adds them to the U-entry the behaviour belongs to and to live check 4.",
    ],
    root_causes,
    fix_scope: `Run L3 (wave 23): the fixes for live check 3's findings (live check 3 ran wave 15's code, 7d6b34a, with the real model and forerunner-sandbox on 2026-11-15; its full result is /tmp/frbench/live3-result.json, evidence under /tmp/frbench/live3/<journey>/). Base ${base} (run C sub-run C1 merged after 7d6b34a: d1109-chat-guard, d1109-oversize-start, d1109-sessions; check every root cause at the base). Run L3 runs before run C's C2 to C6, which build on it. Built beside the other L3 areas from the same head; they meet only at the merge step (order: ${AREAS.map((a) => a.key).join(", ")}).`,
    files: A.files,
    acceptance,
    depends_on: [`Base ${base}: wave 15 and run C's C1 merged. No other L3 area.`],
    handoff_items: A.ids,
    owner_questions: [],
    size: A.size,
  };
});

// Replace any earlier L3 areas, then add.
P.areas = P.areas.filter((a) => !a.key.startsWith("l3-")).concat(areas);

// Triage entries for every finding.
P.triage = P.triage.filter((t) => !String(t.n).startsWith("L3-"));
const areaOf = {};
for (const A of AREAS) for (const id of A.ids) areaOf[id] = A.key;
areaOf["L3-github-5"] = "d1109-onerepo-link";
for (const id of Object.keys(F)) {
  const f = F[id]; const v = V[id];
  P.triage.push({
    n: id,
    item: `${f.title} (${f.severity}, live check 3 step ${f.step})`,
    decision: areaOf[id] ? (areaOf[id].startsWith("l3-") ? "fix (run L3)" : "fix (run C, C2)") : "later",
    area: areaOf[id] || null,
    evidence: str(f.evidence).slice(0, 1500),
    note: v ? `Verified real at 7d6b34a; still at ${base.slice(0, 7)}: ${v.still_at_head}. ${str(v.area_hint).slice(0, 600)}` : "Words item found on screen; not checked in code.",
  });
}
const missing = Object.keys(F).filter((id) => !areaOf[id]);
if (missing.length) throw new Error("unassigned: " + missing.join(", "));

// github-5 goes to d1109-onerepo-link (D1-9, OR-09): add the live evidence.
const g5 = F["L3-github-5"]; const v5 = V["L3-github-5"];
const g5line = `[words] L3-github-5 (live check 3, 2026-11-15, the same problem as D1-9 seen live at 7d6b34a and still at ${base.slice(0, 7)}): ${str(g5.what_the_person_sees)} Evidence: ${str(g5.evidence)}. The verifier's sketch: ${str(v5 && v5.fix_sketch)} This includes the hand-opened, unmarked status pull request case (#36 on forerunner-sandbox), which is no project's: its note must not name a project.`;
for (const doc of [P, C]) {
  const a = doc.areas.find((x) => x.key === "d1109-onerepo-link");
  a.problems = a.problems.filter((x) => !x.includes("L3-github-5")).concat(g5line);
  if (!a.handoff_items.includes("L3-github-5")) a.handoff_items.push("L3-github-5");
}

// Run C areas that build on run L3: a depends_on line.
const dep = {
  "d1109-onerepo-link": "Run L3 merged first: l3-merge changed pull-requests.ts merge(), chainOf and the view (cancelled rows); keep them (read its notes_for_other_areas in /tmp/frbench/runL3-l3-merge-*.json).",
  "d1109-oversize-pause": "Run L3 merged first: l3-handoff-checks changed parseHandoff's rules and added the node --test marker check; l3-small changed task-context.ts personNoteOn; l3-money-screens set the drawer's re-read key and TaskCap's figure. Read their notes_for_other_areas (/tmp/frbench/runL3-*-fix*.json).",
  "d1109-chat-recall": "Run L3 merged first: l3-chat-claims changed historyMessages, the reply guard and conversation-agent.md; l3-small exported the same-title pickers CR-2 reuses. Read their notes_for_other_areas.",
  "d1109-chat-depth": "Run L3 merged first: l3-chat-claims changed the history and the prompt (keep the guard); l3-money-engine made the loop's abort branch book the cut-off call (D3-12 builds on it). Read their notes_for_other_areas.",
  "d1109-selftasks-chat": "Run L3 merged first: l3-money-engine changed session-review.ts planEstimateOf and the same-task-twice check. Read its notes_for_other_areas.",
  "d1109-selftasks-run": "Run L3 merged first: l3-small changed how personNoteOn tells the person's typed note from other change rows. Read its notes_for_other_areas.",
  "d1109-cred-screens": "Run L3 merged first: l3-money-screens changed the drawer's re-read key and TaskCap. Read its notes_for_other_areas.",
};
for (const doc of [P, C]) for (const [k, line] of Object.entries(dep)) {
  const a = doc.areas.find((x) => x.key === k);
  if (!a) continue;
  a.depends_on = a.depends_on.filter((x) => !x.startsWith("Run L3 merged first")).concat(line);
}

// shared_files rule for run L3.
const sfRule = `Run L3 (base ${base.slice(0, 7)}, wave 23, the live check 3 fixes; merge order ${AREAS.map((a) => a.key).join(", ")}): l3-merge owns pull-requests.ts merge(), chainOf and the view's cancelled rows, merge.ts's check before claim, dependent-branches.ts, pr-answers.ts applyRebuildMerge, request-words.ts's merge-card words, cancel-words.ts and project-facts.ts's pull request facts; l3-handoff-checks owns budget-pause.ts, project-checks.ts and verification.ts's checks line; l3-money-engine owns loop.ts's abort branch, runner.ts's replan and review-only plan line, critic/session-review.ts and views.ts's session review line; l3-money-screens owns TasksTab.tsx TaskCap, TaskDrawer.tsx's re-read key and the Costs savings rows; l3-chat-claims owns transcript.ts historyMessages, agent.ts's history and reply guard, conversation-agent.md and settings.ts's web access words; l3-small owns task-context.ts personNoteOn, commands task.ts sameTitleTags/findTask, docs.ts's status file words, runner.ts stepLine, the snapshot commit message, the session Details and the Settings possessives. apps/ui/test/fake-daemon.ts and the append-only test files: each area adds its own describe block ('<key>, run L3'). Run C's later rules still decide in the files they name, for the regions they name.`;
P.shared_files = P.shared_files.filter((x) => !String(x).startsWith("Run L3 (")).concat(sfRule);

// runC-plan: record run L3.
C.run_L3 = {
  why: "Live check 3 (2026-11-15, 7d6b34a, USD 2.04 of 3.00) found 27 problems: 4 major, 9 minor, 14 words; the 14 major and minor ones were checked in code and are real and still at the base. All but L3-github-5 (D1-9, in d1109-onerepo-link) are outside run C's areas, and several touch files C2 to C6 build on, so they are fixed first.",
  base,
  wave: 23,
  keys: AREAS.map((a) => a.key),
  findings: Object.fromEntries(Object.keys(F).map((id) => [id, areaOf[id]])),
};

fs.writeFileSync("/tmp/frbench/phaseE.json", JSON.stringify(P, null, 1));
fs.writeFileSync("/tmp/frbench/runC-plan.json", JSON.stringify(C, null, 1));

// Args.
const note = [
  `This is run L3: the fixes for live check 3's findings, before run C's sub-runs C2 to C6 (the owner's decisions of 2026-11-09 are in /tmp/frbench/owner-decisions-2026-11-09.md; run C's plan is /tmp/frbench/runC-plan.json, whose run_L3 section says why this run comes first). Base ${base} (wave 15 and run C's C1 merged; CI and the Desktop app workflow green).`,
  `Live check 3 ran wave 15's code (7d6b34a) with the real model and forerunner-sandbox; its whole result, with each verifier's root cause, fix sketch and failing-test idea, is /tmp/frbench/live3-result.json (results[].live.findings and results[].verified), its evidence under /tmp/frbench/live3/<journey>/. Your area spec quotes the parts that matter; re-check each root cause at the base, since C1 changed some files after 7d6b34a.`,
  `Run C's later areas (C2 to C6) build on yours: keep the functions, fields and shapes they use (your spec's decisions name them) and say in notes_for_other_areas exactly what you changed in them.`,
  `The common rule holds even where a spec's files list names them: do not edit docs/status/UPDATE-LOG.md, CHANGELOG.md, docs/requirements.md or docs/design/core-experience.md (the session lead writes them from your report: put suggested lines in it). Maintainer docs, dated ADR amendments appended at the end, and user-guide paragraphs: yes. No new ADR unless a decision changes; then say so and propose its text in the report.`,
  `Security in every area: never weaken the hooks or the sandbox; text from pages, searches, files, cards, chat history, reports or any record never becomes instructions to a model (quoted as data; the injection suite pnpm test:injection covers each channel you widen); the page reader never reaches this PC or the home network. Money and the person's control: no budget, wrap-up line, monthly cap or plan-share cap is ever passed; spend is booked and shown in CHF; when the app says it waits, nothing moves; no session starts unless the person said so. Model-facing prompts and tool definitions are code: change them in the repository and assert the exact text the model receives. Tests use the stand-ins; no real API calls and no GitHub calls; what only the real model shows goes to live check 4: write your check_in_the_app steps so the session lead can run them there.`,
  `Words the person sees follow design section 5: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does.`,
  `Merge order: ${AREAS.map((a) => a.key).join(", ")}. In a conflict, keep each area's owned part as the shared_files rule that starts 'Run L3 (' says, and both areas' intent; in the append-only test files keep every area's describe block ('<key>, run L3'); a later area that rewords a sentence updates the earlier area's assertion.`,
  `Reviewers: besides the acceptance lines, re-run the live repro of each finding against the fix with the stand-in where it can be (the finding's repro), check every new or changed person-facing sentence against design section 5, the siblings of each fix (validation rule 8), and a restart case wherever a state must survive (validation rule 4): no less and no more.`,
].join(" ");
const args = { wave: 23, keys: AREAS.map((a) => a.key), noMerge: false, note, fixNotes: {} };
for (const A of AREAS) args.fixNotes[A.key] = `Your area fixes ${A.ids.join(", ")} from live check 3. Its size and cut line: ${A.size}`;
fs.writeFileSync("/tmp/frbench/runL3-args.json", JSON.stringify(args, null, 2));
console.log("areas", areas.map((a) => `${a.key}: ${a.problems.length} problems, ${JSON.stringify(a).length} bytes`).join("; "));
console.log("triage +", Object.keys(F).length, "args bytes", JSON.stringify(args).length, "note chars", note.length);
