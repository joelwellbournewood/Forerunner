// Places run C sub-run C6's leftovers (d1109-cred-screens and d1109-selftasks-chat merged at 4cf11fd; both
// had a fix-up). C6 is the last sub-run, so no later run C area owns any of them: they go to
// /tmp/frbench/leftovers-C6.json for the triage after live check 4, live check 4's steps get " C6 leftovers adds"
// segments (no new step, no new cost), and "(C6-merge)" session lead decisions are added. Idempotent: earlier
// " C6 leftovers adds" segments and "(C6-merge)" decisions are replaced; no other tag is touched.
const fs = require("fs");
const P = "/tmp/frbench/runC-plan.json";
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "4cf11fdb0a1e10af94d948c6fcf79a89a083cfbb";
const SRC = (k) =>
  `/tmp/frbench/runC-C6-fixup-${k}.json first (notes_for_other_areas, not_done, new_problems), then runC-C6-fix-${k}.json and runC-C6-review-${k}.json (non_blocking)`;
const CS = "d1109-cred-screens";
const SC = "d1109-selftasks-chat";

const triage = [
  // d1109-cred-screens
  ["C6L-1", "major, words", CS, "CS-5's 'needs' row form is not built, though CS-5 is on the never-cut list: a task that only the API key can run (it reads web pages) and that waits for the key shows no 'Waits for your API key: only it can read web pages here.' The wait entry does not carry the task's need, so the row cannot say it until the engine records it (credential-wait.ts' wait record). The chooser's runs-on line already says 'Runs on your API key: only it can read web pages here.' where it applies. Build: the wait records the need; the row, the status line and the bar say it."],
  ["C6L-2", "minor", CS, "'Start on 1 Dec' for a share or key-month stop starts a session that stops to wait at once: keepStart keeps a start only for reason 'limit' (compose.ts about :4245), so the dialog then says 'Started: the session works until nothing more can run, ...' and the Sessions list gets a session with nothing done (/tmp/frbench/review-d1109-cred-screens bench steps 55-58). Keep the start for the month's reset as for a limit (d1109-starts-engine's keepStartAtReset), or word the button for what it does."],
  ["C6L-3", "words", CS, "When the stop line replaces the plan sentence, the Start dialog no longer names the tasks that will run; and three figures exist for the same waiting work: the ask card 'about CHF 0.09', the dialog's Use API key 'about CHF 0.05' (runnable tasks only), the plan card about CHF 0.13 per task (review steps 14, 17, 40, 45). One figure per thing, and the dialog keeps the plan sentence."],
  ["C6L-4", "words", CS, "The Use API key line passes 100 characters when the subscription was refused ('Runs now on your API key until a new sign-in is saved, about CHF 0.90; nothing passes this session's budget.'); under 'ask' before any card is filed, Settings' now line says '...; the work waits for it.' though the next work will file a card that asks (needs an asking mark in CredentialFacts)."],
  ["C6L-5", "minor", CS, "The share wait on the status line and the session page offers Cancel only; 'Change the allowance' is only on the run bar, while CS-7 names it with the share form (project-status.ts is d1109-run-visible's)."],
  ["C6L-6", "words", CS, "Chat's one-off press (Use API key for one held question) sends the question again as a new person line, so it shows twice in the conversation (review step 52; one model call on the key, so it is a display duplicate). Conversation.tsx."],
  ["C6L-7", "minor, tests", CS, "The spec's Playwright cases for the Settings section and the Start dialog at phone and desktop widths are not added (the reviewer checked 390 px by hand: no sideways scroll; Playwright 38/38 passes)."],
  ["C6L-8", "words", CS, "The project header under 'ask' with the API key able to run reads 'Ready: 2 tasks; nothing runs until 02:51 (your subscription's limit)' while the Start dialog offers Use API key now ('nothing runs by itself until 02:51'). The plan card's per-task wait line under 'then wait' still says 'Press Start and the work starts then.' on a card whose button is 'Approve and start' (credential-wait.ts waitThenStartSentence, W15-66). A session that ended to wait under 'ask' reads '... CHF 0.00.' (result.ts). After 'Start at 04:28' the reopened dialog says '...; then your session goes on.' with 'Cancel the wait' for a kept person start, which is not a continuation (d1109-starts-engine's kept-start sentence; /tmp/frbench/fixup-d1109-cred-screens/steps/06-fx-b1-03-start-dialog-again.txt)."],
  ["C6L-9", "minor", CS, "A Settings read-back left unanswered (the person navigates away) stays in the Inbox as an approval card 'Set which Claude does the work to ...?' (the generic settings pattern). A POST /sessions refused for nothing to run answers HTTP 409 'conflict' though the daemon raises 'validation' (the UI shows the right sentence)."],
  // d1109-selftasks-chat
  ["C6L-10", "major, decision", SC, "Attribution: a change the person names in chat and confirms, made through a chat-model tool call, now reads '... changed by the agent' and Changes names the agent (ChangeLogView.byAgent, task.ts agentReason/movedByAgent); the same change through the parser path reads 'by you'. The owner's decision: 'Changes the person names in their own words stay the person's instruction.' Session lead decision (C6-merge): keep byAgent and the agent's words only for the agent's own changes (planFix, the session source, fix_tasks' check); a change the person named and confirmed in chat is theirs ('by you', the person named on Changes). Build it test-first at the parser and the model path."],
  ["C6L-11", "major, decision", SC, "The chat read-back card expires after 10 minutes (PENDING_TTL_MS). At Advisor or Assisted a 'fix the tasks' read-back left longer lapses silently after the check's cost was booked and its kept notes were taken, so the owner's 'asks first on one card' is lost. Session lead decision (C6-merge): a fix-the-tasks read-back lives as long as its Inbox card is open; a Yes after the task list changed since the check (its fingerprint) says so and offers the check again instead of applying a stale set. A restart keeps it."],
  ["C6L-12", "words", SC, "SC-1's 'with the Connect action': 'Fixing the tasks needs Claude.' says neither what to do nor offers Connect (design section 5 rule 8; a chat reply has no Connect offer kind: ChatOfferView.action is go_ahead or think)."],
  ["C6L-13", "words", SC, "'Make this a task' is offered under a refused fix line (e.g. 'Fixing the tasks would pass this project's budget; nothing changed.'): Conversation.tsx isOwnRequest ignores reply.notice, which ChatTaskFixResult sets. Skipping notice replies changes every notice reply in chat: check each."],
  ["C6L-14", "minor", SC, "CommandLoop.recompose builds the merged card with a plain agent context: when fix_tasks reads back and another task tool runs in the same turn, the planFix and askFirst context is lost (a merge rule for planFix contexts in recompose and the stored card)."],
  ["C6L-15", "words", SC, "Session page: a split line read 'Cannot be undone now: \"...: layout\" has run since ...' before that part had started (CommandLoop.undoBlocked's words, d1109-selftasks-run's); after a reload an undone line shows only 'Undone.'. The suggestion card's open list shows 'Asks you first: ...' as a bullet among the changes (needs a RequestView field)."],
  ["C6L-16", "minor, security", SC, "No pnpm test:injection case for the fix_tasks channel: a record asking the chat model to call fix_tasks is covered only by the composed recordsRead case (read back, not applied). Model-facing texts of the chat variant (the task-check paragraph, FIX_TASKS_DESCRIPTION, CHAT_TASK_RULES, the project parameter's description) are compared against their own constants, not pinned as literals."],
  ["C6L-17", "decision", SC, "SC-12 'on its row': the agent's reason line shows in the drawer only, not on the Tasks row (the row's second line belongs to other areas). Session lead decision (C6-merge): the drawer is enough; the user guide promises the drawer only. Accepted."],
  ["C6L-18", "minor", SC, "Pre-existing: after a Yes, a chat-model command (actor agent, source chat, no planFix) still posts an Inbox Update that echoes the change (executor.post, not theirOwn)."],
  ["C6L-19", "carried", SC, "The chat area's fixer left these not_done and its fix-up did not take them up: SC-13 (the critic counts a split or dropped task as replaced), the SC-10 sentences unit file, C4-left-2 to C4-left-9, C3-left-10, C3-left-11, C5-left-6 (the remaining created_at tie in d1109-selftasks-run's restart case) and L3-left-16. Their texts are in /tmp/frbench/runC-plan.json areas d1109-selftasks-chat problems."],
  ["C6L-20", "decision", "both", "Process: C6 ran four times; three container restarts (about 23:56, 00:58 and 01:54 UTC on 2026-11-17) stopped the first three runs. Every stage's work was kept (commits, saved reports, WIP patches) and reused, and run 4 went through with the areas one at a time and one heavy suite at a time under flock /tmp/frbench/heavy.lock. Keep both rules for the next runs on this machine."],
];

const forSessionLead = {
  changelog_update_log_lines: [
    "Settings has one place for which Claude does the work: five choices, the default shown as used until you pick; the Start dialog, the plan card, the rows, the status line, the run bar, the session page, the drawer, Costs and chat say what happens when the first choice runs out and what a move to the API key cost, and offer Use API key or Start at 15:40 with their consequences.",
    "Start at 15:40 under 'ask before API key' is your answer for that stop (no card follows); while your yes stands the plan card names the key for each task; Use API key appears only for a start that runs something; Stop using it says what it does.",
    "In chat, 'fix the tasks' checks the project's task list: from Standard the changes are made at once with an Undo each; at Advisor and Assisted they are read back once for your yes. The session page has an Undo on each change line, and Changes and the drawer say when the agent made a change.",
  ],
  owner_question_defaults: "ONE_OFF_UNDER_WAIT = true (packages/runtime/src/daemon/credential-policy-view.ts): a one-off Use API key is offered under 'then wait' too. 'Fix the tasks' is chat only (no Tasks-tab button).",
  adrs: "ADR 0120 amended 2026-11-17 (the screens); ADR 0119 amended (the chat part).",
  next_migration: "0011 (C6 added none: check packages/state/src/migrations)",
};

fs.writeFileSync(
  "/tmp/frbench/leftovers-C6.json",
  JSON.stringify(
    {
      why: "Run C sub-run C6's leftovers (the last sub-run: no later run C area owns them). Triage them with live check 4's findings and leftovers-L3.json, -C2, -C3, -C4, -C4b-design, -C4b and -C5 (the next leftovers run). Sources: " + SRC(CS) + "; " + SRC(SC) + "; runC-C6-merge.json problems_left.",
      base: HEAD,
      items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
      for_session_lead: forSessionLead,
    },
    null,
    1,
  ),
);

// Live check 4: fold into existing steps.
const own = / C6 leftovers adds(?:(?! C\d\w?(?: leftovers)? adds)[^])*/;
const adds = {
  "LC-C24":
    "C6 leftovers adds (the merge's notes): under 'ask', press Start at HH:MM in the Start dialog: no ask card, no urgent notification, and the reopened dialog asks nothing; with a yes standing, the plan card's task lines name no wait; open Start on a project with nothing ready while the subscription is at its limit: no Use API key; Settings with a yes standing shows the Stop using it line, and pressing it ends the yes. Record the three figures for the same waiting work (ask card, dialog, plan card; C6L-3).",
  "LC-C25":
    "C6 leftovers adds: chat's one-off press (Use API key for one held question) on the real model: one call on the key, and record whether the question shows twice (C6L-6).",
  "LC-C28":
    "C6 leftovers adds: the read-back names what each edit changes ('priority to High', never 'reword'); the drawer of an added task reads 'Added by the agent: ...'; the model-call log's task-check request holds the person's line verbatim and its model follows the planning setting (C5-left-7). Leave one read-back open for more than 10 minutes, then answer Yes: record what happens (C6L-11). Also say a change in chat in your own words that the chat model makes (not 'fix the tasks'), and record whether Changes names you or the agent (C6L-10).",
};
const l = p.live_check_4;
for (const s of l.steps) {
  s.step = s.step.replace(own, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C6-merge)"));
p.session_lead_decisions.push(
  "(C6-merge) C6 is the last sub-run of run C: its leftovers go to the triage after live check 4 (leftovers-C6.json), none to a run C area.",
  "(C6-merge) Attribution (C6L-10): the owner's 'Changes the person names in their own words stay the person's instruction' decides it: a change the person named and confirmed in chat is theirs ('by you'); byAgent and the agent's words stay for the agent's own changes (planFix, the session source, fix_tasks' check). Built in the fix run after live check 4.",
  "(C6-merge) A 'fix the tasks' read-back lives as long as its Inbox card is open, not 10 minutes; a Yes after the task list changed since the check says so and offers the check again (C6L-11). Built in the fix run.",
  "(C6-merge) SC-12's reason line in the drawer only, not on the Tasks row: accepted (C6L-17).",
  "(C6-merge) CS-5's 'needs' row form (never-cut, not built: the engine's wait does not record the need) goes to the fix run as major (C6L-1).",
  "(C6-merge) Live check 4 may run in this session: FORERUNNER_TEST_GITHUB_TOKEN answers on forerunner-sandbox with push permission (checked 2026-11-17 04:40 UTC with a read of the repository only), so the rule's 'fresh session after the token update' is met by the restarted container.",
);

const c6 = p.sub_runs.find((s) => s.name === "C6");
c6.merged = Object.assign({}, c6.merged || {}, {
  head: HEAD,
  runs: "four: wf_2ce6c7a0-0e2, wf_77c66af8-06c and wf_b8a050fb-2fb stopped by container restarts; wf_66aeb76f-01d finished",
  review: "fix-needed on both areas (cred-screens 3 blocking, selftasks-chat 4 blocking); both fix-ups fixed every blocking item; the merge needed one integration fix (4cf11fd, a renamed function's new caller)",
  leftovers_for_triage: "/tmp/frbench/leftovers-C6.json",
});
if (!c6.merged.ci) c6.merged.ci = "pending: CI 315 (44018245420) and Desktop app 80 (44018245416), started 2026-11-17 04:35 UTC";

fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("triage", triage.length, "; live steps amended", Object.keys(adds).join(","), "; decisions", p.session_lead_decisions.length);
