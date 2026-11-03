# Phase E wave 7: extra live checks from waves 5 and 6

Run these together with the live check after wave 7 (`/tmp/frbench/phaseE7-live.md`), under its
conditions and its rules: every wave 7 area merged, the full suite and CI green, GitHub only on
`joelwellbournewood/forerunner-sandbox`, keys never printed, evidence kept for each step, and a
failure sent to a fix round.

They are the 'live-check' items of the wave 5 and 6 triage (`/tmp/frbench/wave56-leftovers-triage.json`):
W5-18 (answers), W5-29 (screens), W5-41 (noise) and W6-36 (stops, asking, decisions, verification).
Each was walked on the stand-in bench already. The live run checks what the real model and real
GitHub do.

- **Cost:** about USD 2.45 in total, a rough estimate per area below. The main check's USD 4.00 cap
  does not cover it, so the session lead sets a cap for these steps (or runs them as their own round).
  Where a step can reuse a run of the main check (journey 5's `smoke.cjs --live`, journey 4's research
  brief), reuse it.
- **Provider:** `--provider bench-live`, unless a step says otherwise.
- **Words after wave 7:** wave 7 changes some lines quoted here on purpose: polish (words of any
  area), dependent-branches (the PR text of a task that builds on unmerged work), web-search and
  sites (the drawer's research lines), budget-resume (the Cancel line, at most 100 characters).
  Where a line changed on purpose, expect the merged words and check that the meaning holds.
- **No failure can be forced on the real model.** A step that needs one (a hand-over, a retry) is
  checked only if it happens during the run. Otherwise the report says "not seen", and the bench
  walk stands.

## 1. answers (W5-18, about USD 0.20)

Answering cards from chat.

1. **The plan card, answered in chat.**
   - **Setup:** a new project with a brief. Do not approve it. Note the header line "Waiting for
     you: approve the plan" and the Inbox count.
   - **Do:** in Chat, say "approve the plan".
   - **Expect:**
     - the model calls request_answer with the option string "Approve and start" (model-call log);
     - the chat reads the question back in words, with Yes and No;
     - no card reference shows anywhere in the chat: nothing like "01a19d7b-9", which is the
       shortest unique start of a card id and can include the hyphen;
     - while Yes/No waits, the project header, Home's project line and the Inbox badge are
       unchanged: one card, never "2 questions", and no notification.
   - **Do:** say Yes.
   - **Expect:** "Plan approved: N tasks written; working on them.", and the Answered list holds only
     the plan card.
2. **A card that needs answers.**
   - **Setup:** a brief that gets a task for you, such as the bakery brief ("I will give you the
     real menu, hours and address"). Approve and start.
   - **Do:** in Chat, say "go ahead on the <card> card".
   - **Expect:**
     - the reply relays the refusal in the model's own words, with the meaning "This card needs your
       answers: type them, or Cancel task.";
     - it does not claim the card was answered;
     - the card stays in Needs you, the task reads "Needs your answer", and the task after it reads
       Waiting.
3. **A task with an open card.**
   - **Do:** while step 2's card is open, ask Chat to try that task again, then to cancel it.
   - **Expect:**
     - the model relays the card's read-back, or points to the card;
     - it never shows an id;
     - the Inbox still holds one card for the task.
4. **After a session.**
   - **Do:** ask Chat "what happened last time?".
   - **Expect:** the reply says it in words, with no id and no "Ended because". The model-call log's
     context has no "[id ".

## 2. screens (W5-29, about USD 0.35)

1. **The drawer while a task runs.**
   - **Do:** run the smoke brief (reuse journey 5's `smoke.cjs --live`). While a task runs, open its
     drawer (Tasks tab, click its title).
   - **Expect:**
     - step lines appear as they happen ("wrote index.html", "ran node --check script.js: ok");
     - Open the session is there.
   - **Do:** when the task is done, open the drawer again and click a file under "Changed:".
   - **Expect:** the Files tab opens on that file.
2. **What research read.**
   - **Do:** run a researcher task whose outcome names a public page: "docs/research.md summarises
     https://example.org". This can be journey 4's research brief.
   - **Expect:**
     - its drawer lists "Read: … (https://example.org/)";
     - a page refused by the network rules reads "Not read: … (…)";
     - "The whole report" shows the report's Sources section.
3. **A hand-over, if one happens.** Expect it most on a tester task: a coder keeps its own task under
   the sign-off rule. If any task fails twice during these checks:
   - the session page reads "The <specialist> could not do … Trying again.", then "The <stand-in>
     takes over "<task>" from the <specialist>.";
   - its finished line and the drawer's run row name the stand-in;
   - if the stand-in also fails, its "could not do" line names the stand-in, not the first
     specialist;
   - a code task keeps its specialist and never asks for a migration sign-off.

## 3. noise (W5-41, about USD 0.35)

1. **No lessons or scratch notes in deliverables (#95, about USD 0.20).**
   - **Setup:** a fresh bench with `--provider bench-live` and a project without a brief. Put
     data/sales.csv (12 monthly rows of date,amount) into
     `<home>/data/projects/<id>/workspace/data/`.
   - **Do:** add two tasks, then Start:
     - a data-analyst task "Write the sales report in report.md", with the outcome "report.md gives
       the monthly totals and the best month from data/sales.csv";
     - a writer-marketing task "Write the launch copy in docs/copy.md", with the outcome "a headline
       and two short paragraphs".
   - **Expect:**
     - report.md and docs/copy.md have no line that starts with "Lesson:";
     - there is no notes.md, or any other scratch file, at the project root;
     - the Memory page shows the specialists' lessons.
2. **The reviewer and the tester (#96, #100, about USD 0.15).**
   - **Do:** make a new project with a brief that asks for a code review of existing code and for
     tests. Approve and start.
   - **Expect:**
     - the plan card's reviewer task asks for findings, not a file;
     - after the session, the reviewer's drawer shows its report, and the folder has no review.md
       or any other file the reviewer wrote;
     - the tester's task leaves docs/testing.md with the test command under Commands.

## 4. stops (W6-36: L-1, L-6, L-7, L-8, L-10; about USD 0.40)

Steps 1 to 5 run on a folder project. Step 6 runs on forerunner-sandbox.

1. **A restart during a review (L-1).**
   - **Do:** while a page task reads "Being reviewed" (its page is being tried), run
     restart-daemon.mjs. Repeat with --hard.
   - **Expect, after each restart:**
     - Tasks shows the task Ready, never "Being reviewed";
     - the Inbox Update says "… is ready again", or the session reads "Stopped: Forerunner was
       closed. "X" is ready to continue." (the second wording once polish's W6-2 is in);
     - the next Start ends with the task Done · Reviewed and tried.
2. **A Cancel at once (L-8).**
   - **Do:** when a page task turns "Being reviewed", press Cancel on its row within 0.5 s, then
     Cancel task.
   - **Expect:**
     - calls.mjs shows no critic call after the kill line in daemon.log, and no spend after it;
     - the Files tab no longer lists the page within a couple of seconds;
     - nothing says "accepted".
3. **Skip in chat (L-10).**
   - **Do:** while a task runs, say in Chat "Skip the <task> task".
   - **Expect:**
     - the read-back is a Cancel ("Cancel "X"? It is dropped; …"), not a pause: the parser answers
       before the model does;
     - Yes leaves the row Cancelled, not "Paused by you", with Undo;
     - "skip the <other> task for now" still reads back a pause.
4. **Undo after the session moved on (L-6, the Bakery C8 case).**
   - **Do:** cancel a running print task ("Add a print stylesheet print.css and link it from
     index.html") while the session goes on to a task that changes index.html. After the session,
     open Changes and press Undo.
   - **Expect:**
     - the dialog and the line no longer say "Undo brings it back": they say only what Undo does;
     - Undo either says that what the task changed is back, or that the files could not come back
       because they changed since;
     - the task is Ready, and a later Start redoes print.css.
5. **A review left behind (L-7).**
   - **Do:** after step 1's restart during a review, reopen the project.
   - **Expect:**
     - no "Being reviewed" row remains;
     - that task's Cancel dialog says only "Drops it." (plus who waits on it);
     - on a "Being reviewed" row whose review is running, Cancel still says the review stops, and
       the file leaves Files.
6. **The PR read-back on forerunner-sandbox (L-7, L-10).**
   - **Do:** in a repository project, while a task reads "Being reviewed" with its PR open, say in
     Chat "skip the <task> task".
   - **Expect:**
     - the read-back says "…its review stops now; its pull request stays open", and never "what it
       changed is removed";
     - Yes leaves the row Cancelled;
     - the PR is still open on GitHub. Close it at the end.

## 5. asking (W6-36: L-2, L-3, L-11, L-12; about USD 0.40)

1. **Questions in any list style (L-2).**
   - **Setup:** a project with no brief, and a New task "Home page in index.html" with:
     - the outcome "index.html shows the club's name and meeting time";
     - the criterion "index.html opens in a browser and shows the club's name and meeting time";
     - the criterion "styles.css is linked from index.html".
   - **Do:** Start.
   - **Expect, when the report ends with "Questions for the person:" in any list style (plain lines
     too):**
     - the Inbox shows the questions card, with one field per question;
     - it never shows '"Home page in index.html" needs your sign-off';
     - in the model-call log, the critic's request carries the questions section.
2. **The card quotes the reason (L-12).**
   - **Do:** run the garden club "Contact page" task. Its report has "**Summary**:" and a bulleted
     "Questions for the person:".
   - **Expect:** the card quotes the reason, for example "The email address info@example.org is a
     placeholder, because the brief gave no real one.", and never '": I made no edits…'.
3. **Go ahead without (L-3).**
   - **Setup:** a project "Club tools" with a task "Members chart" (data-analyst) and one other task.
     There is no csv in the folder. The chart task has:
     - the outcome "charts/members.svg: a bar chart of members per year from data/members.csv";
     - the criterion "Every bar uses the exact number from data/members.csv";
     - the criterion "No number is invented".
   - **Do:** Start. Press Go ahead without while the session runs the other task.
   - **Expect:**
     - the chart's next brief carries the choice ("## Answers from the person" with the
       go-ahead-without words);
     - if the model calls ask_person again, its tool result reads "Not asked: the person chose to go
       ahead without answering…", and no card is filed for it;
     - if the run says it cannot work without the file, the Inbox shows at most one card, in its
       words, with Send answers and Cancel task and no Go ahead without;
     - the Tasks row then offers Answer and Cancel;
     - once polish's W6-12 is in, "go ahead" typed in Chat on that second card is refused.
4. **The owner's content (L-11).**
   - **(a)** The newsletter brief ("A newsletter signup page; we will send subscribers …"): the plan
     card has no task for you.
   - **(b)** The bakery brief:
     - the card starts with "Give the real menu, hours and address", and Approve and start says the
       work starts once you answer;
     - Change the plan "Make the headings blue." keeps the step. In the model-call log, the second
       intake call's user message carries "The plan the person read, in order:" with the step first;
     - Change the plan "There is nothing for me to give: drop the task that asks me for content and
       start building." gives a plan with no person task, and the third intake call's reply does not
       add one back;
     - answer the step's questions on a fresh bakery plan: index.html then carries the typed menu,
       hours and address, with no PLACEHOLDER markers.
   - **(c)** "A small cafe page in Thun; I'll send you the opening hours and the photos", then Change
     the plan "Drop the first task. Nothing in it is for me to give; build the page now.": the new
     plan keeps the build and the check, and drops only the person's step.

## 6. decisions (W6-36: C-49, C-57, L-16, L-17; about USD 0.30)

All steps run on forerunner-sandbox.

1. **A task that builds on unmerged work (C-49).**
   - **Setup:** a repository project with task A "Write the notes in notes.md" and task B "Write the
     summary in summary.md", which waits for A. A 2-task coder and tester plan also works.
   - **Do:** Start, and do not merge anything.
   - **Expect:**
     - both tasks are Done in one session;
     - B's PR targets main, says it builds on A's PR (in the words dependent-branches settled), and
       its branch holds notes.md;
     - B's drawer lists only summary.md, and the critic's review of B is about summary.md only;
     - a 2-task plan's tester does not fail for a missing index.html.
   - **Not run here:** "Merge B's PR first: A's PR shows merged too". It holds only for a merge
     commit, and journey 1 replaces it (W6-42).
2. **The status stays in the app (C-57).**
   - **Do:** make a project from a brief, linked to the repository, and press Approve and start.
   - **Expect:**
     - no status PR is opened;
     - after the session, Docs shows README.md as current, not missing. Before the first session
       ends it may read "not written yet" (W6-25, merged-copy's).
   - **Do:** merge the docs PR on GitHub.
   - **Expect:** Docs shows the docs as current: after the next watcher poll with merged-copy in,
     otherwise after one more session.
3. **Another project's docs PR (L-16).**
   - **Do:** link a second project to the same repository while the first project's "docs: scaffold
     the standard project doc set" PR is still open.
   - **Expect:**
     - its Overview lists no "The project's standard docs · pull request #N" for the first
       project's PR;
     - its Docs tab says no doc "waits in pull request #N";
     - record what it says about its own docs: W6-27 (repo-guide, wave 8) is still open.
4. **A merged PR in chat (L-17).**
   - **Do:** on a repository project with two done tasks, merge one PR on GitHub, then ask Chat
     "where are my files?".
   - **Expect:** it says that PR is merged, and that only the other one waits.

## 7. verification (W6-36: C-1, C-3, C-17, L-4, L-5; about USD 0.45)

1. **A command line tool (C-1).**
   - **Do:** use the brief "A command line tool that counts the words in a file. Usage: node wc.js
     <file>." and press Approve and start.
   - **Expect:**
     - the coding task is Done · Reviewed and tried;
     - the drawer's command is "node wc.js <file>" (never "< file>."), with its sample file and the
       output;
     - the critic request in the model-call log carries "Tried as a person would use it" with that
       command and output;
     - the output has no colour codes: no "\x1b[" in the evidence (W6-1);
     - if the planner renamed the file and wrote no exact command, the task reads "Reviewed" plus a
       line "reads its command line, but … so it was not tried", and the README the coder wrote has
       the command in backticks.
2. **An API (C-1).**
   - **Do:** use the brief "A members API in server.js: GET /health answers {"ok":true}; GET /admin
     answers 401 without a token".
   - **Expect:**
     - the try started node server.js and called GET /health and GET /admin;
     - if the server refuses /admin without a token, the task is Done · Reviewed and tried;
     - if it answers 200, the task is sent back with "Tried node server.js: GET /admin answered 200,
       and the brief says it answers 401" and the required action "Make node server.js start and
       answer as a person would use it".
3. **A Python project (C-3).**
   - **Setup:** a project with pyproject.toml, src/calc.py and a unittest tests/test_calc.py in its
     folder.
   - **Do:** add a coder task "Write src/mul.py" and start a session.
   - **Expect:** "See what was checked" shows "unittest: passed", or "pytest: passed" where pytest is
     installed.
4. **The browser's own sandbox (C-17).**
   - **Expect:** on the cloud bench (Linux as root), a page task's drawer ends with the line that the
     browser ran without its own sandbox on this computer. W6-35 (polish) may change its words.
5. **A rewritten test script (L-5).**
   - **Setup:** a project whose package.json has "test": "node --test".
   - **Expect, if the coder narrows the script:**
     - "See what was checked" lists "test" (the original script, so the project's whole suite) and
       "test (as this task changed it)";
     - the critic request names the change.
6. **Notes are not orders (L-4).**
   - **Do:** re-run the phase C clamp-library case: a project whose round2 test already fails.
   - **Expect:**
     - in the model-call log, the retry brief's "Critic findings to resolve" holds only "Check
       failed: test";
     - the critic's [info] notes are under "Notes from the review…", with no "Resolve it";
     - the retry does not rewrite src/round.js;
     - if the coder says the test failed before its change, the Inbox gets one question card.

The command try inside the Docker container is not repeated: CI's sandbox-full-review job passed it
at c8c16fb (W6-51).

## Moved elsewhere

- **C-64, the step with both credentials saved:** it needs a Claude subscription token, so it goes
  to the owner's checklist, step 6. Its routing is re-checked by journey 2 (credential-chooser).
- **C-49's merge-order step:** replaced by journey 1 (merge commits, then a squash on GitHub's
  website).
- **C-36's session-budget card:** superseded by journey 3 (budget-resume's pause card).
- **The owner's PC checklist (Windows), with these steps:**
  - Quit from the tray while a task is being reviewed (L-1's step in the app);
  - C-17: the line about the browser's own sandbox is absent;
  - C-1: a `python3 x.py` try where only the Microsoft Store alias exists reads "not installed"
    (exit 9009);
  - stopping a session while a server task is being reviewed leaves no node.exe of the project's
    server.
