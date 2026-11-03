# Answers to your seven questions (2026-11-02)

Every statement about the app comes from reading its code. Statements about Claude and GitHub come from their documentation. If something could not be checked, the section says so.

**Words used below**
- **Repository**: the project's folder on GitHub. **Main**: its main copy, the one everyone works from.
- **Branch**: a separate copy of the work, made so a task can change files without touching main.
- **Pull request (PR)**: a proposed change, waiting on GitHub to be put into main. **Merge**: putting it into main.
- **Automatic checks**: the tests GitHub runs by itself on every proposed change (developers call this CI). Your sandbox repository has none.
- **Critic**: Forerunner's reviewer, which reads every task's work before the task counts as done.
- **Credential**: your Claude API key (you pay per use) or your Claude subscription (no per-use money, but limits that reset every five hours and every week).
- **Hook**: Forerunner's own safety check, which runs before an agent's action and can refuse it.
- **Sandbox**: the Docker container that Forerunner runs commands in, kept separate from the rest of your PC.

---

## 1. Should Forerunner merge after every task?

**Short answer.** Yes, but only on repositories where that is safe, and you choose per project. Forerunner should merge accepted work by itself when the repository has automatic checks and nothing puts main online automatically. Everywhere else, your sandbox included, it should wait for you, with a one-click Merge button in the app so you never need GitHub's buttons. In both cases the plan keeps going, because a task that builds on unmerged work starts from that work.

**What happens today**
- Each task works on its own branch and opens a pull request to main.
- A task counts as "done" when the critic accepts it, not when it is merged. A task that depended on it then started from a main that did not have the work yet. That is why the tester failed in your live run.
- Forerunner merges by itself only at autonomy level 3, "Trusted". New projects start at level 2, so every pull request waits for you, and nothing tells you so.
- When Forerunner does merge, it squashes: all of a pull request's commits become one commit. You merged #4 with GitHub's default, "Create a merge commit", which keeps the commits as they are.
- Your sandbox has 6 open pull requests. #1, #3 and #5 are Forerunner's own docs, #2 is from an older project, and #6 and #7 are task work. Only #4 is merged.
- On the waiting fix branch (not merged yet): a task that depends on unmerged work starts from that work. Its pull request then says "merge in any order".
- Only one task runs at a time on your PC, so Forerunner's agents never edit at the same moment. Collisions come from pull requests that are open at the same time, and from people or other bots changing main.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| (a) Forerunner merges every accepted task | Every later task, person and bot starts from finished work. Nothing waits on you. "Done" really means "in main". Small, frequent merges cause fewer and smaller conflicts | No person looks before work reaches main. On a repository without automatic checks, nothing tests the combined result once main has moved. Many repositories put main online automatically (website hosting), so each task would go live unseen. The extra sign-off for high-risk work depends on the planner rating the task correctly, and it once got that wrong. Merges show under your name. A comment on a merged pull request no longer starts any work. There is no Undo |
| (b) Build on unmerged work; you merge on GitHub (the waiting fix) | Nothing reaches main without you. The plan keeps moving. Already built | "Merge in any order" holds only for "Create a merge commit". With GitHub's Squash button a test with git gave a conflict, and the app went on saying a merged change was still waiting. Work you rejected can slip in through a later pull request. Pull requests pile up. Tasks that do not depend on each other can still conflict, and the app does not notice |
| (c) Stacked pull requests (each one built on the one before) | Each shows only its own change | You must merge them in order. GitHub's support for this is new (preview) and hard to drive. Checks may not run on them. One merge in the wrong order breaks the stack |
| (d) Hold the next task until you merge | Cleanest history | The plan stops after every step, which is what you ran into live |
| (e) One pull request per session | Fewer pull requests | One bad task blocks the good ones. Long-lived branches end in big conflicts. A large rework |

**What this means for working with others (co-work, several bots)**
- Merging often is better for teamwork: everyone starts from the latest work, and conflicts stay small and show up early.
- It only works if something checks each combination before it lands: automatic checks, or a person.
- Colleagues will see your name on every merge Forerunner makes, because it uses your GitHub key. They may think you reviewed each change.
- Waiting for you is safer for main, but conflicts then show up later, and you are the one who has to sort them out.
- Several Forerunner installs on one repository are out of scope this round and untested.

**Recommendation and why**
- A per-project setting, "Who merges accepted work": Forerunner, or me. It is separate from level 3, which would also allow much more, such as staging deploys and expensive session starts.
- When you link a repository, the app reads it and picks a starting answer:
  - "Forerunner merges", only if the repository has automatic checks and nothing puts main online automatically;
  - otherwise "I review first", with one sentence saying why, for example "this repository has no automatic checks". On your sandbox that is "I review first".
- In "I review first" mode, the Overview's "Waiting for you to merge" list gets a Merge button. It uses the same safe merge step, treats your click as the approval, merges in the right order, and always uses a merge commit. You never run into the squash problem.
- In every mode:
  - merge commits only, never squash;
  - no automatic merge where main requires an approval (GitHub does not let you approve your own pull requests), and never by skipping your own rules with an admin key;
  - a "Take this work out" button opens a pull request that undoes a merged task, and names the later tasks that built on it.
- Before either mode ships, four faults get fixed:
  - the merge step must not replay a branch that carries another task's work, because that creates duplicate copies;
  - the reviewed version is saved when the critic accepts it, and only that version is merged;
  - a merge still waiting when the PC sleeps or the app closes is saved and retried later;
  - the waiting fix gets its gaps closed, and stops saying "merge in any order" until that is true.
- Why: priority 1 means the plan never stops, something checks what reaches main (automatic checks or you), and the app never says something untrue. Priority 2 is your choice per project. On cost, merging early avoids paid reruns like the tester's, and waiting for checks costs time, not money.
- (c), (d) and (e) are not recommended: (c) puts the merge order on you, (d) stalls, and (e) is a large rework.
- Not verified: whether main going online can be detected reliably for hosts outside GitHub, how GitHub's newer merge request behaves with an admin key, and anything involving two installs.

**What would be built**
- A per-project "Who merges accepted work" setting, asked once when you link a repository.
- At linking, the app reads the repository (automatic checks? does main go online by itself?) and picks the starting answer, with one sentence why.
- A Merge button on "Waiting for you to merge" that merges in dependency order.
- Merge commits only, sent with GitHub's merge request that keeps your rules.
- No automatic merge where approvals are required, and one sentence explaining why.
- The reviewed version is saved at accept and only that version is merged. A branch that carries another task's work gets main brought into it instead of being replayed.
- A waiting merge is saved and retried after the checks pass, a restart or sleep.
- A dependent pull request is rebuilt when the work it builds on is merged, closed or redone.
- Open pull requests that start to conflict are noticed and reported on one card, in plain words.
- "Take this work out" opens an undo pull request and lists the later tasks it affects.
- A decision record, the user guide, tests (a chain of three tasks, both merge methods, required approvals, an undo), and a live walk on the sandbox.

*For the record:* loop/merge.ts (:54, :240-315, :379, ~:590), enforcement/autonomy.ts:43, enforcement/hooks.ts:363-367, githost/github.ts:425, state/repos/task.ts:377-380, session/runner.ts:1814-1825, session/githost-watcher.ts:22-40 and 468-469, fix/decisions pr-executor.ts:152-156, 322-349, 447-473, git.ts:478-479, critic/rules.ts:244, ADRs 0062 and 0106; git experiments in /tmp/frbench/owner-q/gitexp; GitHub docs: about pull request merges, about protected branches, merge a pull request asynchronously, stacked pull requests.

---

## 2. Using the API key and the subscription the same way

**Short answer.** Make the two do the same things wherever possible. Then the app picks for each task in two steps: first, which of your credentials can do this task properly on this PC; second, your preferred order among those. When only one can, the task goes there and the plan card says why before you approve. But two reliability faults come first: a refused key is reported as a vague error and fails one task after another, and with one credential at its limit, the rest of the session fails instead of waiting.

**What happens today**

| | API key | Subscription |
|---|---|---|
| Search the web | No | Yes, but it returns only titles and addresses |
| Open a web page | Yes, with Forerunner's own page reader | No, every page is refused |
| Run commands in the sandbox | Yes | No, unless switched on, and then outside the sandbox |
| Ask you a question during a task | Yes | No, it lists questions in its report |
| Cost | Money per use | No money; uses your plan's limits |

- Which credential runs: your order from Settings if you set one. Otherwise tasks use the subscription first, and chat, planning and reviews use the API key first. A task never changes credential partway through.
- A refused key or expired sign-in: the app reports "Claude did not answer (model call failed)", tries once more, and then marks the task failed. The next task picks the same refused key again. The card never says your key was refused.
- A usage limit:
  - the credential rests until its reset time;
  - the task goes back to "ready" and is not tried again in this session, and later tasks use the other credential;
  - with only one credential, every remaining task in the session fails, each with its own card ("no billing source available"; read in the code, not run);
  - nothing restarts the task when the limit resets, yet the app says it "runs on the next credential".
- On the waiting fix: research always goes to the API key when one is saved, ahead of your order. The science-evaluator is described as "searches the web" on the subscription, which is untrue, because it has no search there.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| 1. Keep the waiting fix as it is | Nothing to build | Research overrides your order. No search on the API key. A refused key and limits stay as above |
| 2. Anthropic's own search and page reading on the API key | Little new code | Pages are read outside Forerunner's checks. Cannot read pages on your own network |
| 3. A chooser that knows what each credential can do. Anthropic searches; Forerunner reads pages on both (recommended) | Your order applies to research too. Pages stay under Forerunner's checks. One rule covers every specialist | Real engine work on the API side, and two paths to test |
| 4. A separate paid search service | Every search passes Forerunner's checks | A second account, key and bill |
| 5. Run the API key through Claude Code too | One engine | Loses the sandbox for commands, asking you, and the page reader. Undoes an earlier decision of yours |

**Recommendation and why.** Option 3, in this order:
1. **Reliability first.**
   - A refused key is reported as refused, marked, and named on one card ("Anthropic refused your API key: save a new one in Settings"). The task goes back without counting as a failed try.
   - When no credential can run, tasks wait and show the reset time ("waits until 15:40, your subscription's limit"), then start by themselves.
2. **Web search on the API key** (see question 5).
3. **The chooser.** It separates what a task cannot work without from what only makes it work better.
   - Research needs to both search and read, so it goes where it can do both.
   - A code task on the subscription cannot run commands while it works, but the project's own checks still run before the critic reads it. That comes from the design record; I did not trace it in the code.
   - If "can run commands" became a must, almost every code task would go to the API key, and you would pay for most of the work even with the subscription first. So the plan card shows the difference with its cost, and a setting decides.
   - Later, try running Claude Code inside the sandbox, so the subscription can run commands too. The Claude Agent SDK offers a way to do this; it is untested here.
4. **The same page reader on the subscription** (question 6), and the site rules.

More decisions in the plan:
- If your first choice runs out in the middle of a session, the default is to wait and start again by itself. That is what you asked for earlier. A setting can switch it to "use the other one", but switching moves work from plan limits onto money.
- One point only Anthropic can settle. Their Claude Code terms say developers building on the Agent SDK "should use API key authentication" and "may not collect, store, or intermediate Claude.ai credentials or session tokens". Forerunner stores your subscription token. I cannot tell whether that applies to your own app on your own PC. Until you hear from Anthropic, new features are built on the API key first, because that path is clearly within the terms.

Why: priority 1, the app must never fail quietly or misreport. Priority 2, your order decides everything both credentials can do. On cost, the chooser makes a credential that costs more per task a visible choice, never a surprise.

Not verified: none of this was run live, and the cost figures in question 5 are estimates.

**What would be built**
- A refused key is detected on both paths: the credential is marked "refused", one card is shown, and the mark clears when you save a new key.
- When no credential can run, tasks wait with their reset time and start by themselves, instead of failing one by one.
- After a limit, the app says what is really happening ("continues on your API key now" or "waits until 15:40").
- The chooser: what each task needs against what each credential can do here, with your order deciding among the ones that can. The plan card, New task and Settings use the same words, and Settings gets a small "What each can do here" table.
- Two settings: "When my first choice runs out mid-session: use the other / wait", and "Code tasks that need commands: my first choice anyway / the API key".
- Correct the science-evaluator's wording before the waiting fix is merged.
- Later: try running Claude Code inside the Docker sandbox.
- Decision records (updates to 0100 and 0107), the user guide, and tests of what you would see (two credentials with the first refused; one credential at its limit).

*For the record:* wiring/billing-pick.ts:63-136, 203-220, 385-409; billing/router.ts:198-247; agent/loop.ts:417-428; agent/sdk.ts:303-310; session/runner.ts:540-547, 1497-1510, 1597-1610, 1902-1944; session/executor.ts:688, 1136, 1240-1262, 1368-1396; session/task-context.ts:33-38; evals/registry/specialists/science-evaluator/specialist.md:8-15; fix/decisions 51262b8; ADRs 0100, 0104, 0107; code.claude.com legal-and-compliance (line 55 of the saved copy) and tools reference; Agent SDK spawnClaudeCodeProcess (sdk.d.ts:2470-2491).

---

## 3. When a task is too big for its budget

**Short answer.** Today a budget stop costs more than the tokens. The half-done work is left unsaved and unreviewed, the next run is not told the work is its own, some stops show the wrong reason, and on the subscription Claude Code may keep running after Forerunner has said stop. I recommend turning every stop into a clean pause:
- at 80% of the budget the agent is told to wrap up;
- Forerunner's own code then saves the work with a note, "where I stopped" and "left to do";
- a Continue button starts the next session at once with more money, and that session starts from the note.

You cannot raise the budget of a running session today. It could be added later, between tasks, but the pause makes it unnecessary.

**What happens today: how the budget is worked out**
- Each session's budget is the amount you type at Start, otherwise the project's "budget per session", otherwise CHF 5. On top of that there is a monthly cap of CHF 150 by default.
- A fifth of the session's budget is kept for reviews. The plan is cut to fit the other 80% using estimates, and cut again after each task using what was really spent.
- Each run of a task may spend up to its task budget (the coder's default is about CHF 2.40 per run), and never more than the session has left.
- Before every call to Claude, the app works out the worst case. If that does not fit, the call is refused. The agent itself is never told about any budget.
- Estimates are often far off. In this round's live runs, page tasks cost CHF 0.02-0.05 against estimates of CHF 0.36-0.86. A research task cost USD 1.32 against an estimate of CHF 0.96, because the conversation is not cached and grew from 1,300 to 77,700 tokens.
- When an estimate is too high, the plan leaves out tasks that would have fit. When it is too low, the task stops at its cap. The app corrects its estimates only slowly, and never by more than a factor of 4.

**What happens today: the knock-on effects of a stop**
- The half-done files stay where they are, unreviewed.
  - In a folder project, the next task takes them into its own starting point.
  - In a GitHub project, they sit uncommitted on your PC: nothing is pushed and no pull request is opened. If main has since changed the same file, the next run fails with a git error that "Try again" cannot fix. I checked this git behaviour by hand.
- The next run is told only "It failed: run budget would be exceeded". It does not know the files are its own unfinished work, so it may redo the work and you pay twice.
- A stop at the monthly cap or the subscription limit is most likely shown as the task's own budget, where "Raise the budget" does not help. On the subscription, Claude Code's own spending stop shows as "Failed". Both are read in the code, not reproduced.
- **The most serious case: on the subscription, Forerunner's budget stop does not stop Claude Code.** It can go on editing files and using your plan's allowance, out of reach of "Stop now", and none of that is counted. This was read in the code and the SDK's own code; a test has not confirmed it yet.
- Cancelling after a stop leaves the files in place. Tasks that depend on the cancelled task show "Stuck" with no card and never run.
- On the subscription, a stop costs plan allowance, not money. The money loss you describe applies to the API key.

**Can a running session's budget be raised?** Not today. A session's limits are fixed when it starts and written into its signed permission pass, and each run's pass can never allow more. Raising it between tasks could be added (option D). It touches those passes, so it needs a careful security review. Raising it inside a run that is already going (option E) is not worth the risk.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| A. Keep today's behaviour | Nothing to build | All the effects above |
| B. 80/20 wrap-up, work saved by code, a note, resume from the note | A stop becomes a pause. Works even if the agent ignores the wrap-up message. The card can give the real reason | Medium to large work. On tiny budgets 20% does not pay for one call, so only the code-side save happens |
| C. Continue starts a new session at once with the higher amount | Feels like "raise and keep going". Starting a session costs no Claude call | Technically a new session. Waits if another session is queued |
| D. "Give this session CHF N more", between tasks | Exactly what you asked for | Changes signed passes mid-session. Only helps while you are watching |
| E. Raise inside the running task | Even the current run continues | The most invasive option. The subscription offers no documented way to do it |
| F. Anthropic's "task budget", so the model paces itself (beta) | The model plans to fit its budget from the start | Advisory only. Counts tokens, not francs. Anthropic says it can slightly lower how often tasks pass. Documented for the API key only |

**Recommendation and why.** B plus C, built in this order:
1. **On the subscription, stop Claude Code properly** on every budget stop and wait until it has exited before saving anything. Also count usage correctly (today some of it is counted twice and some too low).
2. **At 80% of each run, tell the agent once**: "Start nothing new, leave the files working, end with 'Where I stopped' and 'Left to do'."
   - The reserve is the larger of 20% and the cost of two calls.
   - A run that ends after that message counts as **paused**, not done, so the critic does not spend money reviewing half-done work and it does not count as a failed try.
3. **Forerunner's code saves the work.** It commits the work and the to-do list on the task's own branch on your PC. The next run continues from there, which also removes the git error above. Pushing the unfinished work to GitHub is a setting you turn on; there it would start automatic checks and be visible to co-workers.
4. **The card** says what was done, what is left, and which limit stopped it (task, session, month, or subscription allowance), and offers "Continue (CHF N more)" and "Cancel task". Continue starts the next session at once.
5. **Cancel** sets the unfinished work aside (Undo brings it back). In a folder project it does this only while no later task has built on the work. It also names the tasks that will be stuck.
6. **More honest estimates**: cache the conversation, let the estimates correct further and faster, and stop learning from a stopped task as if its cost were the full cost.

Why: estimates will always be off in both directions, so stops will keep happening. B makes each stop safe and truthful, and C gives you "raise and continue" without the risk of changing a live session.

A number to know: the session already keeps 20% for reviews, so a task that fills a whole session gets about 0.8 × 0.8 = **64%** of it for real work.

Not verified:
- nothing was run in the app;
- Claude Code continuing after a stop is read from the code, not observed;
- Anthropic's task budget: the docs say "not supported on Claude Code", but the installed SDK has an early option for it, and that is untested.

**What would be built**
- On the subscription: every budget stop stops Claude Code and waits for it to exit. Usage is counted once per message.
- The 80% line for each run, with one wrap-up message, on both credentials.
- "Paused" as its own outcome: no review, no failed try.
- A code-side save: commit with the to-do list on your PC, the next run continues from it, and pushing to GitHub only if you turn it on.
- The next run's brief starts with "Where the last run stopped": the note, the files and the to-do list, marked as information, not instructions.
- A card that names the real limit and offers Continue (CHF N more), which starts a session at once, or Cancel.
- On the subscription, Claude Code's own spending stop is reported as a budget stop.
- Cancel sets the work aside (with Undo) and names the tasks that will be stuck.
- A running task can no longer use up the share kept for reviews.
- Better estimates: cache the conversation, let the learner correct more, and skip stopped tasks.
- Later, if you want them: "Give this session CHF N more" between tasks, and a measured trial of Anthropic's task budget.
- A decision record (amending 0105), the user guide, tests of what you would see, and a bench walk.

*For the record:* billing/defaults.ts:11-12; session/runner.ts:490, 726, 1007, 1236-1240, 1853-1900, 1945-1959; enforcement/budget.ts:39, 103-152; enforcement/token.ts:137; session/executor.ts:423-441, 634, 663, 1075-1088, 1105-1175; agent/sdk.ts:206, 259-276, 285-327, 365; enforcement/killswitch.ts:121-123; session/task-context.ts:198-207; githost/pr-executor.ts:213-222, 320-330; session/budget-card.ts:46-57, 190-209; estimates/model.ts:133-134; agent/loop.ts:372-378, 394; daemon/server.ts:1383-1394; /tmp/frbench/owner-q/q3-gitexp; docs: task budgets, Agent SDK cost tracking, GitHub "events that trigger workflows".

---

## 4. Why the status stays in the app

**Short answer.** The status stays in the app because nothing in Forerunner needs a copy on GitHub. Your next sessions, the chat and the critic all read the app's own records, never the file. Putting the status on GitHub as a pull request left you something to merge after every session, and it could get stuck in conflicts. Pushing it straight into main would go around your own branch rules. I recommend keeping the app as the place where the status is always true, and, if you want it visible on GitHub, posting it as one GitHub issue (a discussion page) that the app rewrites after every session. An issue never needs merging.

**What happens today**
- After each session Forerunner writes a status: Done, In flight, Blocked, Next, plus a dated line with the stop reason and the money spent.
- Who reads it: you, in the app (Summary and Docs). The next session's agents get their information from the app's database. The chat deliberately ignores the file because it goes stale, and the critic skips it.
- In the current version, for a repository project, the status goes on a branch of its own with an always-open pull request, "docs: project status". You merge it, and the next session opens a new one.
- On the waiting fix (pending your yes): the status stays in the app by default, with no pull request. A Settings switch brings the pull request back.
- Faults found:
  - The repository still gets a template status file saying "nothing yet", marked as maintained by Forerunner, and nothing ever updates it. On GitHub that file is untrue.
  - Every project uses the same branch name for its status. Two projects on one repository would overwrite each other (read in the code, not run).
  - The status branch is never brought up to date, so once a conflict exists, it stays.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| (a) A status pull request (current version) | A real file in the repository. Works with "changes only through pull requests" | A chore after every session. Can conflict with the docs pull request (reproduced with git), and you cannot merge a conflicted one with a click. You cannot approve your own pull request where approvals are required. Starts automatic checks every session. Shows your spending publicly on a public repository |
| (b) Commit straight into main | Always current | Breaks Forerunner's own rule that main changes only through pull requests. Your admin key would quietly skip your branch rules. Can trigger deploys. Your own copy keeps falling behind |
| (c) A status branch with no pull request | Nothing to merge | Nobody looks there, and main keeps the untrue template |
| (d) Put it inside each task's pull request, or as a comment there | A reviewer sees the status | Inside: conflicts on every task pull request. As a comment: scattered and buried |
| (e) One GitHub issue per project, rewritten after each session | Nothing to merge or conflict. No checks run. Readable by collaborators and the phone through one link. One per project | Not a file in the repository (a change to the original spec). Needs Issues permission on your key. Issues can be switched off on a repository |
| (f) Only in the app (the waiting fix's default) | Always works, offline too | Only this PC has it. The untrue template file stays on GitHub |

**Recommendation and why.** Keep the app as the true record (f), and offer (e) as the way to show it on GitHub.
- Whatever the choice, stop putting a "nothing yet" status file into the repository when no status file is published there.
- Never post the spending on GitHub.
- The pull request (a) can stay as an advanced choice, only if you want the file itself in the repository. It would then need its own branch per project, kept up to date.

Why: your first priority is "never stuck, never untrue". Every way of putting a file on GitHub either gives you something to merge that can get stuck, goes around your rules, or hides the status where nobody looks. An issue has none of these problems. When posting fails (offline, Issues switched off, missing permission), the app still has the true status and says why in one sentence. To be fair to the session lead: the choice rightly removed the chore, but it left an untrue file on GitHub, and that needs fixing.

Not verified:
- whether editing an issue notifies people watching the repository (GitHub's docs do not say);
- how GitHub answers an update when Issues are switched off;
- nothing was tried live on the sandbox.

**What would be built**
- No status file in the repository unless the status is published as a file. A status file a person wrote is left alone.
- The setting "Status on GitHub": off, or as an issue, plus "as a pull request" only if you want it.
- The issue is found again by a marker line, created or rewritten after each session, with a plain sentence when posting fails.
- The Docs tab says where the status is ("In the app; also on GitHub: issue #12").
- No spending or stop reason in anything posted to GitHub.
- If the pull request choice stays: one branch per project, brought up to date before each write.
- Tests (issue created and then updated, two projects on one repository, failure messages), one live check on the sandbox, and the decision record and user guide.

*For the record:* session/runner.ts:2173-2217 (2206 spend line), 2396-2415; loop/docs.ts:51, 270-292, 439-441; fix/decisions 627b306 loop/docs.ts:62-72, 105, 351-358; memory/src/docs.ts:10-19, 57-61, 118-135; conversation agent.ts:1375-1379; task-context.ts:154; critic.ts:399; daemon/pull-requests.ts:53; githost/types.ts:270-283 (unused issue functions); /tmp/frbench/owner-q/conflict-demo; GitHub docs: about merge conflicts, about protected branches, events that trigger workflows.

---

## 5. Can the API search the web?

**Short answer.** Yes, you are right. The API can reach websites in two ways. Either Anthropic runs web search and page reading on its own servers when the app asks for them, or the app reads the page itself and hands the text to Claude. I recommend adding Anthropic's web search to the API key, at USD 10 per 1,000 searches (1 cent each), and keeping Forerunner's own page reader for opening pages on both credentials, so every page passes Forerunner's safety checks.

**What happens today**
- On the API key, Forerunner already reads pages with its own reader. That is how your earlier bots could open your pages: they used one of the two ways above. What Forerunner's API path cannot do yet is search.
- On the subscription, Claude Code's search works, but it "returns result titles and URLs" and does not open the pages. Every page read is refused, because research's list of allowed sites is empty.
- On the waiting fix: research is sent to the API key whenever one is saved, and with only a subscription it searches but opens no page, and says so.
- A safety gap today on the subscription: web text reaches Claude without the "this is information, not instructions" wrapper, because the app uses a field that Claude Code honours only for other kinds of tools.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| (a) Keep the waiting fix | Nothing to build | No search on the API key. Research guesses addresses or misses sources |
| (b) Anthropic's search and page reading, both on the API key | Least code. Reads PDFs | Pages are read outside Forerunner's checks, with no record before the read. Cannot read pages on your own network |
| (c) Anthropic's search; Forerunner's reader for pages on both credentials (recommended) | Search on both. Every page passes Forerunner's checks and is kept for the critic | Engine work on the API side (see below) |
| (d) A separate paid search service | Every search passes Forerunner's checks | A second account and bill |
| (e) Run the API key through Claude Code | One engine | Loses the sandbox and the page reader. Undoes an earlier decision |

**Recommendation and why.** Option (c).
- Search is short and comes from Anthropic's own index, so leaving it to Anthropic is the smaller risk. Reading pages is the risky half, so it stays under Forerunner's checks: no addresses on your PC or home network, your block list, page text marked as information, a record before each read, and the page kept for the critic.
- Search results come back sealed (encrypted). So a claim counts as sourced only once its page has actually been opened. Otherwise the critic would be checking citations against nothing.
- The engine needs care in a few places, or research would break often, not rarely:
  - When Claude asks for a search and a page in the same step, the app has to hand the unfinished search back unchanged.
  - Anthropic can pause a long search step. Today the app treats that pause as "finished".
  - Start without Anthropic's "dynamic filtering", which needs extra machinery, and add it later.
  - If an account administrator has switched search off, carry on with page reading and say so once.
  - Each search is counted in the cost and the log, and capped per task from the money that is left.
- Cost estimate, not measured: a research task is about USD 1.00 on the API key, of which searches are about USD 0.05. Caching the conversation would bring it to about USD 0.40. On the subscription there is no money cost, only plan allowance.
- A limitation to know: Forerunner's own reader ignores proxy settings. On a PC that reaches the internet only through a proxy (common in offices), pages cannot be read, while search still works. The app should say so plainly.

Not verified:
- nothing was run live;
- whether search is switched on for your API account;
- whether promotional credits cover the search charge;
- how searches count against subscription limits.

**What would be built**
- Anthropic's web search on the API key, capped per task, starting without dynamic filtering.
- Correct handling of mixed steps, pauses and sealed search results.
- If search is off for your account, the research carries on with reading and says so once.
- "Sourced" only after the page was opened.
- On the subscription: web results get the "information, not instructions" wrapper, and Claude Code's search follows the project's site lists.
- A plain sentence when a proxy blocks page reading.
- Optional: cache the conversation to cut research cost by more than half.
- One live check (about USD 1).

*For the record:* daemon/compose.ts:1720-1733; capabilities/web/policy.ts; web/fetch.ts:53-56; session/executor.ts:141-142, 719-727, 946; provider/anthropic.ts:254-262, 395-425; agent/loop.ts:394; agent/sdk.ts:486; agent/cc-tools.ts:77-82; Claude docs (saved in /tmp/frbench/owner-q/docs/): web-search-tool.md:646 and 707 (mixed steps; USD 10 per 1,000), server-tools.md:399, tools-reference.md:670-672; SDK types sdk.d.ts:2724-2731 (updatedToolOutput).

---

## 6. Research may read any website, with optional limits

**Short answer.** Yes. The default should be "any public website", with an optional "only these sites" or "never these sites" list per project, and the same rules on both credentials. Some places stay off-limits whatever the lists say: this PC (which includes Forerunner itself) and, for this round, your home or office network.

**What happens today**
- On the API key, research can already read any public website. Your PC and home network are refused, and that check is made at the moment of connecting.
- The two lists that exist do not do what their names suggest:
  - The "site list" does not mean "only these sites". It means a listed site may also be read on a private address, which is the opposite.
  - There is no "only these sites" mode at all.
  - Blocking "facebook.com" does not block "www.facebook.com".
  - An entry pasted as "https://example.com/page" is dropped without a word.
  - Putting "localhost" on the site list opens this PC to research, including Forerunner's own background service.
- No screen sets either list.
- On the subscription, no page is opened.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| A. A settings screen, API key only | Smallest change | Not "on both". Research keeps overriding your credential order |
| B. One page reader and one set of rules on both credentials (recommended) | "Any public site" becomes true everywhere, with the same checks and the same evidence for the critic | Medium new work on the subscription side |
| C. Let Claude Code's own page reader read, checked by Forerunner beforehand | Less code | A site could still reach your home network. The critic gets a summary instead of the page |
| D. Anthropic's server-side tools with the same lists | Adds search | Runs outside Forerunner's checks. Sending both lists in one request is refused with an error |

**Recommendation and why.** Option B:
- One project setting, "Web pages research may read": "Any public website" (the default, with an optional "never these" list), or "Only these websites" (a list that may not be empty, or research would be stuck).
- Each entry covers the site and all its subdomains. The app cleans up what you type, shows it back before saving, and never drops an entry silently. Entries so broad they open too much (such as "co.uk" or "github.io") are refused in the "only" list.
- On the subscription, Forerunner's own reader is offered and Claude Code's built-in reader is switched off. Claude Code's search gets the project's lists. That needs a flag so the tool is loaded straight away; without it, Forerunner's own safety check would block it.
- The planner also sees the "only" list, so it does not plan research that needs other sites.
- Old block entries move into the new setting once, so the screen shows every block that is in force.
- Research keeps going to whichever credential can both search and read. Only when both can does your order decide, and the card says why.

Why: it makes "any site by default" true on both credentials, closes the three cases above where the app misleads you or exposes your PC, and lets your credential order apply again.

Two things you should know:
- Every site research reads sees a visit from your own internet connection, labelled as an AI agent. Only "Only these websites" limits who sees it.
- Anthropic's own reader respects the robots.txt file, in which a site asks bots to stay away. Forerunner's reader does not today, so the two paths differ there.

Not verified:
- Claude Code's search following lists set by the hook (documented, not tested);
- the built-in tool switch on Windows;
- a gap in one rarely used kind of internet address.

**What would be built**
- Reader rules: an "only" mode; entries cover subdomains; this PC, special addresses and dotless names are always refused; the home network is no longer opened by a list.
- A test-only way to reach a local test server, which no person can switch on.
- The setting with one shared clean-up, and a yes asked only when the rule is widened.
- A "Web pages research may read" row in Settings, and one line on the project page ("Research reads: any public website · Change").
- One brief line naming the project's rule, and the report says what it could not read because of it.
- On the subscription: Forerunner's reader offered and loaded straight away, Claude Code's reader switched off, the lists given to its search, and the critic's page log and the information wrapper added there too.
- A plain sentence for PCs behind a proxy.
- The decision record, the user guide and the maintainer docs.

*For the record:* capabilities/web/policy.ts:13-15, 46-79, 135-185; web/fetch.ts:68-71, 129-158, 169, 262-263, 295-335; enforcement/token.ts:231-246; wiring/browser-ports.ts:54-63; wiring/web-ports.ts:13-33; daemon/server.ts:466-485, 2670-2671; daemon/compose.ts:1726-1732, 1969-1970; agent/sdk.ts:196-214; provider/claude-code.ts:286-288 (alwaysLoad); session/executor.ts:946-976; tests research-web.test.ts:102, real-daemon.test.ts:4831, web-fetch.test.ts:269, scripts/bench/README.md:11; Claude docs: permissions, tools reference (WebFetch availability), web-fetch-tool.md:680 (robots.txt), server-tools (domain filtering), agent-sdk custom tools and tool search.

---

## 7. Why Ctrl-click on top of a normal click?

**Short answer.** We do not need it. A normal click already opens a link, and an outside link opens in your normal browser. Ctrl-click and Shift-click are what many people do out of habit to open a link in a new tab or window. Before the fix they silently did nothing, which feels broken; now they open outside links in your browser too. One point is still open: a Ctrl-click on one of the app's own links (for example Inbox) still does nothing, and I recommend it act like a normal click.

**What happens today**
- Normal click on an outside link: it opens in your system browser.
- Ctrl- or Shift-click on an outside link: since today's fix, it also opens in your system browser. Before, a leftover piece of a plugin cancelled the click and nothing happened.
- Ctrl- or Shift-click on one of the app's own links: it is refused, because a second app window would need the app's private key to talk to its background service. Nothing happens.

**Options**

| Option | Good | Bad or unforeseen |
|---|---|---|
| Keep doing nothing on the app's own links | No change | Feels broken, the same complaint as before |
| Act like a normal click (recommended) | Always does something sensible | Someone expecting a second window gets the same window |
| Open a second app window | Matches browser habits | The second window would need the app's private key. Two copies of the same screen are confusing. More work and more risk |

**Recommendation and why.** Act like a normal click: open the page in the same window. Priority 1 says no click should silently do nothing, and a second window is not worth the security work.

**What would be built**
- The desktop window sends a Ctrl- or Shift-click on the app's own pages to the same window instead of refusing it.
- The window check Ctrl-clicks Inbox and expects to see the Inbox.

*For the record:* apps/desktop/src-tauri/src/windows.rs:131-146 (on_new_window); apps/ui/src/components/ExternalLink.tsx:9-17; commit f0e9852 ("links leave the window one way").

---

## What I need from you

1. **Merging:** a per-project "Who merges" setting, chosen from the repository at linking (on your sandbox: you, with a one-click Merge in the app), always as a merge commit: yes / no?
2. **Credentials:** your order decides, and a task goes to the other credential only when yours cannot do it properly (the plan card says why): yes / no?
3. **Budgets:** 80/20 per run, unfinished work saved on your PC, and Continue starting the next session at once (with today's review share, about 64% of a session goes to work): yes / no?
4. **Status:** in the app only, in the app plus one GitHub issue rewritten after each session (recommended), or in the app plus a pull request (as today)?
5. **Web search:** add Anthropic's web search to the API key (about 1 cent per search, at most 10 per research task): yes / no?
6. **Websites:** any public website by default, an optional "only these" or "never these" list per project, the same on both credentials, never this PC, and no home network this round: yes / no?
7. **Ctrl-click** on the app's own links acts like a normal click: yes / no?
