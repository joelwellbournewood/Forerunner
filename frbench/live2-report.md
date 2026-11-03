# Live-model walk 2 (helper session_01RnhAjhoJ8VzsamZ3EBorVh), report part 1, received 23:15 UTC

CAUTION: this helper was cloned at 20:21 (before wave 2: Inbox/chat fixes) and was already walking when told
to update to c316eba; findings on chat (4, 10), answer→continue (6) and Settings cards (12) may describe the
pre-wave-2 code. Re-check each on the current branch before fixing.

Step 0: passed with FORERUNNER_ANTHROPIC_API_KEY (ANTHROPIC_API_KEY not set). main.ts daemonProvider accepts
ANTHROPIC_API_KEY or FORERUNNER_ANTHROPIC_KEY, not FORERUNNER_ANTHROPIC_API_KEY (bench maps it). Key also
entered through the setup assistant: "Key works; 14 models visible" (~8 s). Key in no file.
Spend USD 0.56 (36 calls: intake 3 Sonnet 0.19; specialist 22 0.34; critic 2 0.02; chat 9 Haiku 0.003).
Monthly cap set to CHF 10; monthly critic calibration turned OFF before work (it defaulted to on, day 1 = today,
up to USD 10 — check against wave 1's SE2 "not on first-sight day").

## Worked with the real model
- Plan quality good (bakery site): 2 milestones, 4 tasks; a person task for the real menu/address/hours instead
  of inventing; coder with TODO placeholders, then content fill, then tester. ~USD 0.064, ~42 s per intake call.
- Coder clean HTML/CSS, honest report; content fill matched answers exactly; tester ran headless Chrome at
  360/1280 px, contrast, HTML parse; critic (tier 1) accept 88 with sensible findings.
- One Start carried 2 newly-ready tasks: "Did 2 tasks: … Nothing left. CHF 0.16."
- Chat "Please stop after the task you are working on now" → session.pause → "Stopped after the task, as asked."
- Tasks tab / drawer / Edit / "Change what it waits for": clear, worked first time.

## Findings
1. BLOCKER (same as live1 #2) intake parse cut at first ``` fence; helper fixed locally (parse whole reply first).
2. BLOCKER (same as live1 #1) plan.reason 505 chars > 500; helper fixed locally with clippedText() for prose
   (plan.reason, task title, milestone name, firstSession summary/rationale); suggests stating limits in prompt.
3. MAJOR: answers to a person task never reach the dependent task's brief. Answered "Owner supplies the bakery's
   real content" (7 answers); the coder of "Replace placeholders…" asked ALL the same questions again: "docs/data.md
   still holds only TODO placeholders and the decision record says the owner has not supplied …". Answers were only
   appended at the end of docs/decisions/0001-*.md; data.md stayed TODO. Root cause: task-context.ts:156-168
   "Done before this task" for a person-done dependency uses dep.outcome (the planning-time promise "answers are
   recorded in docs/data.md…", false). Fix: put the question→answer pairs (or a pointer to the answers section)
   into the dependent task's brief. Chat later: "I don't have a record of why the question came up twice".
4. MAJOR (pre-wave-2 code?): chat had no history/task list/ids; "The 404 page task should wait…" → "I don't see a
   task titled "404 page"" (added by chat one turn before); "Yes, go ahead…" → offered to add a duplicate;
   "Where are the files so I can open them?" → "the files are in the project folder you already set up" (false).
5. MAJOR: tier-0 plan = no critic. The intake put every coding task at "Checks only (tier 0)"; no checks ran (no
   test command), so "Build the three pages…" became Done on a self-report "nothing here has been tested"; session
   review "accepted (grade 100, 0 finding(s))". The coder's prompt says "Acceptance criteria (the critic checks
   each)" — false at tier 0. Fix: intake guidance / default tier 1 for coder tasks with criteria, or run criteria
   as checks at tier 0; never tell the specialist a critic checks when none will.
6. MAJOR (wave 2 area; fixed in 09371b2?): answering the plan's person task started nothing; a specialist's
   ask_person answer did. Design core-experience.md:225 "Answering resumes work".
7. MAJOR: no screen says where the project folder is (Docs tab "from the project folder"; Data tab none); chat
   can't say. A newcomer cannot open the finished site. Fix: path + "Open folder" on the Summary.
8. MINOR: chat "Please add a task: make a 404.html 'page not found' page…" went to the intent parser (0 ms), title =
   raw sentence cut at 80 chars "make a 404.html 'page not found' page in the same style as the others, with a l…",
   generic criterion "The outcome described in the goal is achieved and verified."; critic marked it met though
   nothing was verified. Fix: let the model write title/outcome/criteria, or clean the parsed title.
9. MINOR: critic gets only the diff ("the other pages were not provided, so I could not confirm the match").
   Fix: read access around the diff or include referenced files.
10. MINOR: chat leaks ids "(request 01a19958, "Cancel the task" is one of the options)"; context line
    `open_requests: 01a19958: "…" [Cancel the task] [already mentioned; blocking]`; suggested cancelling the
    blocking task (would strand the tasks behind it).
11. MINOR: Reviews tab: 4 of 5 entries mechanical "Session review" rows with jargon ("honesty: summary 114 chars,
    claims none parseable", "USD 0.1006 per done task"); a session that stopped to ask shows "85 / 100 sent back"
    with an open finding "Session spent USD 0.0237 and no task reached done…". Noise.
12. MINOR: two "approval: the monthly cap" cards stayed after confirming with Yes in Settings (one from a closed
    Preview); after a restart both became "The change you asked for was not made: the monthly cap (CHF 150.40 to
    CHF 10). Forerunner restarted before you answered…" though the cap WAS lowered ("Lowered the monthly cap…" too).
    Settings table showed CHF 150.40 until a reload.
13. MINOR: setup's last step "Until Claude is connected your agent cannot start work" right under "✓ Claude is
    connected."; setup "CHF 150 a month" vs Settings CHF 150.40; reopening mid-setup restarts at Welcome; "Start
    using Forerunner" restarts the daemon (exit 86) — bench has no supervisor (use restart-daemon.mjs; README line).
14. MINOR: intake asked "Where should the site files live… and do you want them under version control (git)?" —
    the app decides the folder and makes a git repo; the intake prompt should say so.
15. MINOR: workspace git commits are only "Workspace before <task>" snapshots; the last task's files (404.html) and
    docs/status.md stay uncommitted after the project is done.
16. POLISH: Summary "Spend vs budget CHF 0.44 of no cap" with a monthly cap set; header "planning" + "blocked" with
    "0 open questions" while the Inbox holds a blocking question; first Start dialog "…or try the failed task again"
    when nothing failed; after Start the dialog shows both "Started: …" and "Starts after the current session; …";
    session page title raw id; finished session still shows "Stop now"; messages show raw JSON "Set the monthly
    critic calibration from unset to {"enabled":false,…}"; "Make this a task" under the person's own chat lines;
    plan card mixes keys and titles ("after owner-content, site-skeleton").
17. POLISH/latency: intake ~42 s with only "Drafting the plan from your brief…"; chat first token 0.4-1.4 s, replies
    ~6-8 s; specialist calls ~5 s; tasks 6-50 s. No rate limits, malformed tool calls or provider errors.

Part 2 (the helper's local intake diff) to follow: /tmp/frbench/live2-intake.diff when received.

## Part 2 (23:15): the helper's local fix for findings 1 and 2 (not committed anywhere)
- parseIntakeReply: JSON.parse the whole trimmed reply first; only if that throws, take the first ```json fence.
- project-plan.ts: `clippedText(max, min = 1)` = z.string().min(min).transform(s => s.length > max ? s.slice(0, max - 1) + "…" : s),
  used for PlanTask.title (200, 3), PlanMilestone.name (200), ProjectPlanBody.reason (500, default "planned from the brief"),
  FirstSessionItem.rationale (500, 0, optional), FirstSessionPlan.summary (1000).
- Tests added in intake.test.ts: a doc with a ``` block inside a JSON string parses; a 505-char reason is cut to 500 ending "…".
- With it, the live intake filed the plan (USD 0.064) and the whole journey ran. Outcome/criteria/docs have no tight max.
- Helper's note: if refusing is preferred over clipping, at least state the limits in the intake prompt.
Compare with fix/intake-live (workflow w72625w4h) when reviewing/merging: the workflow's fix should cover the same
fields (and more: retry with errors, truthful failure words).

## Part 3 (23:25): second walk on CURRENT code (c316eba), USD 0.233 (session total USD 0.79)
Project "Garden club" via POST /projects {intake:false} (the intake fix is not on c316eba); tasks added in the Tasks tab.
(a) Setup as a person: wrong key → "Anthropic rejected the key (401). The key is invalid or revoked." (good); right key
    ~8 s → "✓ Key works; 14 models visible."; Done step then restart → billing api_key. 
    P-a1 MINOR: Settings → Accounts and keys never says a key is saved or working (only "1. API key … Can be used now"
    under "Claude: which to use first"). P-a2 POLISH: "Until Claude is connected…" under "✓ Claude is connected."; CHF 150 vs 150.40.
(b) B1 MAJOR (real model): "Members chart" (data-analyst; data/members.csv missing; criterion "No number is invented").
    Good ask_person card; "Go ahead without" → session started; the specialist rightly made no chart and ended with
    "Questions for the person: Please add data/members.csv…" — but the task became DONE: the critic accepted (82) with
    "Every bar uses the exact number from data/members.csv" marked met because there are no bars ("a blocked report is
    the right outcome"). Tasks "Members chart · Done · accepted"; Inbox "Nothing needs you"; the "Questions for the
    person:" lines made no card. Expected: not done / needs you, with a card asking for the file. Fix: critic prompt (a
    missing deliverable is never accepted; a criterion about absent output is not met) + runner: a final report with
    "Questions for the person:" opens a card.
    B2 MAJOR: a task over its budget ("Contact page", CHF 0.01, stopped "after spending $0.00"): session summary
    '"Contact page" needs your decision (Inbox).' but the Inbox says "Nothing needs you"; Tasks tab "Paused" (status
    needs_human); drawer "The run stopped at this task's budget of $0.01, after spending $0.00. Raise the task's budget
    on…. Press Resume…"; no Try again, no card; USD on a CHF screen. Works via Edit budget → Resume (confirm) → Start.
    Expected: one Inbox card with one sentence and [Raise budget and try again]; the summary never points at an empty Inbox.
    B3 MINOR: Start dialog '"About page" needs about CHF 1.20, more than this session's work budget of CHF 2.40…'
    (1.20 < 2.40: it means the running total); estimates ignore the task budget (CHF 0.80 set, estimated about CHF 1.00).
(c) Steering from chat during a session (wave-2 chat knows the tasks: big improvement). "Skip the About page task" →
    confirm card → Yes → 'Cancelled "About page".' [Undo]. "Add a task to write a README…" worked. "Start a session."
    worked. "Stop after this task." worked ("Stopped after the task, as asked").
    C1 MAJOR: "About page" was already running when Yes came; its files stayed (about.html; index.html got a link to it),
    the critic reviewed and "accepted" the cancelled task ("About page · Cancelled · accepted"), and the next task's
    README described the cancelled page. Expected: cancelling a running task stops it and reverts its changes (the
    "Workspace before" snapshot exists), or says plainly that the files stay.
    C2 MINOR: chat-added title keeps "to …" ('Added "to write a README that explains…"'), no criteria, "Agent's choice".
    C3 MINOR: chat start card "Estimated CHF 5.00" is the budget (the Start dialog said about CHF 1.24).
(d) D1 MINOR: session page: raw-id title; finished session shows [Stop now]; timeline mixes event names and raw markdown
    ("**Summary**:"); critic verdict line cut mid-word; jargon "inbox.message: Read a request message from Alice.",
    "session.end_inbox: Read 1 message before writing the session's end…".
    D2 (elevate to MAJOR for review quality): the critic "could not check the claims … because those files were not in
    the request" in 4 of 5 reviews (diff only).
    D3 MINOR: Changes page: every row tagged "undoable", including "Cannot be undone now: …" rows; "Started a session…"
    offers Undo after the session ended; invented "Said:" for UI actions ('Said: "Resume"', 'Said: "New task: Contact page"').
Also: latency on c316eba specialist ~2.3 s, critic ~3 s, chat ~6 s; no rate limits/malformed calls/provider errors in 37 calls.
