# Wave 8 re-plan brief: two people, one repository, GitHub as the meeting place

For: the wave 8 planner (a later step). This is a brief, not the plan: it says what the owner's
answer 1 of 2026-11-09 changes in wave 8's 16 areas and what the planner must decide. Written
2026-11-09 by the session lead's planning step, read-only on the repository. Revised the same
evening after an adversarial check: branches never match across Forerunners (section 5.1), the
shared-store mode is decided 'no' (open question 1), and section 3 follows run C's revised offer
(Work together first; activity from pull requests in any state) and OJ-11 (the closing project's
own status pull request is closed).

Read with it:
- `/tmp/frbench/owner-decisions-2026-11-09.md`. Its last section, "Answers to the ten
  questions, 2026-11-09 ~20:05 UTC", is binding.
- `/tmp/frbench/collab/collab-areas.json`: wave 8 as planned on 2026-11-02, with 16 areas in 8
  groups, all built for a shared database.
- `/tmp/frbench/collab/owner-summary.md`: what the owner was told on 2026-11-02.
- `/tmp/frbench/runC-plan.json`, in this order:
  - area d1109-onerepo-link: the Work together decision and OR-15;
  - area d1109-onerepo-join: OJ-11;
  - `wave8_amendments`, rewritten for this brief;
  - `answers_1109_changes`, every change made for the ten answers.
- `docs/design/core-experience.md` §5 (the writing rules) and `docs/maintainers/validation.md`.

## 1. What the owner said

Question: two people on separate Forerunners and one repository. Should the second person join
the first person's Forerunner, or should both installs act as one project through GitHub?

- "im not sure what you mean by this, but if multiple people will be running it they will be
  using their own api and subscription and running it on their pc."
- "if 2 people are working on the same project they should be able to work seamlessly in the
  same git. Isnt this already built in cleanly?"

The session lead's reading (D9): every person runs their own Forerunner on their own PC, with
their own API key and subscription. Two people on one repository work in one project. The second
person's Forerunner recognises the repository's project (its id is in the repository) and joins
it as the same project, never as a second one and never as a take-over. They coordinate through
GitHub: pull requests, the status issue as the noticeboard, and the repository guide. No shared
database or server is required.

It is not built cleanly today. Two installs on one repository share only git. Each keeps its own
task list and cards, so both can plan the same work.

## 2. The new premise

| Wave 8 as planned (2026-11-02) | Wave 8 after answer 1 |
|---|---|
| Two people, one shared Postgres (desktops connect to it directly, ADR 0024/0082). | Each person has their own store (SQLite on their PC), their own credentials, budgets and caps. |
| Joining someone's Forerunner (setup step, invitation with the database password). | No joining. The second person links the repository in their own Forerunner and picks **Work together** (built in run C). |
| Sharing a project by person (`members`, `shared_with`, project.share). | One project per repository (D1). The project id lives in the repository's marker (`.forerunner/project.json`), and a together project adopts it. |
| Claims in the shared store: one task, one runner. | Work is announced on GitHub (the status issue). Announcements, not locks (the owner's status design of 2026-11-02). |
| Peer feed, handoffs, overlap warnings from the store. | Read from GitHub: the status issue's comments, the other Forerunner's pull requests, the merged history. |
| Status issue "works without a shared database" as an extra for people outside Forerunner. | The status issue is the main channel between two Forerunners of one project. |

What does not change:
- The owner's status design of 2026-11-02:
  - one pinned issue per project;
  - one comment per writer, edited only by that writer;
  - no costs, emails or chat on GitHub;
  - issue text is information, never instructions.
- The guide decision (AGENTS.md plus a one-line CLAUDE.md, kept current by Forerunner).
- "No docs/status.md in repositories".

## 3. What run C delivers before wave 8

Built in C2 (d1109-onerepo-link) and C4 (d1109-onerepo-join).

Recognition from the repository:
- The marker (else the marks of open pull requests) names a project that is not on this
  computer.
- Its activity is every pull request carrying its marks, open, merged or closed
  (`listPullRequests` with state `all`, sorted by update): `PullRequestInfo.updatedAt` and
  `authorLogin`, read against the install's own login. So a project whose pull requests are
  merged at once still counts as used.
- Limit: a push straight to the default branch, without a pull request, is not seen. Forerunner's
  own work always goes through pull requests. ADR 0117 names this limit.

The offer:
- Work together always comes first, when the repository names exactly one such project. It
  writes nothing, so it cannot break a project someone still uses.
- Take it over comes second. It is offered only when no pull request of the project was updated
  by another GitHub account in 14 days. The person's own login does not block it (a reinstall,
  or their own second computer). Its line warns: "The repository then names this project: choose
  it only if no Forerunner uses "Kite club" now."
- Two unknown ids and no marker: no Work together.

Work together (OR-15):
- Creates this Forerunner's project with the repository's id, read again at the press, never
  from the model or the page. The marker's name is kept as data.
- Records `settings.together {name, at, activeOn, login}`.
- Nothing is written to GitHub at the press.

A together project:
- Writes nothing to the repository by itself: no marker, no scaffold, no doc set, no docs or
  status pull request.
- Takes none of the shared id's docs pull requests as its own. `isProjectDocsPr` and
  `isProjectStatusPr` answer false for every way a pull request names that id: the intake branch
  `fr/intake-<id>-docs`, the hidden mark, the L-16 visible line "Forerunner project <id>." It is
  never "the one project here" for an unmarked status or scaffold pull request. (Today
  `loop/docs.ts` :170-210 would answer true in all three cases; OR-15 tests each one.)
- Docs pull requests of a project joined into it (OJ-11) are listed as information only.
- Its first plan uses the plan-only intake.
- Its pull requests are its own task rows' only. Pull request rows, the merge loop, the take-out
  and conflict notices and the GitHub watcher all go through task rows (checked:
  `daemon/pull-requests.ts` :377, `session/githost-watcher.ts` ~:211-235; task branches carry the
  install's own task id, `pr-executor.ts:512`). So neither Forerunner lists, pushes to, comments
  on, merges or closes the other's.
- Its status stays in the app with "Kept in the app: you work on "Kite club" together, so
  GitHub's copy is left as it is." (This stays true even when the Forerunner that made the
  project is gone.)
- Its Overview line: "Shared on GitHub with another Forerunner: each keeps its own tasks."
- In chat, `project.create` takes `together: true`, read back.
- A removed together project never frees the repository.

OJ-11, a project already here: Work together on its Overview line moves its work into a together
project of the repository's id, using the join's transaction, with Undo.
- `fr/status` is one branch per repository. So the join closes the closing project's own status
  pull request: it was opened by this install and carries that project's mark. This is the join's
  one write to GitHub, and the dialog says so.
- Otherwise the other Forerunner, whose project the marker names, would keep its status in the
  app.
- The closing project's docs pull requests stay on GitHub as they are, listed as information
  only.

Live check LC-C1 (no model money) runs this on forerunner-sandbox with two bench homes after C2.

Run C promises nothing more. Its words stop at "each keeps its own tasks" and "the pull requests
on GitHub show what each did".

## 4. The 16 areas: stay, change or go

Totals: 4 stay, 6 change, 1 shrinks to a small guard, 5 go.

| Area | Verdict | What changes |
|---|---|---|
| status-issue-host | **Stays** | All of it: edit a comment, list comments with authors, cheap ETag reads, pin, issues-off detection; the stand-in GitHub to match. Now on the critical path. |
| repo-guide | **Stays, one line changes** | AGENTS.md says "link this repository in your own Forerunner and choose Work together; do not start a second project on it; each Forerunner announces its work in the pinned status issue". The Forerunner that made the project (the marker's writer) renders the Forerunner part; a together Forerunner never rewrites it. Plus amendment 7's rules for unfinished work. |
| status-issue-write | **Stays, becomes central** | One issue per project, key K = the marker's project id, shared by a together project. One comment per Forerunner (writer = install id + GitHub login; two installs with one login keep two comments: acceptance (b) stays). Replaces fr/status, the status pull request and the together project's "Kept in the app" row. Acceptance (g) "two projects on one repository -> two issues" becomes one repository, one issue (amendment 1). |
| status-issue-read | **Stays, becomes central** | The read before planning and before every task is now how two Forerunners avoid double work. Acceptance (a), a third install on its own store skipping announced work, is now the main case, restated: it skips or warns on work whose files Ada's comment announces, with the title quoted as data, never on "the same branch" (each Forerunner names its task branches by its own task id, `pr-executor.ts` `taskBranchName` :505-519, so two Forerunners never share one). Acceptance (b) "a peer on the same store appears once" is moot. Adds announced work in the plan-only intake's block, recall kind 'status', and announced paused work never taken (amendments 4, 8, 9). |
| collab-bench | **Changes** | Two daemons, each with its own SQLite home and stand-in credentials, against one stand-in GitHub with two users and an organisation. The private shared Postgres and the "cut one PC's connection" switch are no longer needed for two people; the switch becomes "GitHub unreachable for one home". Run C's `packages/runtime/test/onerepo-together.test.ts` (two composed homes, one fake host) is the seed of the harness. |
| collab-claims | **Shrinks and changes** | Stopping or pausing the other person's session from your PC cannot happen (their session is not in your store), so C1/T-01 and the shared chip counts are moot for two people. Stays for one person's own devices (desktop and cloud runner through the state service): the agent that lost its claim stops at once and never pushes; POST /sessions checks whose agent it is. "One task, one runner" across Forerunners moves to status-issue-read as announced work. |
| collab-shared-repo | **Changes** | "A shared project without a repository splits in two" is solved by run C: Work together needs a GitHub repository and refuses a folder. Stays: the second person needs write access, a repository made for two lives where both can push (owner question 5 of 2026-11-02), and someone without access is told what to ask for. Commit authors must tell people apart (two "Alice (Forerunner)" today). |
| collab-feed | **Changes** | The other Forerunner's work comes from GitHub, not the store's peer feed: its status comment (working on now, waiting for Merge, last session, paused work) and its pull requests (the project mark with task marks this Forerunner does not own), shown as information with no Merge, Stop or link. Names, not ids; "you" only for the person looking; no spend. Each Forerunner merges its own pull requests (owner question 4 of 2026-11-02, default kept). |
| collab-live | **Changes, smaller** | No change feed between stores. The other Forerunner's work refreshes by polling GitHub (status-issue-host's ETag reads) within about a minute, on the Overview, Pull requests and Talk. The state service's clock-behind poller bug matters only for one person's devices: a small item or polish. |
| collab-journey | **Changes** | The two-person journey: Ada makes the project; Bob links it and picks Work together; both plan; Bob's plan leaves out Ada's announced work; each merges their own pull requests; no credential, budget or chat crosses. Plus a larger task paused at Ada's (amendment 11). User guide "Working with someone" rewritten; requirement F evidence re-based (section 6). |
| collab-identity | **Shrinks to a guard** | No "Join someone's Forerunner" step, no invitation, no binding of a store's only person. Stays: a store belongs to one person, and a second person pointed at someone else's store (FORERUNNER_STATE_URL) is refused in words; each agent gets a name that tells people apart on GitHub; /health names the store this PC uses. |
| collab-members | **Goes** | One membership list, Share by name, owner-only settings on a shared project and the collaborator's card all assumed a shared store. Run C's Work together replaces sharing; each person's budgets, autonomy and caps are their own. |
| collab-privacy | **Goes** | Another person's projects, chat, logs and spending are never in your store. What remains is a GitHub rule (nothing private goes into the status issue: no costs, chat, emails, private memory), which status-issue-write already holds. |
| collab-privacy-service | **Goes** | The state service serves one person's devices. A one-person check on it can join collab-identity's guard if the planner wants it. |
| collab-claims-2 | **Goes** | Lapsed claims, the "online" view, a dropped connection mid-session, the sync pause, the stop word from another person's message: all shared-store states. Two small leftovers can go to polish: a lapsed claim never blocks Start, and a review whose computer never returns lapses (one person's desktop and cloud runner). |
| collab-offline | **Goes** | A PC's own SQLite store is always there; "offline" now means GitHub cannot be read, and status-issue-write and -read already have those words. Person-to-person messages remain an owner question (not built). |

## 5. Work the re-plan needs that the 16 areas do not name

1. **Announced work that matches.** The two Forerunners' tasks have different ids, so code
   cannot match them by id. It cannot match them by branch either: a task branch is
   `fr/<8 characters of this install's task id>-<title>` (`pr-executor.ts` :505-519), so the same
   work gets two different branches.
   - Code can match: an announcement carries the task's title and the files it touches, so the
     runner can skip or warn on the same files before it claims. The title is quoted as data.
   - The planner sees announced and merged work as data in the plan-only intake's "Already in
     the project" block ("Announced on GitHub by ada-gh's Forerunner: …", "Merged on GitHub: …")
     and leaves it out.
   - Duplicates by meaning only the model can see: a live-check step, not a promise.
2. **Main moves under you.** The other Forerunner merges into main.
   - The rebuild and conflict machinery handles branches today (R-conflict, R-owed, the chain
     rebuild).
   - What is new: the next plan and every brief must read what was merged since (titles and
     files, as data), so done work is not redone.
3. **Decision files and docs from two Forerunners.**
   - The intake writes `docs/decisions/0001-<slug>.md`; later documents and decisions could
     collide by number when two Forerunners open pull requests in parallel.
   - The intake's docs branch is `fr/intake-<project id>-docs`. A together project shares that
     id, so two Forerunners writing a doc set would push to the same branch and take each
     other's docs pull request for their own.
   - Run C's together project writes no doc set and takes none of those pull requests as its
     own (OR-15). A later rule is still needed for what each may write: number at merge,
     date-based names, a docs branch keyed by the writer, or only the first Forerunner writes
     documents and decisions.
4. **The writer's identity on GitHub.** One comment per Forerunner: the install id plus the
   GitHub login. Two installs with one login (one person, two PCs) are two writers. Agents'
   names must tell people apart in comments and commits.
5. **The take-over's activity reads the issue.** Run C counts the project's pull requests in any
   state (open, merged or closed). Wave 8 also counts the writers' last comment (amendment 3), so
   a person who only comments in the issue still counts as active. Work together stays the first
   button.
6. **The together project's status goes to its comment.** The "Kept in the app" Docs row and
   the status pull request both go (amendments 1 and 2).
7. **The first person learns that a second Forerunner works on the project.** GitHub write
   access is the consent; Forerunner shows it in one Updates line the first time the other
   comment appears, never a card. This is a proposal (open question 10 below).

## 6. Requirements and decisions the re-plan touches

- `docs/requirements.md` F.1 to F.7 (inbox per agent and person, receipts, realtime push,
  claim-before-work, peer awareness, handoff note) are marked done on shared-store tests. Under
  D9 they need re-basing on GitHub (proposal):
  - claims: announcements in the status issue;
  - peer awareness: the issue's comments and the other Forerunner's pull requests;
  - handoff: the writer's comment's last session;
  - realtime: GitHub polling within about a minute;
  - inbox per person and receipts: one person's devices only.

  The session lead owns the requirements file and asks the owner where a row's meaning changes.
- ADRs to amend: 0024 (state service shape: one person's devices), 0082 (install identity on a
  shared store: a second person on a store is refused), 0009 (device identity), 0117 (one
  repository, one project: run C writes D9; wave 8 appends the issue and announced work), 0106
  (where the status update goes: the status pull request goes) and 0058 (project docs by pull
  request: who writes them in a together project).
- `docs/user-guide.md` and `docs/setup-guide.md`: the shared-database setup (setup-guide
  ~:285-341) stops being the way two people work together.

## 7. Wave 8's earlier owner questions (2026-11-02): which still apply

| # | Question | Now |
|---|---|---|
| 1 | A new PC finds one person on the shared database: "Are you Ada, or joining?" | **Moot.** No joining a store; a second person on a store is refused in words. |
| 2 | The invitation carries the database password. | **Moot.** |
| 3 | Which settings stay the owner's on a shared project. | **Changed.** Each person's budgets, autonomy and caps are their own. What is shared lives on GitHub (branch protection, who may push). |
| 4 | Who presses Merge on the other agent's pull request. | **Stays.** Default: each Forerunner merges its own; the other's are information. |
| 5 | Where a shared repository is created. | **Stays.** It now decides whether the second person can push at all. |
| 6 | Stop on the other person's session: information or a request to their PC. | **Mostly moot.** Their session is not in your store; the issue shows it as information. |
| 7 | The status issue: lock on public repositories, off switch, cost field of the Projects mirror. | **Stays**, and matters more. |
| 8 | Person-to-person messages. | **Stays** (not built by default); a comment on the status issue is the natural channel if wanted. |
| 9 | A second GitHub account for the live run. | **Stays, now needed.** Without it the activity rule and the two-writer comments cannot be tested for real. |
| — | The guide in English or the brief's language; other tools' files. | **Stays.** |

## 8. Open questions for the wave 8 planner

Each has a proposed default the planner may build unless the owner says otherwise. The ones
marked (owner) need the owner.

1. **A shared-store mode for two people: decided, no.** The owner already said "if multiple
   people will be running it they will be using their own api and subscription and running it on
   their pc", and twice "I thought we talked about that already". Do not ask again. The state
   service stays for one person's own devices (phone, cloud runner); a second person on a store
   is refused in words. This removes collab-members, -privacy, -privacy-service, -claims-2 and
   -offline (section 4).
2. **Claims across Forerunners: announcements or locks?** Proposed: announcements in the status
   issue (the owner's 2026-11-02 design: "Announcements, not locks"), with code skipping or
   warning on the same files before a claim and the planner leaving announced work out. Hard claims through
   GitHub issue assignees are the alternative if the journey shows collisions.
3. **How announced work matches a task here** (different ids and different branches). Proposed:
   title and files in the announcement; code matches files; the planner sees titles as data; no
   extra model call. A branch never matches across Forerunners.
4. **Two Forerunners announce the same work within seconds.** Proposed: the earlier comment
   (GitHub's timestamp) keeps it; the later one stops before its first commit, says so in one
   line, and the task waits for the next plan.
5. **Who writes the doc set, decisions, the marker and the guide** in a project two Forerunners
   work on. Proposed: the Forerunner that made the project (the marker's writer) writes the doc
   set, marker and guide; both write decision files under date-based names to avoid number
   collisions. Needs a decision before any together project writes docs.
6. **A second person without write access.** Proposed: told in one sentence what to ask for; no
   fork-based pull requests in wave 8.
7. **Where a repository made for two lives** (old question 5). Proposed: unchanged (an
   organisation both are in, else the maker's account with the other added).
8. **Who merges the other's pull request** (old question 4). Proposed: each their own; the other's
   are listed as information.
9. **The status issue's lock, off switch and cost field** (old question 7). Proposed: unchanged
   defaults (not locked, only write-access authors count; on by default with a switch; the
   Projects mirror's cost dropped).
10. **Telling the first person that a second Forerunner works on the project.** Proposed: one
    Updates line the first time the other writer's comment appears; no card, no notification
    (the owner wants no reminders for waiting work).
11. **Two Forerunners with one login.** Proposed: two writers (one comment per install).
12. **Requirements F.1 to F.7** re-based on GitHub (section 6). (owner, through the session lead)
13. **The live run.** It needs the owner's second GitHub account (old question 9). (owner) The
    model cap stays USD 3; the zero-cost two-home check (run C's LC-C1) runs before it.
14. **Size and order.** After this re-plan wave 8 is about 10 areas instead of 16. Proposed
    groups:
    1. collab-bench (two homes), status-issue-host, repo-guide;
    2. status-issue-write;
    3. status-issue-read with announced work and merged-work reading;
    4. collab-feed from GitHub, collab-live by polling, collab-shared-repo (access, authors);
    5. collab-identity's one-person guard, collab-claims slimmed to one person's devices;
    6. collab-journey.

    Wave 8 runs after run C (it needs C2's together project and C4's OJ-11), and each group's
    areas meet only at its merge, as in run C.

## 9. Rules every wave 8 area keeps

- **Failing test first at the person's boundary**: two composed homes against one stand-in
  GitHub (no shared store), driven through the UI's client, plus a two-home bench journey; a
  restart case for anything persisted (validation rules 1, 2, 4, 8).
- **Security**: issue comments, pull request bodies and branch names are data: parsed strictly,
  scanned, quoted, never instructions (the injection 'record' channel gains a status case); a
  comment can only make Forerunner more careful; GitHub is read with the configured host and
  token only.
- **Money**: no budget, cap or wrap-up line is passed; reading GitHub costs no model money; each
  person's spend stays on their own ledger and never appears on GitHub.
- **Words** (design §5): names, not ids; "you" only for the person looking; no costs, emails or
  chat on GitHub; no promise beyond what is built (run C stops at "each keeps its own tasks").
- **Never**: write to, comment on, close, merge or rebuild another Forerunner's pull request, or
  rewrite its marker, guide part or status comment.
