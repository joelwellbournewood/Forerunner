// Part 3: the five areas that go, the new work, the amendments, notes.
const goes = [
{
  old_key: "collab-members",
  verdict: "goes",
  brief_verdict: "Goes: one membership list, Share by name, owner-only settings on a shared project and the collaborator's card all assumed a shared store. Run C's Work together replaces sharing; each person's budgets, autonomy and caps are their own.",
  group: null,
  new_scope: `Nothing in wave 8. Run C's Work together replaces sharing; each person's budgets, autonomy and caps are their own; what is shared lives on GitHub (branch protection, who may push; brief section 7 question 3). Two residuals that need no shared store are routed, not built here: PUT /projects/:id/settings (server.ts:2806 at c15d75e) merges any keys with no command and no change row (a one-person API hole: the leftovers or polish area); the cloud runner skips a project whose members exclude its agent (services/cloud-runner/src/runner.ts:666-668) while the daemon applies no membership (one person's devices: phase H, or collab-claims' one-person area if it touches the cloud runner).`,
  kept_problems: [],
  kept_acceptance: [],
  kept_tests: [],
  dropped: [
    { what: "One membership list projectPeople (owner, shared_with, owners of member agents) used by ownsProject, defaultPeers, the executor's change sentences and the cloud runner", why: "A store is one person's; there is no second person to list." },
    { what: "project.share and project.unshare, the People section, Share by name or email, 'Ada shared Team site with you.'", why: "Replaced by run C's Work together on the repository (D9)." },
    { what: "Owner-only keys on a shared project, the collaborator's card ('Bob asks to set the session budget of Team site to CHF 1.') and budget risk rated against the owner's ceiling", why: "Each person's budgets, autonomy and caps are their own (brief section 7 question 3)." },
    { what: "Change sentences to every person on the project and the Changes page listing other people's changes", why: "No other person's changes reach your store." },
    { what: "The F.6 and F.7 tests that patch members by hand, rewritten to project.share", why: "project.share goes; collab-bench's two homes and collab-journey's scenario replace them, and requirement F is re-based." },
    { what: "Owner question 'which settings stay the owner's on a shared project?'", why: "Changed: each person's settings are their own (brief section 7)." }
  ]
},
{
  old_key: "collab-privacy",
  verdict: "goes",
  brief_verdict: "Goes: another person's projects, chat, logs and spending are never in your store. What remains is a GitHub rule (nothing private goes into the status issue: no costs, chat, emails, private memory), which status-issue-write already holds.",
  group: null,
  new_scope: `Nothing in wave 8. The one rule left is on GitHub: nothing private goes into the status issue (no costs, chat, emails, private memory), held by status-issue-write's acceptance (d) and collab-journey's search of everything the journey wrote to GitHub.`,
  kept_problems: [],
  kept_acceptance: [],
  kept_tests: [],
  dropped: [
    { what: "One ownership middleware for /projects/:id*, /tasks/:id*, /sessions/:id* with 404 for another person's unshared project, and the list filters", why: "Every project in a store is its one person's." },
    { what: "Another person's session shown as a project summary; /sessions/:id/events of another person's conversation answering 403", why: "Another person's sessions and chat are never in your store." },
    { what: "The chat prompt and command parser seeing only this person's projects", why: "Same: all of a store's projects are the person's own." },
    { what: "route-ownership.test.ts (every route listed with its rule)", why: "The rule it checks (whose project) has one answer per store under D9." },
    { what: "Amendment 15 (C2): recall's spending kind split by human_id through this area's rule", why: "Moot: a store's ledger is one person's (and their own devices'); a together project's ledger holds only this Forerunner's spend, and no cost ever reaches GitHub." }
  ]
},
{
  old_key: "collab-privacy-service",
  verdict: "goes",
  brief_verdict: "Goes: the state service serves one person's devices. A one-person check on it can join collab-identity's guard if the planner wants it.",
  group: null,
  new_scope: `Nothing in wave 8. The state service serves one person's devices; a one-person check (a device reads only its person's projects) can join collab-identity's guard if the planner wants it; the push fan-out for notes addressed to an agent (services/state-api/src/push/fanout.ts) is phone polish for phase H.`,
  kept_problems: [],
  kept_acceptance: [],
  kept_tests: [],
  dropped: [
    { what: "ownsProject on every device-principal route (projects, tasks, transition, decisions, queue, uploads) and the realtime frames per subscriber's human", why: "The state service serves one person's devices; another person's projects are never on it." },
    { what: "sendMessageAs only to an agent or human that shares a project with the sender", why: "Only one person's agents are on a store." },
    { what: "Fan-out pushes only when to_human_id is the device's human", why: "Phone polish, not two-person work: routed to phase H." }
  ]
},
{
  old_key: "collab-claims-2",
  verdict: "goes",
  brief_verdict: "Goes: lapsed claims, the 'online' view, a dropped connection mid-session, the sync pause, the stop word from another person's message: all shared-store states. Two small leftovers can go to polish: a lapsed claim never blocks Start, and a review whose computer never returns lapses (one person's desktop and cloud runner).",
  group: null,
  new_scope: `Nothing in wave 8 as an area. Routed: to polish (one person's desktop and cloud runner) a lapsed claim never blocks Start (start-check.ts counts ready tasks only; expireClaims runs only at session start) and an in_review claim whose computer never returns lapses through reviewBackToReady; rewritten into status-issue-read: a task stopped because another Forerunner announced it first is not counted as done (from (g)); to the leftovers as a docs fix: UPDATE-LOG U-063 still reads open while shutdown-claims.test.ts covers it.`,
  kept_problems: [],
  kept_acceptance: [],
  kept_tests: [],
  dropped: [
    { what: "'Online' from the device heartbeat and 'last seen 14:05' on the Peers badge", why: "Another person's devices are not in your store; the other Forerunner's freshness is its comment's 'updated' time and 'not seen since'." },
    { what: "A dropped store connection mid-session ending the session in true words without a restart, and the 60 s dead-row sweep", why: "A PC's own SQLite store is always there; GitHub unreachable is status-issue-write's and -read's sentence." },
    { what: "Claim first, warn after a successful claim, titles instead of ids in the peer message", why: "Agent-to-agent overlap messages go through a shared store; across Forerunners the heads-up is a line in this writer's comment (status-issue-read)." },
    { what: "A stop word acting only on a message from the agent's own human", why: "Another person's messages never reach your agent's store." },
    { what: "The sync pause at the task boundary and the schema-gate words ('Ada's Forerunner is newer than yours ...')", why: "Two people's Forerunners share no schema; one person's devices on different versions is phone or cloud-runner polish (phase H)." },
    { what: "A run killed because the peer finished the task is not counted", why: "Rewritten into status-issue-read's (g) for announced work; the in-store form needs two agents on one store." }
  ]
},
{
  old_key: "collab-offline",
  verdict: "goes",
  brief_verdict: "Goes: a PC's own SQLite store is always there; 'offline' now means GitHub cannot be read, and status-issue-write and -read already have those words. Person-to-person messages remain an owner question (not built).",
  group: null,
  new_scope: `Nothing in wave 8. 'Offline' means GitHub cannot be read or written, covered by status-issue-write's and -read's sentences and collab-bench's 'GitHub unreachable for one home' switch. Person-to-person messages remain an owner question, not built (a comment on the status issue is the natural channel if wanted; brief section 7 question 8). ADR 0024's promise of a PC outbox and docs/maintainers/state-service.md's offline story are corrected with ADR 0024's amendment (one person's devices; written by collab-identity); the poller back-off for a person's own unreachable state service is phase H.`,
  kept_problems: [],
  kept_acceptance: [],
  kept_tests: [],
  dropped: [
    { what: "Cached project list and briefs with 'Working offline: the shared projects cannot be reached since 14:05 ...'", why: "A PC's own SQLite store is always there under D9." },
    { what: "A local SQLite outbox for notes, answers, receipts and read marks flushed on reconnect", why: "Nothing a person types goes to another store; the status comment's coalesced write (status-issue-write) is the only thing sent later." },
    { what: "Poller back-off and one log line per minute per poller for a lost store connection", why: "No shared store to lose; a person's own state service for the phone is phase H." },
    { what: "C-11 person-to-person messages ('Message Ada')", why: "Kept as an owner question, not built (brief section 7 question 8)." }
  ]
}
];

const new_work = [
{
  id: "NW-1",
  source: "brief section 5.1; section 8 questions 2, 3 and 4; amendment 4",
  title: "Announced work matches by files and titles, never by branch or id",
  what: `The two Forerunners' tasks have different ids, and a task branch is fr/<8 characters of this install's task id>-<title> (taskBranchName, packages/capabilities/src/githost/pr-executor.ts:529-537 at c15d75e), so the same work gets two branches. An announcement carries the task's title and the files it touches (the files the task names, and the files written so far while it runs; if the plan names none, the runner announces files as it writes them: the planner decides). Code matches files before the claim: every file of this task in another writer's fresh announcement: skipped with 'left to bob's Forerunner: announced on GitHub'; some files shared: a heads-up line and work goes on (proposal; the planner sets the threshold). The title is quoted as data in the brief and the plan-only intake's 'Already in the project' block ('Announced on GitHub by bob's Forerunner: "X" (files a, b)') and the planner leaves the work out; no extra model call. Two announcing within seconds: the earlier comment (GitHub's time) keeps it; the later stops before its first commit with one line, is not counted as done, and the task waits for the next plan. Duplicates by meaning only (other files, same intent) are a live-check step, never a promise (design section 5 rule 9).`,
  lands_in: ["status-issue-write (the announcement's title and files)", "status-issue-read (matching before the claim; the intake block; two at once)"],
  acceptance: [
    "Two homes: the same work planned in both under different titles and the same files: the second home skips before its claim with the words; the branches differ (asserted).",
    "Same title, other files: not skipped by code; the planner's data line shows the announcement and the stand-in plan leaves it out.",
    "Two at once: the earlier comment keeps it; the later stops before its first commit, one line, not counted as done.",
    "Exact text of the intake's block as the model receives it."
  ],
  tests: ["status-board.test.ts (announce and parse files and titles)", "a composed two-home runner case", "intake.test.ts (exact block text)", "bench journey steps 5 and 6"]
},
{
  id: "NW-2",
  source: "brief section 5.2",
  title: "Main moves under you: the next plan and every brief read what was merged since",
  what: `The other Forerunner merges into main. The rebuild and conflict machinery already handles branches (R-conflict, R-owed, the chain rebuild) and stays as it is. New: the next plan and every brief read what was merged since the last read, as data: pull requests carrying the project's mark merged since then (titles and files, from the listPullRequests read with state all that run C already makes, sources/repository-use.ts:522), shown as 'Merged on GitHub: "X" (files ...)' in the brief and the plan-only intake's block, so done work is not redone. The 'merged since' mark is persisted (restart case). Limit (ADR 0117): a push straight to the default branch without a pull request is not seen; the copy's git log after the fetch could name its files (the planner decides).`,
  lands_in: ["status-issue-read"],
  acceptance: [
    "Ada merges 'Add a footer' (footer.html); Bob's next brief and next plan name it as merged (data) and the plan leaves it out.",
    "Bob's open pull request that now conflicts gets the existing conflict notice (unchanged words).",
    "The mark survives a compose twice: no merged item named twice, none lost."
  ],
  tests: ["a composed two-home case", "intake.test.ts and the brief builder's test (exact text)", "bench journey step 10"]
},
{
  id: "NW-3",
  source: "brief section 5.3 and section 8 question 5; amendment 6; leftovers-L4i never-cut routing",
  title: "Who writes the doc set, decisions, the marker and the guide in a project two Forerunners work on",
  what: `Proposed default (brief question 5; needs a decision before any together project writes docs): the Forerunner that made the project (the marker's writer) writes the doc set, the marker and AGENTS.md/CLAUDE.md; a together project writes none of them (run C's OR-15, as built) and never takes the shared id's docs pull requests as its own; decision files from either Forerunner use date-based names (e.g. docs/decisions/2026-11-24-<slug>.md) so parallel pull requests never collide by number (the intake writes docs/decisions/0001-<slug>.md today, session/intake.ts:203). Why: the intake's docs branch is keyed by the shared id and name (fr/intake-<8 characters of the id's random end>-<name>-docs since L4-github-111, ADR 0117's amendment of 2026-11-23; the brief's 'fr/intake-<project id>-docs' is the older form, still read as the project's), so two writers would push to one branch. Recorded in ADR 0058 and 0117 (amended). The never-cut L4i leftover belongs to the same rule: an unmarked open fr/docs-scaffold pull request of another project never counts as this project's own (in repo-guide).`,
  lands_in: ["repo-guide (the guide's writer rule, the scaffold leftover)", "a decision (ADR 0058 and 0117 amendments) before the guide ships"],
  acceptance: [
    "Bob's together project writes no doc set, marker, guide or numbered decision file and never pushes to a docs branch of the shared id (host log) over two sessions and a restart.",
    "If date-based decision names are adopted: one task pull request from each home, each adding a decision file, merge without a name conflict.",
    "The scaffold and Try again never write into another project's unmarked fr/docs-scaffold pull request (real-daemon case)."
  ],
  tests: ["two-installs.test.ts (describe 'guide')", "loop-docs.test.ts", "real-daemon Try again case"]
},
{
  id: "NW-4",
  source: "brief section 5.4 and section 8 question 11",
  title: "The writer's identity on GitHub is the install id plus the GitHub login",
  what: `One comment per Forerunner: the writer is the install id (ADR 0009's device identity; a note added there) plus the login GitHub reports as the comment's author; the marker carries 'install=<install id>'. Two installs with one login (one person, two PCs) are two writers with two comments; a comment by another login carrying my marker is theirs; the install id is never shown to a person (design section 5 rule 3): the comment shows the person's and the agent's names and the login. Agents' names tell people apart in comments and commits ('Ada's agent (Forerunner)'). Question for the planner: a reinstall is a new install id, so its old comment stays and reads 'not seen since'; Forerunner never edits it (only the person can delete it on GitHub).`,
  lands_in: ["status-issue-write (marker, tamper rules)", "collab-identity (agent names)", "collab-shared-repo (commit author)"],
  acceptance: [
    "Two homes with one login: two comments, each edited only by its install.",
    "A comment by bob carrying ada's marker is bob's; Ada's Forerunner restores its own and never edits bob's.",
    "A restart keeps the install id: the same comment is edited."
  ],
  tests: ["status-board.test.ts", "two-installs.test.ts (describe 'status issue')"]
},
{
  id: "NW-5",
  source: "brief section 5.5; amendment 3",
  title: "The take-over's activity reads the status issue too",
  what: `Run C counts the project's pull requests in any state (open, merged or closed) for the 14-day rule. Wave 8 also counts the writers' last comment on the open issue of key K: repositoryElsewhere (packages/runtime/src/sources/repository-use.ts) reads the issue and its writers' comments through status-issue-host, so a person who only comments in the issue still counts as active; the offer names who works there and when last ('by ada, last active 2 Nov'); issue text stays data (wrapUntrusted, the injection scan); this install's own login never blocks Take it over; Work together stays the first button.`,
  lands_in: ["status-issue-read (with the call from status-issue-host)"],
  acceptance: [
    "Pull requests all older than 14 days, a comment by another login 3 days ago: Work together only, no Take it over, with the login and date.",
    "Only the person's own login commented: Take it over stays offered second, with its warning line.",
    "GitHub unreadable at the press: refused as today ('GitHub did not answer, so the project cannot be checked. Try again.')."
  ],
  tests: ["repository-use tests with MemoryGitHost", "real-daemon case for the offer's activity line (and the fake daemon)"]
},
{
  id: "NW-6",
  source: "brief section 5.6; amendments 1 and 2",
  title: "The together project's status goes to its comment",
  what: `The together project's 'Kept in the app' Docs row and the status pull request both go: its status goes to its own comment on issue K; its Docs row reads 'In the app; also on GitHub: issue #12'; L4-github-103's refusal for its Status pull request switch goes with the switch. The Work together press still writes nothing (OR-15): the first write is its comment at its first task start or session end. Words to re-check against design section 5 rule 9: run C's consequence line 'This Forerunner works on "Kite club" too; nothing on GitHub changes now.' stays true (it is about the press); the Details line 'What the other Forerunner does shows in its pull requests on GitHub; each of you merges your own.' and the user guide's together paragraph gain the status issue once it is built.`,
  lands_in: ["status-issue-write"],
  acceptance: ["status-issue-write's (i): the press writes nothing; the first task start adds the comment; the Docs row reads 'In the app; also on GitHub: issue #12'."],
  tests: ["two-installs.test.ts (describe 'status issue')", "real-daemon Docs row case and the fake daemon"]
},
{
  id: "NW-7",
  source: "brief section 5.7 and section 8 question 10 (proposal)",
  title: "The first person is told once, in Updates, that a second Forerunner works on the project",
  what: `GitHub write access is the consent. The first time a writer comment of another install appears on the project's issue, this Forerunner shows one Updates line, never a card or a notification (the owner wants no reminders for waiting work): proposal 'bob's Forerunner works on "Team site" too: its work shows under On GitHub.' Once per writer (install id), kept across restarts; a second new writer gets its own line.`,
  lands_in: ["collab-feed (the Updates line), on status-issue-read's reader"],
  acceptance: ["One line on first appearance; none after an edit of that comment or a restart; a second new writer gets its own line; no card, no notification."],
  tests: ["two-installs.test.ts (describe 'feed')", "real-daemon GET /inbox case after compose twice"]
},
{
  id: "NW-8",
  source: "amendment 16 (C4); runC C4 fix not_done[0]; leftovers-C4.json C4L-1; run L4 L4-creds-33 and decision D-L4-16 (run C session lead decision 37: 'goes to wave 8')",
  title: "OJ-11: Work together for a project already here (not built in run C)",
  what: `The brief's section 3 lists OJ-11 as delivered by C4; it is not: it ended in run C's not_done on the cut line and was routed to wave 8. Built so far: only the rule that of a pair here the together project is kept (join-preview.ts:203, JoinProjectsDialog.tsx:41). To build (run C decision 13 and its acceptance, restated for D9): on d1109-onerepo-link's Overview line 'o/kite is also the Forerunner project "Kite club", which is not on this computer.', Work together (before Take it over) opens JoinProjectsDialog in its together form; project.join {keep: {together: true}, close: [Site]} makes the together project with the repository's id and name (read from the repository at the press) and moves Site's work into it in the join's one transaction (moveWork and joinRefusal are written for reuse); Undo as OJ-04. With status-issue-write: once no version writes a status pull request, the join's GitHub writes are only closing Site's own open status pull request if an earlier version opened one (marked with Site's id, this install's) and, if this install wrote Site's issue, its last comment 'Joined into "Site"; its status continues in #N.' with the close (amendment 1); Site's docs pull requests are listed as information only; the other Forerunner's pull requests and comments are never touched; GitHub unreadable: refused in words, nothing moves.`,
  lands_in: ["a small area of its own after status-issue-write (group 3): its files (packages/commands/src/commands/project-join.ts, packages/runtime/src/daemon/join-preview.ts, apps/ui/src/pages/project/JoinProjectsDialog.tsx, SummaryTab.tsx's line) belong to none of the 16 areas"],
  acceptance: [
    "Composed with the stand-in GitHub and two homes (run C's OJ-11 acceptance, restated): home B has 'Site' on o/kite made through the store before the rule, with two tasks; o/kite's marker names home A's 'Kite club'; Work together on B's Overview line opens the together form; confirming makes B's together project with A's id and the marker's name, moves Site's two tasks, closes Site into it; the host's log shows only the allowed writes from B and none to A's pull requests or comment; afterwards B writes no docs pull request and its status goes to its own comment on A's issue; Undo after composing B twice puts Site back; GitHub unreachable: refused in words.",
    "Real-daemon and fake daemon cases for the dialog's together form; a JoinProjectsDialog UI test."
  ],
  tests: ["packages/runtime/test/project-join.test.ts (the two-home case)", "apps/ui/test/real-daemon.test.ts and fake-daemon.ts", "JoinProjectsDialog test"]
},
{
  id: "NW-9",
  source: "run L4 L4-chat-308 (decision 'later', wave 8); ADR 0117 Consequences (OR-15's cut line)",
  title: "Chat cannot start Work together yet",
  what: `The brief's section 3 says chat's project.create takes together: true; it does not: chat answers with 'Open New project to work on it together.' (sources/repository-words.ts:359 CHAT_TOGETHER_HINT). To build (run C's Work together decision): project.create gains together: true with no id (the daemon reads the repository's project at run time), medium risk, read back once ('Work on "Kite club" together: this Forerunner joins it as the same project. Nothing on GitHub changes now.' [Yes] [No]); the refusal's tool answer ends 'Say "work on it together" to join it here.'; the model-facing definition is code (exact text tested).`,
  lands_in: ["the same small area as NW-8"],
  acceptance: ["Through chat, a together project is made after the read-back's Yes with the repository's id, nothing written to GitHub; No writes nothing; the exact definition text the model receives is asserted."],
  tests: ["conversation request builder test", "composed chat case with MemoryGitHost"]
},
{
  id: "NW-10",
  source: "leftovers-L4i routing 'early': wave 8's first group",
  title: "UpdatesPage answers as 'human' before /me has loaded",
  what: `apps/ui/src/pages/UpdatesPage.tsx:136 sends me?.id ?? "human": a press on the model-watch report before /me has loaded answers it as 'human' (attribution), and e2e/updates.spec.ts failed once on this race. A flaky UI test source, taken early so wave 8's UI runs stay clean.`,
  lands_in: ["group 1, as a small item beside collab-bench"],
  acceptance: ["The press waits for /me (or is disabled until it loads); a UI test presses before /me resolves and asserts the person's id goes over the wire."],
  tests: ["apps/ui UpdatesPage test", "e2e/updates.spec.ts stays green on repeat"]
}
];

const amendments = [
  { index: 0, starts: "Premise (the owner's answer 1 of 2026-11-09, D9): every person runs their own Forerunner ...", lands_in: "The frame of every area above; no area of its own.", note: "Replaces the earlier 39-entry list kept in runC-plan.before-answers.json." },
  { index: 1, starts: "status-issue-write (the noticeboard of one project across Forerunners): one pinned issue per project, key K ...", lands_in: "status-issue-write: new_scope (1), (2), (8); acceptance (b), (g) restated, (i); new work NW-4 and NW-6. The join half also in NW-8 (OJ-11)." },
  { index: 2, starts: "status-issue-write removes fr/status and the status pull request ...", lands_in: "status-issue-write new_scope (9) and acceptance (h); the scaffold half of the ownership rule stays in repo-guide (new_scope (6)) until its docs pull request is the only docs branch." },
  { index: 3, starts: "status-issue-host and status-issue-read: the status issue is the live source of 'used elsewhere' ...", lands_in: "status-issue-read new_scope (8) and acceptance (k); NW-5; the call from status-issue-host (D9 addition (2))." },
  { index: 4, starts: "status-issue-read (claims across Forerunners): before planning and before every task ...", lands_in: "status-issue-read new_scope (3), (4), (6); acceptance (a), (e), (h); NW-1 and NW-2." },
  { index: 5, starts: "status-issue-write: a task paused at a budget is listed as paused ...", lands_in: "status-issue-write new_scope (2) (Paused, Waiting for Claude) and acceptance (j)." },
  { index: 6, starts: "repo-guide: AGENTS.md's Forerunner part is rendered only by the Forerunner that made the project ...", lands_in: "repo-guide new_scope (1), (3), (4); acceptance (a), (h); NW-3." },
  { index: 7, starts: "repo-guide: AGENTS.md and the one-line CLAUDE.md join the doc set that the per-turn excerpts and recall's documents kind read ...", lands_in: "repo-guide new_scope (5) and acceptance (i)." },
  { index: 8, starts: "status-issue-read: the status issue's comments that Forerunner reads become a recall kind 'status' ...", lands_in: "status-issue-read new_scope (7) and acceptance (j)." },
  { index: 9, starts: "collab-feed (from GitHub, not a store): the other Forerunner's work reaches the person from GitHub ...", lands_in: "collab-feed new_scope (1), (2), (5), (7) and its acceptance." },
  { index: 10, starts: "collab-claims (one person's own devices): a paused task's work in progress lives on the computer that ran it ...", lands_in: "collab-claims new_scope (4) (stated) and status-issue-read new_scope (4) and acceptance (h) (built); the person's own cloud runner and phone keep today's claims plus collab-claims' lost-claim stop." },
  { index: 11, starts: "collab-journey and collab-bench: two homes, each with its own SQLite store and stand-in credentials ...", lands_in: "collab-bench new_scope (1)-(4); collab-journey new_scope and kept_tests steps 3, 5, 8, 11, 14." },
  { index: 12, starts: "D5 to D7 per person, trivially with no shared store ...", lands_in: "No area builds it (it holds by construction: each store is one person's). Checked in collab-journey's new_scope and its 'nothing crosses' acceptance; the task check changing only its own Forerunner's tasks is asserted there." },
  { index: 13, starts: "Left to wave 8 deliberately: everything that shows the other Forerunner's work beyond its pull requests ...", lands_in: "Spread as named: the issue (status-issue-host, -write), announced work (status-issue-read), the feed from GitHub (collab-feed, collab-live), the guide's line (repo-guide), removing the status pull request (status-issue-write), words beyond 'Shared on GitHub with another Forerunner' (collab-feed, NW-6, NW-7)." },
  { index: 14, starts: "Gone with the shared store (wave 8 builds none of them unless its planner keeps a shared-store mode ...)", lands_in: "The five areas that go (collab-members, collab-privacy, collab-privacy-service, collab-claims-2, collab-offline); the shared-store mode is decided 'no' (brief question 1), so none is built; chat_ask_above is simply each person's own (nothing to build)." },
  { index: 15, starts: "(C2) Recall's spending kind sums the whole project ledger ...", lands_in: "Moot (collab-privacy goes): a store's ledger is one person's; a together project's ledger holds only this Forerunner's spend. Recorded in collab-privacy's dropped list." },
  { index: 16, starts: "(C4) OJ-11, not built in run C step 4: Work together for a project already here ...", lands_in: "NW-8, a small area of its own after status-issue-write; with NW-9 (chat's Work together, L4-chat-308)." }
];

const notes = [
  "Amendment numbering: index 0 is the premise. The brief's references fit that numbering except two: 'amendment 7's rules for unfinished work' (repo-guide) are item 6 here, and the 'amendments 4, 8, 9' under status-issue-read match items 4 and 8, while the paused-work clause is in 4 and 10 (item 9 is the feed). Each item's content is placed above by its text, not its number.",
  "Brief section 3 overstates run C: OJ-11 (Work together for a project already here) was not built (runC C4 not_done[0], leftovers-C4 C4L-1, L4-creds-33) and chat's together flag was not built (L4-chat-308; chat answers 'Open New project to work on it together.'). Both are wave 8 work (NW-8, NW-9), so 'wave 8 needs C4's OJ-11' becomes 'wave 8 builds OJ-11'.",
  "The intake's docs branch is no longer fr/intake-<project id>-docs: since L4-github-111 it is fr/intake-<8 characters of the id's random end>-<name>-docs (the whole-id form is still read). Both are keyed by the id a together project shares, so brief 5.3's collision stands.",
  "Code facts re-checked read-only at c15d75e: STANDARD_DOCS still lists docs/status.md (packages/memory/src/docs.ts:10-19); STATUS_BRANCH = 'fr/status' (loop/docs.ts:112); GitHost has createIssue, updateIssue and commentOnIssue only (types.ts:351-364); the bench's git host has one user 'bench'; there is no apps/ui/test/two-installs harness, only run C's packages/runtime/test/onerepo-together.test.ts; every principal defaults to 'Alice' (compose.ts:1752) and authors '<name> (Forerunner)' (compose.ts:2712); /health uses config.stateUrl ?? 'sqlite' (server.ts:657); the stop route ends any row not live in this process (server.ts:2494-2510); renewClaim's error is swallowed (runner.ts:2786); peers.ts counts in_review only (:129-136); relativeTime clamps to the past (time.ts:109); collectDocFiles reads README.md and docs/ only (docs-search.ts:91-130); the intake's 'Already in the project' block is at intake.ts:2782; workInProgressMessage is at pr-executor.ts:834; 'Push unfinished work to GitHub' exists (settings-view.ts:337, session/push-unfinished.ts); identity binds 'only' at identity.ts:181; taskBranchName is at pr-executor.ts:529-537.",
  "Old owner questions of 2026-11-02 under D9 (brief section 7): 1 and 2 moot; 3 changed (each person's settings are their own); 4 kept (each merges their own; collab-feed); 5 kept (collab-shared-repo); 6 mostly moot (collab-claims); 7 kept and matters more (status-issue-write: not locked, only write-access authors count; on by default with a switch; the Projects mirror's cost dropped); 8 kept, not built (collab-offline's dropped list); 9 kept and now needed (collab-journey's phase F); the guide's language and other tools' files kept (repo-guide).",
  "ADRs the mapped areas amend (brief section 6): 0024 and 0082 (collab-identity), 0009 note (collab-identity / NW-4), 0117 appended (status-issue-write, status-issue-read, NW-8), 0106's status part superseded (status-issue-write; repo-guide's ADR amends its doc-set part), 0058 (NW-3 with repo-guide), 0041 item 4 (collab-claims), 0097 (collab-shared-repo). Requirements F.1 to F.7 re-based on GitHub by the session lead with the owner (collab-journey).",
  "Leftovers-L4i not landing in wave 8: the phone's plain 'start' skipping POST /sessions' refusals (never cut, phase H; no wave 8 area touches the remote watcher) and the phone Inbox's raw 'warning' badge (phase H)."
];

module.exports = { goes, new_work, amendments, notes };
