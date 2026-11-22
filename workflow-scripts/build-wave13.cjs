// Builds wave 13's spec in /tmp/frbench/phaseE.json: polish-words and polish-screens (from
// wave7g6b-areas.json, with the wave 12/14 reports' words added), and two new logic areas,
// leftovers7-tailmerge and leftovers7-tailrun, for the leftovers the wave 14 reviews and fixers
// listed. Backs up phaseE.json first.
const fs = require("fs");
const P = "/tmp/frbench/phaseE.json";
const B = "/tmp/frbench/wave7g6b-areas.json";
fs.copyFileSync(P, "/tmp/frbench/phaseE.before-wave13.json");
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const b = JSON.parse(fs.readFileSync(B, "utf8"));
const R = (f) => `/tmp/frbench/${f}.json`;

if (p.areas.some((a) => ["polish-words", "polish-screens", "leftovers7-tailmerge", "leftovers7-tailrun"].includes(a.key)))
  throw new Error("wave 13 areas already in phaseE.json");

const words = JSON.parse(JSON.stringify(b.areas.find((a) => a.key === "polish-words")));
const screens = JSON.parse(JSON.stringify(b.areas.find((a) => a.key === "polish-screens")));

const AT = "Line numbers in this area's evidence are from fa1a86f; the base of wave 13 is ce13bb1 (waves 12 and 14 merged on top: leftovers7-merge, leftovers7-session, leftovers7-web, leftovers7-merge2 and their fix-ups), so re-find each place at HEAD. An item those areas already fixed or changed: confirm at HEAD first; if it no longer fails, say so in not_done with the evidence instead of changing code.";

// ---- polish-words additions -------------------------------------------------------------
words.problems.push(
  `[polish] W14-1: every person-facing sentence waves 12 and 14 added or changed is reviewed against design §5 (one sentence read at a glance, CHF only, no ids, what needs you first, the limits per kind) and fixed where it breaks a rule. The areas listed them in notes_for_other_areas of ${R("wave7g6a-fix-merge")}, ${R("wave7g6a-fix-session")}, ${R("wave7g6c-fix-leftovers7-web")}, ${R("wave7g6c-fix-leftovers7-merge2")}, ${R("wave7g6c-fixup-leftovers7-merge")}, ${R("wave7g6c-fixup-leftovers7-session")} and ${R("wave7g6c-fixup-leftovers7-merge2")} (read each whole). Among them: mergedUpdateWords 'Merged #N: "<title>".', redoWhileTakingOutSentence, the rebuild card's Merge/Redo explains, the conflict notice's title, body and Redo explanation (request-words.ts), the later-merge notification's title and body, 'Stopped: Anthropic refused the credential', the credential wait labels per task, 'Nothing can run yet. ' + waitSentence, 'the browser did not start (...)', the reader refusal '... list, which names no website', and the model-facing repoFileFlaggedNote (model-facing: clear, not §5's length rules). The 'Research reads:' / 'Only these websites:' lines are polish-screens' (webAccessWords).`,
  `[polish] W14-2: the Update 'Merged #3: "Write the guide".' (a merge made later by the retry pass) names no project, while the session Updates do ('Two guides: did 2 tasks…'). Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[2]; loop/merge.ts mergedUpdateWords.`,
  `[polish] W14-3: the rebuild card's body ends 'look at it before you merge it, or send it back.' while its button is Redo; its why starts 'The critic accepted X, but pull request #6 was not merged.'; after Redo the Overview's Decisions line reads that why ('The critic accepted "Write the welcome page in index.html", but pull request #4 was not merged. Redo.'), not what the card was about (the conflict). Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[2], ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[8]; request-words.ts rebuild card, the Decisions line's source.`,
  `[polish] W14-4: the repo.create failure warning names the card as 'change card "a GitHub repository for X"' (a kind name a person never saw). Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[2] and the walk 8 Update quoted in its blocking[0].`,
  `[polish] W14-5: merge-side lines in git words or out of date. The Tasks row of a pull request that conflicts with main still reads 'Accepted · waiting for you to merge' (task-words.ts merge state: read the record's conflict outcome); the rebase-conflict card that the conflict notice's paths lead to shows a branch name ('Rebase of fr/e34de89b-write-the-welcome-page-in-index.html onto main conflicts in…'); the Files line that says this computer's copy stopped following is three sentences (loop/docs.ts copy words). Evidence: ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[8].`,
  `[polish] W14-6: money that reads as a contradiction. Tiny amounts round down to CHF 0.00: 'Stopped at the project's budget of CHF 0.01. CHF 0.00.' and 'The coder finished … (CHF 0.00)' while the budget has no room (a spend of CHF 0.005). The plan card's per-task values do not add up to its rounded total ('about CHF 0.01' + 'about CHF 0.02' with 'About CHF 0.04 for the 2 tasks'). 'It goes on by itself once that limit is raised or resets' is said of a project budget, which never resets (result.ts:392, task-words.ts:250 at ca2c58d). One money rule for all of them (e.g. a spent amount under CHF 0.01 reads 'less than CHF 0.01'; per-task figures and the total rounded so they agree, or the total not claiming a sum). Evidence: ${R("wave7g6a-fix-session")} new_problems[1], ${R("wave7g6c-review-leftovers7-session")} non_blocking[8], [9], [10].`,
  `[polish] W14-7 (C-59, same-titled tasks): besides the branch name, the Overview's Next list uses \`<li key={s}>\` and two tasks named 'Write the guide' give 11 React duplicate-key console errors (SummaryTab.tsx:162/:187 at ca2c58d); Chat 'redo Write the guide' answers 'Say more of the title, for example "Write the guide"', which cannot work when the titles are identical; the two pull request rows read the same. Key by task id; let Chat tell same-titled tasks apart by something a person sees (the order, the pull request number). Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[3].`,
);
words.acceptance.push(
  "W14-1: each wave 12/14 sentence the reports list is either unchanged and within design §5 (named in the report's notes as checked) or reworded with its test at the boundary that serves it.",
  "W14-2..W14-5 (real-daemon, polish-words block): the later-merge Update names the project; the rebuild card's body names the button it offers and its why says what is wrong now; the repo.create warning names the card by what it asked; a conflicting pull request's Tasks row says it conflicts with main; no card or row shows a branch name.",
  "W14-6: GET /sessions/:id, the budget-stop card and the plan card at a CHF 0.01 budget (fixture): no 'CHF 0.00' beside a budget with no room; the plan card's per-task figures and total agree; a project budget's stop says nothing about a reset.",
  "W14-7: two tasks with the same title: the Overview renders with no duplicate-key error (UI test spying console.error), each has its own row and pull request line, and Chat can redo the second one.",
);
words.depends_on.push(
  "wave 14 merged at ce13bb1 (leftovers7-web, leftovers7-merge2 and the fix-ups of leftovers7-merge and leftovers7-session): their new sentences are W14-1's input.",
  "runs beside leftovers7-tailmerge and leftovers7-tailrun (wave 13): they own the logic named in shared_files; this area changes only the sentences there. leftovers7-tailrun owns the paused-review budget card's flag and sentence (pausedWorkSentence in request-words.ts): do not change that function.",
);
words.fix_scope = AT + " " + words.fix_scope;

// ---- polish-screens additions -----------------------------------------------------------
screens.problems.push(
  `[polish] W14-8: the site rule's new lines from leftovers7-web: 'Research reads: no website' and 'Only these websites: none' (webAccessWords, an empty 'only' list since R-failopen) are reviewed against design §5 with the rest of P7-31/P7-32. Evidence: ${R("wave7g6c-fix-leftovers7-web")} notes_for_other_areas; ${R("wave7g6c-review-leftovers7-web")} non_blocking[12].`,
  `[polish] W14-9: the project's Sessions tab (/projects/:id/sessions) shows no CHF per session; GET /sessions already serves each session's spend and the session page shows it. Show each session's CHF on its row (one figure, CHF). Evidence: ${R("wave7g6c-fixup-leftovers7-session")} new_problems[0].`,
);
screens.acceptance.push(
  "W14-8: the Overview and Settings lines for an empty 'only' list read within design §5, asserted in web-access and project-overview tests.",
  "W14-9: the Sessions tab lists each session with its CHF (UI test with the fake daemon; real-daemon reads GET /sessions' figure for the same session).",
);
screens.depends_on.push(
  "wave 14 merged at ce13bb1; runs beside leftovers7-tailmerge and leftovers7-tailrun (wave 13). leftovers7-tailrun owns GET /projects/:id/start-check and StartSessionDialog's line while the plan is drafted or queued (its TR-12): polish-screens keeps planSentence, waitsOnText, BlockerLines' budget lines and budgetProblem.",
);
screens.fix_scope = AT + " " + screens.fix_scope;

// ---- leftovers7-tailmerge ------------------------------------------------------------------
const tailmerge = {
  key: "leftovers7-tailmerge",
  title: "Leftovers of waves 12 and 14, merge side: a redo that changes nothing leaves no empty pull request, a person's conflict resolution is never thrown away, a merge that waits says why, and the copy's git messages are read in one language",
  problems: [
    `[major] TM-1: a redo from main (the conflict notice's or the rebuild card's Redo) or 'Drop the branch and retry from scratch' whose run changes nothing, on a task with an open pull request, force-pushes main's head to the task branch: the task is done with an empty pull request that the app offers for Merge (bench run 2 of the merge2 fix-up: PR #4 merged with no diff). Evidence: ${R("wave7g6c-fixup-leftovers7-merge2")} new_problems[0]; pr-executor.ts execute: \`!commit.committed && !existingPr\` (:878 at ce13bb1) is the only no-change check, and with \`dropped\` the branch starts at the base.`,
    `[minor] TM-2: cleanAfterCutShortRun runs before conflictAnswer: a person who resolves a rebase conflict in the task folder (the card's 'branch only on this computer' steps) and answers 'I resolved it' with the rebase still in progress has the half-done resolution aborted. Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[1], ${R("wave7g6c-fixup-leftovers7-merge")} not_done[1] (suggested fix: skip abortUnfinished while the task's last conflict answer is 'resolved' and not consumed).`,
    `[minor] TM-3: an unconsumed 'dropped' answer (the conflict card's Drop, a Redo from main) drops a paused run's work in progress at the next run: if the redo's run pauses (budget, a question) before review, the next run starts from main again (executeIn: wip = dropped ? null : …). Evidence: ${R("wave7g6c-fixup-leftovers7-merge")} not_done[5] and new_problems[1]; the fix-up's reason not to consume the mark at branch creation (the next run would merge the old conflicting branch into the work in progress) is the constraint to respect.`,
    `[minor] TM-4: Merge pressed while a rebuild is owed because the task's folder holds changes nobody committed: the record waits 'queued' and the row reads 'Merging…' with no reason until the folder is cleaned; meanwhile 'dependent branch not rebuilt: its worktree has uncommitted changes' is logged as a WARN at every poll. Evidence: ${R("wave7g6c-fix-leftovers7-merge2")} not_done[0]; ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[2] (bench walk 3 step 14) and [7].`,
    `[minor] TM-5: possible watcher stall (not reproduced): lookFor().baseChange, keepsOwnChange and mergeChecked's update path wait on inWorktree, and PrTaskExecutor.execute holds the folder for a whole run; a done task redone while its record is queued or waiting_checks would make retryWaitingMerges, which the watcher's poll awaits, block every poll until the redo ends (no PR events, copy refreshes or conflict notices meanwhile). Evidence: ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[3]; ${R("wave7g6c-fixup-leftovers7-merge2")} not_done[1].`,
    `[minor] TM-6: copyStoppedOf (loop/docs.ts) matches git's English messages, and GitOps (capabilities githost/git.ts) runs git with the process's locale: on a git that prints in another language the Files line falls back to 'Git could not bring it to what is merged…' without the file names. Check the other places that parse git's messages (rebase and merge conflict files) for the same dependence. Evidence: ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[4]; ${R("wave7g6c-fixup-leftovers7-merge2")} not_done[0].`,
    `[minor] TM-7: a record whose left-to-you sentence said something else (rebuilt_without's 'reviewed with #A's changes…' warning, 'builds on #X, which was not merged: merge #X first') loses it after a conflict is resolved: conflict_resolved sets the sentence to ''. The row then offers a plain Merge without the earlier warning. Evidence: ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[5]; ${R("wave7g6c-fixup-leftovers7-merge2")} not_done[2].`,
    `[minor] TM-8: the project page's Create a repository dialog files its pending card on Preview; closing the dialog with × or Escape leaves that card open in the Inbox (CreateRepoDialog.tsx finish() does not answer result.pendingId). Evidence: ${R("wave7g6c-fixup-leftovers7-merge")} new_problems[0] (walk-repo-B.json 'afterPreview', steps/05-b-preview-shown.png).`,
    `[minor] TM-9: CopyRecord.stopped (the copy's 'stopped following' state, a file in the copy's .git) is persisted state with no restart test (validation rule 4); the bench showed it survives restart-daemon.mjs. Evidence: ${R("wave7g6c-review-leftovers7-merge2")} non_blocking[1].`,
    `[cosmetic] TM-10: misplaced JSDoc blocks: in pr-executor.ts cleanAfterCutShortRun's doc sits between setLeftoversAside's doc and its function; in merge.ts mergedUpdateWords' doc follows fileLeftOpenRequest's doc. packages/commands/src/commands/repo.ts defines its own REPO_OFFER_KEY_PREFIX = 'repo:create:' instead of ANSWER_CARD_KEYS.repoCreatePrefix. Evidence: ${R("wave7g6c-review-leftovers7-merge")} non_blocking[0] and [6].`,
  ],
  decisions: [
    "Open owner questions stay as built (NEXT-SESSION.md): whether the rebuild card offers Merge on a rebuilt_changed record; how stale the Overview's rules read may be (R-overviewcalls' cache). Build nothing that answers them.",
  ],
  u_entries: ["U-028", "U-037"],
  root_causes: [
    "packages/capabilities/src/githost/pr-executor.ts: execute's no-change check ignores `dropped` with an existing pull request; executeIn cleans a cut-short run before reading the conflict answer; `dropped` stays in force until a run reaches review.",
    "packages/runtime/src/loop/merge.ts and session/dependent-branches.ts: a merge waiting for an owed rebuild has no state a screen reads; the owed warning is logged per poll; the retry pass waits on the folder lock; conflict_resolved drops the record's earlier sentence.",
    "packages/runtime/src/loop/docs.ts copyStoppedOf and capabilities githost/git.ts: git's messages are parsed in whatever language the process's locale gives.",
    "apps/ui/src/pages/project/CreateRepoDialog.tsx: closing the dialog does not answer its pending card.",
  ],
  fix_scope: `${AT} One commit per problem, the failing test first at the person's boundary (composed daemon with the fake GitHub, real-daemon in this area's own describe block 'leftovers7-tailmerge, wave 13', UI tests for TM-8), the fake daemon in the same commit where a route's shape changes. Order: TM-1 (an empty pull request offered for Merge is the worst), TM-2, TM-3, TM-5, TM-4, TM-6, TM-8, TM-9, TM-7, TM-10. TM-1: a redo whose run commits nothing ends as the existing no-change outcome does for a fresh task, and no empty pull request stays open and offered for Merge (close it, or keep it out of Merge, whichever ADR 0111 and the existing no-change path make consistent; amend ADR 0111 with the choice). TM-3: keep the work a paused redo did, never bringing back the old conflicting branch; if that cannot be done safely, show why with a test and put it in not_done. TM-4: the merge record (or the row's view) names the wait, the row and the Overview say in one sentence (design §5) that the merge waits for the task folder's changes to be put away, with the way out; the warning is logged once per owed state. New sentences: follow design §5 and list them in notes_for_other_areas (polish-words runs beside you and does not see them). TM-5: make it fail first (a composed test where a done task is redone while its record is queued: the watcher's poll must still deliver a PR event); fix with tryWorktree on the retry path or by skipping records whose task is not done; if it cannot be made to fail, not_done with the evidence. TM-6: an env option on GitOps for the calls whose messages are parsed (e.g. LC_ALL=C, LANGUAGE unset or C) without changing other calls' behaviour; a unit test of the env and a test with a non-English LANGUAGE where git's translations are installed (skip with the reason if they are not). TM-7: the sentence after a resolution says what is true now: recompute it from the record's state or keep what it said before the notice. Security: never weaken the hooks or the sandbox; nothing here may make a merge of an unrebuilt head possible (R-lock holds).`,
  files: [
    "packages/capabilities/src/githost/pr-executor.ts (execute's no-change path, executeIn's order and the `dropped`/wip logic, the doc blocks; droppedWords and the empty-change summary's sentences stay polish-words')",
    "packages/runtime/src/session/pr-answers.ts (the redo and drop answers' consumption, if TM-3 needs it)",
    "packages/runtime/src/loop/merge.ts (the retry pass and the queued merge's wait state; the mergedUpdateWords doc block; its sentences stay polish-words')",
    "packages/runtime/src/session/dependent-branches.ts (the owed warning, conflict_resolved's sentence; the sentences stay polish-words')",
    "packages/runtime/src/loop/docs.ts (copyStoppedOf's input), packages/capabilities/src/githost/git.ts (the env option)",
    "packages/runtime/src/daemon/pull-requests.ts and task-words.ts (only the state read for TM-4's wait, in a function of its own)",
    "packages/state (only if TM-3, TM-4 or TM-7 needs a column: the next free migration number, with the SQLite and Postgres suite in packages/state/test/suite.ts and data-model.md)",
    "apps/ui/src/pages/project/CreateRepoDialog.tsx; packages/commands/src/commands/repo.ts",
    "tests: packages/capabilities/test (pr-executor, git), packages/runtime/test (dependent-branches-merge, dependent-branches-restart, merge, docs/copy, repo-create), apps/ui/test (create-repo dialog test, real-daemon.test.ts and fake-daemon.ts in this area's own describe block)",
    "docs: docs/maintainers/capabilities.md and runtime.md (the sections of the files above), data-model.md if state changes, apps.md (the project page's dialog row), ADR 0111 and 0113 amendments, docs/user-guide.md where a person-visible behaviour changes, CHANGELOG.md [Unreleased] (appended lines)",
  ],
  acceptance: [
    "TM-1 (composed, fake GitHub): a task with an open pull request redone from main whose run commits nothing: no empty pull request is left open and offered for Merge; GET /projects/:id/pull-requests and the Tasks row say what happened in one sentence; the same through 'Drop the branch and retry from scratch'.",
    "TM-2: a rebase left in progress in the task folder, answered 'I resolved it': the person's resolution is kept and used (the next run continues it), never aborted.",
    "TM-3: a Redo whose run pauses before review (budget stop): Continue keeps the work done since the redo, and the pull request never carries the old conflicting commits.",
    "TM-4 (real-daemon): Merge pressed while a rebuild is owed for a folder with uncommitted changes: the Overview row and the Tasks row say why it waits and what to do (one sentence each, no 'Merging…'); daemon.log has the owed warning once, not per poll.",
    "TM-5: with a done task redone while its record waits, the watcher still delivers a pull request event within one poll (or not_done with why it cannot happen).",
    "TM-6: with LANGUAGE set to another language (where git's translations exist), the Files line still names the files that stopped the copy.",
    "TM-7: a rebuilt_without record that conflicts and is resolved: the row's sentence still carries the warning it had (or the true sentence now), with the Merge it offered.",
    "TM-8: Create a repository: Preview, then × (and Escape): GET /inbox has no open card for it; Preview then Yes still creates the repository.",
    "TM-9: a copy that stopped following, the daemon restarted: Files still says so (daemon-twice or compose-twice case).",
  ],
  depends_on: [
    "wave 14 merged at ce13bb1: leftovers7-merge (redo from main, cleanAfterCutShortRun, the rebuild card), leftovers7-merge2 (the worktree lock, owed rebuilds in merge_record.rebuild_owed_for, the conflict notice and its Redo, copy.stopped): reuse what they added; read their reports first.",
    "runs beside polish-words (sentences in the same files: change logic and the state the words read; polish-words changes the sentences), leftovers7-tailrun (disjoint files except compose.ts, runtime.md and the append-only test files) and polish-screens.",
  ],
  handoff_items: ["TM-1", "TM-2", "TM-3", "TM-4", "TM-5", "TM-6", "TM-7", "TM-8", "TM-9", "TM-10"],
  owner_questions: [],
  size: "medium: 10 items, most a few lines of logic with a composed test; TM-1, TM-3 and TM-4 are the larger ones.",
};

// ---- leftovers7-tailrun --------------------------------------------------------------------
const tailrun = {
  key: "leftovers7-tailrun",
  title: "Leftovers of waves 12 and 14, run side: a secret in a repository file never reaches the model on the subscription, looking at the Start dialog starts nothing, the chooser and the planner read what the run will, and a paused review costs no second run",
  problems: [
    `[major, security] TR-1: on the subscription, Claude Code's built-in Read, Grep and NotebookRead output reaches the model unredacted: since R-readhook the PostToolUse hook gives built-ins no replacement (a bare string was rejected by Claude Code anyway, so this was already the effective behaviour), so the value of a resolved secret written in a repository file is not redacted, while runtime.md (:380 area, 'PostToolUse hands the redacted content back') and the API-key path redact it. Evidence: ${R("wave7g6c-fix-leftovers7-web")} new_problems[0]; packages/runtime/src/agent/sdk.ts post hook (:933-964 at ce13bb1, builtInOutput only for WebSearch/WebFetch).`,
    `[minor] TR-2: GET /projects/:id/start-check records a wait (waits.now calls noteWait): only opening the Start dialog, or the stopped bar's 'Continue where it stopped', makes a session start by itself later at the reset or once a credential is saved, though the person only looked and never pressed Start. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[2].`,
    `[minor] TR-3: compose.ts credentialWaitNow builds the pick without the task's answered state and with modelTier fixed to 'sonnet': a task whose person questions were answered still gets the askPerson need, so the Start check can say 'Nothing can run yet' while the real run would go to the subscription. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[3].`,
    `[minor] TR-4: billing-pick takeReady computes \`refused\` once, from the snapshot read before the version-checked write; a refusal written between that read and the write is treated as stale on the retry and cleared (its comment claims otherwise). Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[4].`,
    `[minor] TR-5: intake.ts onlyWebsitesLines with an empty 'only' list gives the planner '…only these websites and their subdomains: . Plan no research…' (model-facing; a sibling of R-failopen). Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[5]; intake.ts:473.`,
    `[minor] TR-6: person-questions.ts isPersonTask still matches PERSONS_ANSWER on legacy titles without the RECORDED_ANSWER exception (a sibling of R-personsanswers); and RECORDED_ANSWER removes the need for a whole text, so 'Follow the owner's decision in docs/x and get the owner's confirmation before deploying' loses the confirmation need unless NEEDS_PERSON catches it. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[6]; person-questions.ts:112-130, :227.`,
    `[minor] TR-7: intake.ts: the scheduler hold's release() is not in a finally between store.session.start and the try that releases it; a throw in between (userMessage, SessionBudget) leaves the agent held and every start queued until a restart. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[7]; intake.ts around :1560-1580.`,
    `[minor, security guard] TR-8: sandboxRefusalOf's \`<launching>\` filter does not match call-log lines with ANSI colour codes (Playwright printed '\\u001b[2m  - <launching> …' on the bench): the guard that a profile path in the command line is never read as the browser's refusal does not hold under colour. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[10]; packages/capabilities/src/browser/profile.ts:190-199.`,
    `[minor] TR-9: SummaryTab's ResearchReads keeps its local line while \`changed.over === cardLine\`: if a later change elsewhere restores exactly the earlier line (Chat undoes the Overview's change), the stale local line wins (reproduced with the fake daemon). Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[1] (fix: drop the local line as soon as the card line changes at all).`,
    `[minor] TR-10: once a subscription has taken the work, the Inbox card 'Anthropic refused your API key … The work that needs it waits and starts by itself then.' stays, though nothing waits any more; and setup still answers restartNeeded: true for a subscription the running daemon now serves without a restart (since R-refusedstays' credentialSaved). Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[9]; packages/runtime/src/setup/routes.ts:152.`,
    `[minor] TR-11 (R-newtaskwords): New task's runs-on line is computed from the specialist only, never from the typed words: a task whose outcome needs the owner's decision runs on the API key while New task said otherwise. The acceptance 'tasks.test.tsx plus real-daemon: New task with words that need the owner's decision shows the API-key line before Create' is unmet. Evidence: ${R("wave7g6c-fix-leftovers7-web")} not_done[0]; ${R("wave7g6c-review-leftovers7-web")} non_blocking[0]. The chooser already reads the words (chooser.forTask({task})): the change is the route and NewTaskDialog.`,
    `[minor] TR-12: the Start dialog during planning says 'This session runs …' (start-check's busy does not count the scheduler's holds); after Start it says 'Queued: your agent is in another session. This one starts when that one ends.' while the person sees 'Drafting the plan', not a session. Evidence: ${R("wave7g6c-review-leftovers7-web")} non_blocking[8].`,
    `[minor] TR-13 (R-lateusage, task side): a killed run's late usage reaches the ledger, the session's spend and the Run row, but not the task's own spent figure (task.actual_cost_usd_micro): the runner adds the run's cost to the task from its in-memory row after execute returns, and a late addition from the background drain would race that write. Evidence: ${R("wave7g6c-fix-leftovers7-web")} not_done[1]; ADR 0112 amendment.`,
    `[minor] TR-14: the Inbox card for a review paused at a budget reuses the run-pause body 'It stopped before it could say where it stood; its work so far is kept.' (request-words.ts pausedWorkSentence), untrue when the specialist finished and only the review waits; the runner passes handoff: null (runner.ts:2075 at ca2c58d), so no state tells the card. Evidence: ${R("wave7g6a-fix-session")} new_problems[0]; ${R("wave7g6c-review-leftovers7-session")} non_blocking[0]; ${R("wave7g6c-fixup-leftovers7-session")} not_done[0] (a flag such as review: true through fileBudgetStopCard / BudgetStopCardInput and the change card; a sentence such as 'The work is done; its review waits for room in the budget.').`,
    `[minor] TR-15: no review-only pass: a task paused before its review (the review refused at a budget or by a credential) reruns its specialist at the next session before the critic reviews it, which costs one more specialist call; at the task's own budget, Continue may have to be pressed twice because the rerun spends part of the added budget first. Evidence: ${R("wave7g6a-fix-session")} not_done[0]; ${R("wave7g6c-review-leftovers7-session")} non_blocking[12]; ADR 0112 amendment of 2026-11-08 ('Not built').`,
    `[cosmetic] TR-16: existing biome warnings in pnpm lint: useOptionalChain at apps/ui/test/fake-daemon.ts (two places) and packages/capabilities/src/email/inbound.ts; noNonNullAssertion in packages/capabilities/test/email-auth.test.ts, email-commands.test.ts and email-policy.test.ts. Evidence: ${R("wave7g6a-fix-session")} new_problems[2].`,
  ],
  decisions: [
    "Open owner questions stay as built: under 'Wait' a refused or resting first choice still holds its work (O-refusedwait, U-078 'Wait' with a second credential, the plan share and monthly cap under Wait). Build nothing that answers them.",
    "TR-2 (session lead's decision): looking records nothing. The Start dialog's GET and the stopped bar's read only report the wait; Start (and Continue, which starts) record it, as R-startcred's 'Start keeps the wait it names' says.",
  ],
  u_entries: ["U-078", "U-042", "U-044"],
  root_causes: [
    "packages/runtime/src/agent/sdk.ts: the PostToolUse hook replaces only WebSearch, WebFetch and MCP output; afterToolCall's redaction of a built-in read is computed and dropped.",
    "packages/runtime/src/daemon/server.ts start-check and compose.ts credentialWaitNow: a read with a side effect, and a pick built from other inputs than the run's.",
    "packages/runtime/src/wiring/billing-pick.ts takeReady, session/intake.ts (onlyWebsitesLines, the hold's release), session/person-questions.ts, capabilities/src/browser/profile.ts: siblings of fixes made in wave 14 that missed one place.",
    "packages/runtime/src/session/runner.ts: the review-refusal branch keeps no run result for a later review and files the budget card with handoff: null; the task's spend is written from the in-memory row.",
  ],
  fix_scope: `${AT} One commit per problem, the failing test first at the person's boundary (composed daemon, real-daemon in this area's own describe block 'leftovers7-tailrun, wave 13', UI tests for TR-9, TR-11, TR-12), the fake daemon in the same commit where a route's shape changes. Order: TR-1 (security), TR-8, TR-2, TR-3, TR-4, TR-7, TR-6, TR-5, TR-10, TR-13, TR-14, TR-11, TR-12, TR-9, TR-16, TR-15 last. TR-1: when redaction changes a built-in read's text, the hook returns updatedToolOutput in that tool's own output shape (find Read's, Grep's and NotebookRead's shapes in the bundled Agent SDK / Claude Code package's types, e.g. the tool output types it ships) with only the secret replaced so line numbers do not move; a read with nothing to redact still gets no replacement (R-readhook keeps). If a shape cannot be confirmed from the bundled package, deny the read of a file whose text holds a resolved secret (a clear reason to the model, an audit row) rather than pass it; never pass the secret. Add a live check step (subscription, a repository file holding a test secret's value: the model's reply and the transcript never contain it; no hook_error line). TR-2: the decision above; the wake still starts work that Start or Continue recorded. TR-3: the same inputs as the run's own pick (answered, the task's tier). TR-10: withdraw the refused-key card ('Closed: it no longer needs you.') once no work waits on that key; restartNeeded false when the running daemon already serves the new credential. TR-13: an atomic increment in the store, not a write of the in-memory row; the state suite (SQLite and Postgres) if a repo method is added. TR-14: state plus one sentence in pausedWorkSentence (you own that function in this wave; follow design §5 and name the sentence in notes_for_other_areas). TR-15: when only the review was refused and the run's work is complete, the next session reviews the kept work without rerunning the specialist: persist what the review needs (the run's result and the head it reviewed), with a restart test; if it needs more than this wave can carry, do the smallest safe part and put the rest in not_done with a design note. TR-11: the route takes the typed title and outcome; NewTaskDialog shows the line for the words (debounced), fake daemon and real-daemon. TR-12: start-check's busy counts the scheduler's holds and the dialog says the plan is being drafted (one sentence, design §5); you may change StartSessionDialog's planning/queued line only. Security in every item: never weaken the hooks or the sandbox; page, search and file text never becomes instructions.`,
  files: [
    "packages/runtime/src/agent/sdk.ts (the PostToolUse hook's built-in path)",
    "packages/runtime/src/daemon/server.ts (GET /projects/:id/start-check; the New task preview of the runs-on line), packages/runtime/src/daemon/compose.ts (credentialWaitNow, the refused-key card's withdrawal wiring; nothing else)",
    "packages/runtime/src/wiring/billing-pick.ts (takeReady), packages/runtime/src/setup/routes.ts (restartNeeded)",
    "packages/runtime/src/session/intake.ts (onlyWebsitesLines, the hold's release), session/person-questions.ts",
    "packages/runtime/src/session/runner.ts (the review-refusal branch, the task's spend, the review-only pass), session/budget-card.ts (the flag's input), daemon/request-words.ts (pausedWorkSentence only), packages/critic if the review-only pass needs it",
    "packages/state (only if TR-13 or TR-15 needs a repo method or a column: the next free migration number, with packages/state/test/suite.ts and data-model.md)",
    "packages/capabilities/src/browser/profile.ts (sandboxRefusalOf) and try-page.ts if it shares the filter",
    "apps/ui/src/pages/project/SummaryTab.tsx (ResearchReads only), apps/ui/src/pages/project/NewTaskDialog.tsx (or the New task dialog's file), apps/ui/src/pages/project/StartSessionDialog.tsx (the planning/queued line only), the UI client for a new route",
    "lint only: apps/ui/test/fake-daemon.ts (the two optional chains), packages/capabilities/src/email/inbound.ts, packages/capabilities/test/email-*.test.ts",
    "tests: packages/runtime/test (sites-subscription, credential waits, billing-pick, intake, person-questions, session-recovery/runner budget cases), packages/capabilities/test/browser-profile.test.ts, apps/ui/test (project-overview, tasks, start dialog tests; real-daemon.test.ts and fake-daemon.ts in this area's own describe block)",
    "docs: docs/maintainers/runtime.md, capabilities.md, apps.md (the rows it changes), data-model.md if state changes, ADR 0100 / 0107 / 0112 amendments, docs/user-guide.md where person-visible behaviour changes, CHANGELOG.md [Unreleased] (appended lines); the live check steps in each item's check_in_the_app",
  ],
  acceptance: [
    "TR-1: on the subscription path (the SDK driver's hook, with Read's, Grep's and NotebookRead's real output shapes), a file holding a resolved secret's value reaches the model with the value redacted and line numbers unchanged, or the read is denied with a reason; a file without one gets no replacement; no hook_error.",
    "TR-2 (real-daemon): opening the Start dialog (GET start-check) while the only credential rests, then closing it: no session starts at the reset; pressing Start does wait and start.",
    "TR-3: a task whose person questions were answered: the Start check's verdict equals the run's own pick.",
    "TR-4: a refusal written between takeReady's read and its write survives the retry.",
    "TR-5..TR-8: unit tests at each function: the planner's line for an empty 'only' list names no website; isPersonTask and the questions agree on a recorded answer, and a text with a recorded answer and a separate confirmation still needs the person; a throw after the hold releases it; a coloured '<launching>' line is never read as a sandbox refusal.",
    "TR-9: Overview change, then Chat restores the earlier rule: the line shows the restored rule.",
    "TR-10: a refused key, then a subscription takes the work: the refused-key card is closed; saving the subscription answers restartNeeded false.",
    "TR-11: New task with words that need the owner's decision shows the API-key line before Create (tasks.test.tsx and real-daemon).",
    "TR-12: Start while the plan is drafted: the dialog says the plan is being drafted, not 'This session runs'.",
    "TR-13: a killed run's late usage: GET /tasks/:id spent equals the ledger's sum for the task.",
    "TR-14: a review paused at a budget after the specialist finished: the card says the work is done and its review waits for room in the budget.",
    "TR-15: a review refused at a budget, then Continue: the next session reviews without a second specialist call (model-call log), across a restart; or not_done with the design note.",
    "TR-16: pnpm lint shows none of those warnings.",
  ],
  depends_on: [
    "wave 14 merged at ce13bb1: leftovers7-web (the sandbox fix, R-failopen, R-readhook, credential waits, the chooser inputs) and leftovers7-session (the refused review, waits per task, recovery): reuse what they added; read their reports first.",
    "runs beside polish-words, polish-screens and leftovers7-tailmerge (wave 13): disjoint files except compose.ts, SummaryTab.tsx, StartSessionDialog.tsx, request-words.ts, runtime.md and the append-only test files, as shared_files says.",
  ],
  handoff_items: ["TR-1", "TR-2", "TR-3", "TR-4", "TR-5", "TR-6", "TR-7", "TR-8", "TR-9", "TR-10", "TR-11", "TR-12", "TR-13", "TR-14", "TR-15", "TR-16"],
  owner_questions: [],
  size: "medium-large: 16 items; most are a few lines with a unit or composed test; TR-1, TR-11 and TR-15 are the larger ones (TR-15 may end partly in not_done).",
};

// ---- the old 'polish' area is split ------------------------------------------------------
const old = p.areas.find((a) => a.key === "polish");
if (old && !old.title.startsWith("[SPLIT")) old.title = `[SPLIT into polish-words and polish-screens for wave 13; not run] ${old.title}`;

p.areas.push(tailmerge, tailrun, words, screens);
p.parallel_groups.push(["leftovers7-tailmerge", "leftovers7-tailrun", "polish-words", "polish-screens"]);

// ---- shared files ------------------------------------------------------------------------
const W13 = "Wave 13 (base ce13bb1): the wave 12/14 areas' logic is merged; in wave 13 the logic named here belongs to leftovers7-tailmerge or leftovers7-tailrun, and polish-words / polish-screens change only the words the rules below give them. Where an older rule says 'wave 12's leftovers7-… owns' a logic part, read: nobody changes it in wave 13 unless a tail area's item names it.";
const added = [
  W13,
  ...b.shared_files,
  "packages/capabilities/src/githost/pr-executor.ts (wave 13): leftovers7-tailmerge owns the logic (execute's no-change path, executeIn's order, the dropped/wip logic, the doc blocks); polish-words may change only droppedWords and the empty-change summary's sentence text.",
  "packages/runtime/src/loop/merge.ts (wave 13): leftovers7-tailmerge owns the retry pass and the queued merge's wait state and moves the mergedUpdateWords doc block; polish-words owns the sentences (mergedUpdateWords' text W14-2, :736 P7-6, :1034 P7-11).",
  "packages/runtime/src/session/dependent-branches.ts (wave 13): leftovers7-tailmerge owns the owed warning and conflict_resolved's sentence choice; polish-words owns the sentences' text.",
  "packages/runtime/src/loop/docs.ts (wave 13): leftovers7-tailmerge owns copyStoppedOf's input (the locale); polish-words owns the copy-stopped sentences' text (W14-5).",
  "packages/runtime/src/daemon/task-words.ts and pull-requests.ts (wave 13): leftovers7-tailmerge may add the state read for TM-4's wait in a function of its own (and its one sentence); polish-words owns every other word there, including the conflicted row's 'Accepted · waiting for you to merge' (W14-5).",
  "packages/runtime/src/daemon/request-words.ts (wave 13): leftovers7-tailrun owns pausedWorkSentence (TR-14); polish-words owns every other word there (the rebuild card W14-3, the conflict notice W14-1).",
  "packages/runtime/src/daemon/compose.ts (wave 13): leftovers7-tailrun may change credentialWaitNow and add the refused-key card's withdrawal wiring; leftovers7-tailmerge only if TM-5 needs the watcher's wiring (one small hunk); polish-words the comments at :858 and :2475; polish-screens the first human's insert.",
  "packages/runtime/src/daemon/server.ts (wave 13): leftovers7-tailrun owns GET /projects/:id/start-check (its side effect TR-2, busy counting holds TR-12) and the New task runs-on preview (TR-11); no other wave 13 area changes server.ts unless an item names a route.",
  "apps/ui/src/pages/project/SummaryTab.tsx (wave 13): leftovers7-tailrun owns ResearchReads (TR-9); polish-words owns PR_GROUPS' take-out label, RepositoryFiles' two Merge sentences and the Next list's keys (W14-7).",
  "apps/ui/src/pages/project/StartSessionDialog.tsx (wave 13): leftovers7-tailrun owns the line while the plan is drafted or queued (TR-12); polish-screens owns planSentence, waitsOnText, BlockerLines' budget lines, budgetProblem and the rest of the state after Start.",
  "packages/runtime/src/session/runner.ts and session/budget-card.ts (wave 13): leftovers7-tailrun only (TR-13, TR-14, TR-15).",
  "apps/ui/test/real-daemon.test.ts, fake-daemon.ts, fake-tasks.ts (wave 13): append-only in each area's own describe block ('leftovers7-tailmerge, wave 13', 'leftovers7-tailrun, wave 13', 'polish-words, wave 13', 'polish-screens, wave 13'); leftovers7-tailrun may also make fake-daemon.ts' two optional-chain lint fixes (TR-16).",
  "docs (wave 13): each area changes only the runtime.md / capabilities.md / apps.md sections and user-guide paragraphs of what it changes; CHANGELOG.md [Unreleased] lines are appended; ADR amendments are dated 2026-11-09 and appended at the end of the ADR.",
];
p.shared_files.push(...added);
p.headline = `${p.headline} | Wave 13 (base ce13bb1): polish-words, polish-screens, and the logic leftovers of waves 12/14 in leftovers7-tailmerge and leftovers7-tailrun.`;

fs.writeFileSync(P, JSON.stringify(p, null, 2));
console.log("areas now:", p.areas.map((a) => a.key).join(", "));
console.log("problems:", { tailmerge: tailmerge.problems.length, tailrun: tailrun.problems.length, words: words.problems.length, screens: screens.problems.length });
console.log("shared_files:", p.shared_files.length);
