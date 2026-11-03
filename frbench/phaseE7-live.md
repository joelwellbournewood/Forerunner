# Phase E wave 7: live check after the merge

Spec: `/tmp/frbench/phaseE7.json` (fourteen areas in six groups). Run this only when all of the
following hold:

- every wave 7 area is merged into `claude/nifty-knuth-f9udt0`;
- the full suite is green (`pnpm check`, `pnpm test:integration`, `pnpm test:e2e`, the UI suite,
  and the cargo checks in `apps/desktop/src-tauri`);
- CI is green on Windows and Linux;
- the Desktop app workflow ran.

Rules for every journey:

- **Spending cap:** USD 4.00 in total. If the cap is reached, stop at a clean point and report
  what was left.
- **GitHub:** only `joelwellbournewood/forerunner-sandbox`. Do not change its branch protection;
  the approvals case is covered on the fake host.
- **Keys:** `ANTHROPIC_API_KEY` comes from the environment. Never print it or commit it, and the
  same goes for the GitHub token.
- **Evidence:** for each step, keep screenshots, the session log, the model-call log (under
  bench-live) and the spend.
- **Findings:** a failure goes to a fix round with the same pipeline as the wave, and the spend
  goes into `docs/status/handoff/NEXT-SESSION.md`.

## 1. Merging on forerunner-sandbox (about USD 1.10, `--provider bench-live`)

Areas: merge-record, dependent-branches, merge-in-app, merged-copy, merged-actions.

**First chain.** Make a repository project on forerunner-sandbox and leave its merge mode at
"You press Merge". Give it a 3-task chain: a page, a footer that depends on the page, and a test
that depends on the footer. After the session, check:

1. **Overview.**
   - It lists three PRs, each with Merge.
   - The dependent PRs say "Builds on #N (not merged yet) ... Merge #N first, or use Merge in
     Forerunner". None says "Merge in any order".
   - Each task row says "Accepted · waiting for you to merge".
2. **Open this version on the footer's PR.** The folder it opens holds the footer's files. The
   sentence is "#N as it would be merged. Changes here are not kept."
3. **Merge on the test's PR.**
   - The answer comes back at once and the row then shows progress.
   - All three PRs merge in order. On GitHub each is a merge commit with two parents and each PR
     is marked merged.
   - No branch was force-pushed between the merges (compare each PR's head sha before and after).
   - The rows then say Merged.
4. **Files tab.** It shows the merged files within a minute, with no session running, and reads
   "As merged on GitHub, updated HH:MM".
5. **Take this work out on the footer.**
   - It opens a revert PR whose body names the test task.
   - Main is untouched.
   - Leave the PR open and close it at the end.

**Second chain.** Run a 2-task chain (a page, then a change to it that depends on it). Merge the
first PR on GitHub's website with **Squash and merge**. After the next watcher poll:

- the dependent's PR lists only its own commits (it was rebuilt);
- its row is not "waiting on" the merged one;
- Merge in the app merges it with no conflict.

Then use Take this work out on the squash-merged task. The revert PR undoes exactly that squash:
main's tree after merging it would equal main before the squash. Inspect the PR's diff and do not
merge it.

**Automatic mode.**

- Set "Merge automatically after review" (the change card states the risks) and run one more small
  task. It merges by itself and its row says Merged.
- Merge a docs PR on GitHub's website: it shows in Files after the next watcher poll.

**Local only.** Put a file into "Local only" in the project's copy (Open folder from the Files
tab) and run one small task. Check:

- the task's PR on GitHub does not contain the file;
- the file is still there after the refresh.

## 2. Credentials (about USD 0.20, routed provider)

Area: credential-limits; the plan-card step is credential-chooser's.

Start the daemon with no `--provider` flag, so it uses the routed provider over the vault's
credentials and the real API base. Do not use `--provider bench-live`: it builds one provider from
the environment's key and ignores the vault.

1. **Refused key.** Use a bench home whose only credential is a key-shaped invalid API key, written
   straight into the bench's file vault (setup refuses an invalid key). A one-task brief gives:
   - exactly one Inbox card, "Anthropic refused your API key. Save a new one in Settings.";
   - a task that waits ("Waits for a new API key ...");
   - no failed-task card, and Settings shows the key as Refused.
2. **Saving the real key** (from the environment, typed into Settings without echoing it):
   - the Refused mark clears;
   - the waiting task starts by itself and finishes.
3. **A research brief.** Its plan card says where the work runs and why, for example "Runs on your
   API key: only it can read web pages here" or the search wording once web-search is in. Take a
   screenshot.

The usage-limit and two-credential cases are covered on the stand-in (`--provider bench-api`) and
in the real-daemon tests. They are not repeated live because a real limit cannot be triggered on
purpose.

## 3. Budgets (about USD 0.90, `--provider bench-live`)

Areas: budget-stop, budget-resume.

1. **Wrap-up case, folder project.**
   - **Setup:** a coder task with a brief sized above its budget: a script with tests in four files
     and a README, so the plan card's estimate is above the budget.
   - **The budget:** about three times the reserve that the run's log line names at the start of
     the run, expected around CHF 0.30-0.60. If that line says "save only", raise the budget and
     start the task again.
   - **During the run:**
     - the model-call log shows exactly one wrap-up text block, after the tool results;
     - the run ends "paused" with no critic call for it;
     - its report ends with "Where I stopped:" and a "Left to do:" list.
   - **The card:**
     - it names the task's budget, says what is done and what is left, and offers "Continue (CHF N
       more)" and "Cancel task";
     - the work is a commit in the project's folder.
   - **Continue:**
     - a session starts at once, and its brief begins "Where the last run stopped";
     - the task finishes and is reviewed once;
     - no new card appears.
2. **Wrap-up case on forerunner-sandbox.** Repeat case 1 in a repository project. The
   work-in-progress commit is on the task's branch on the PC, nothing is pushed (the "Push
   unfinished work" setting is off), and no PR is opened while the task is paused.
3. **Tiny budget, CHF 0.02.**
   - The model-call log has no wrap-up text in any request.
   - The run pauses at its budget with the code-side save only, and the log line names the
     save-only path.
   - The card is the same kind as in case 1, and the next brief lists the files that were changed
     instead of a note.
4. **Cancel.** Pause a second task that has a dependent, then press Cancel.
   - The dialog and the answer name the dependent that will be stuck.
   - The work is set aside, and Undo brings it back.

The subscription stop (Claude Code really stopped and counted once) has no live check here. It goes
to the owner's checklist, step 6.

## 4. Research with web search (about USD 1.00, `--provider bench-live`)

Areas: web-search, sites, cost.

1. **The research brief:** "Compare the free tiers of three static site hosts, with sources", in a
   project whose block list holds a "*.example.org" entry.
2. **What the model-call log must show:**
   - the web_search server tool with max_uses of at most 10;
   - the block-list entry sent as "example.org";
   - server blocks sent back byte for byte, and no 400 from the API;
   - pages read with web_fetch;
   - the search count and its price in the run's cost;
   - cache_read growing from one turn to the next.
3. **The result:**
   - the report cites only pages it opened;
   - the review's sources list the search results it saw but did not open;
   - the session log has "searched the web for ..." lines.
4. **The cost** stays well under the USD 1.32 of 2026-11-02.
5. **"Only these websites".** Set the same project to "Only these websites: developer.mozilla.org".
   - The settings row shows it, and so does the project line ("Research reads: ...").
   - Another research task refuses a site outside the list.
   - Its report names the rule.

The subscription's page reader, its WebSearch lists and the information wrapper on the
subscription have no live check here (no subscription token in the cloud). They go to the owner's
checklist, step 6.

## 5. Costs (about USD 0.40)

Area: cost.

Run `smoke.cjs --live` on a fresh bench.

- Each task's real cost is within about ×2 of the plan card's estimate for its kind.
- Every specialist call after a task's first call shows cache reads.
- The Start dialog keeps the tasks that fit.

## 6. The window (no model cost)

Area: polish-desktop.

Run the Desktop app workflow's window check on Windows.

- Ctrl+click and Shift+click on Inbox show the Inbox in the same window.
- No second window opens and nothing goes to the browser.
- A link to another site still opens in the browser.

## Reserve and hand-over

- Keep about USD 0.40 back for one retry.
- **Owner's checklist, step 6** (needs a Claude subscription token):
  - on the subscription, a budget stop stops Claude Code: the task's folder does not change after
    the pause, and the usage is counted once;
  - a refused Claude sign-in gives the same single card;
  - the page reader is offered and WebFetch is not;
  - WebSearch follows "Only these websites" and "Never these websites";
  - web text arrives wrapped as information.
- **Questions for the owner, with the U-entries.** Each one is built with its default until the
  owner answers:
  - U-078: what "wait" means when a second credential could serve the task;
  - U-078: whether commands become a hard need for code tasks on projects whose dependencies must
    be installed;
  - U-037: what happens to a "Local only" file the person changed during a run.
