# Wave 8 code map: working together through GitHub (D9)

For: the wave 8 planner. Read-only map of the code at `c15d75e` (branch
`claude/nifty-knuth-f9udt0`, 2026-11-24). Every `file:line` is at that commit. Each section says
what exists, what is missing and what is risky. Section 7 lists the root causes the planner can
name. Section 8 lists where the brief no longer matches the code.

Paths are relative to `/home/user/Forerunner`. "Runtime" means `packages/runtime/src`.

---

## 1. The together project (run C OR-15, OJ-11)

### 1.1 What exists

**Repository-use module** (`runtime/sources/repository-use.ts`, 1199 lines; words in
`runtime/sources/repository-words.ts`, 483 lines):
- `identityOf` :224-266 and `sameLink` :274-284: one identity of a link. A repository in any
  spelling, or a folder by its real path, git root, worktree and origin. Read as files, with no
  git process.
- `RepositoryIndex` :304-426, with these methods:
  - `read`, bounded at `MAX_PROJECTS` (10 000) :66, :310-325;
  - `keeperOf` :338;
  - `knows` :360;
  - `projectsUsing` :374;
  - `soleUser` :395;
  - `usersOf` :413-425. W15-01's "who may own an unmarked docs pull request" rule is based on
    this method.
- `projectIdsNamedBy` :470-479: the project ids a pull request names, from the hidden mark
  `project=`, the branch `fr/intake-(.+)-docs`, or the L-16 visible line
  `Forerunner project <id>.`
- `readRepository` :509-543 reads:
  - the marker on the default branch (`getFile`);
  - `listPullRequests(ref, {state: "all", sort: "updated"})`, first 100 only (:522-535). It keeps
    `updatedAt` and `authorLogin` for each pull request that carries a mark;
  - `whoAmI().login` (:536-541).
- `verdictOf` :561-592. The marker decides. Without a marker, the ids on open pull requests
  decide. The result is one of: `free`, `here`, `removed`, `removed_together`, `elsewhere`.
- `elsewhereOf` :594-616: the activity rule.
  - "Mine" compares `authorLogin` with the install's login, case-insensitive (:595-596).
  - `ACTIVE_ELSEWHERE_DAYS = 14` (repository-words.ts:11).
  - An unknown author counts as another account (:603-606).
  - `canWorkTogether` = exactly one id (:613). `canTakeOver` = no other account active (:614).
- `RepositoryUse.check` :862-969: the one check at creation.
  - Order: this computer first (:871-881), then a folder refusal for together (:883-889), then a
    GitHub read with an 8 s wait (`READ_WAIT_MS` :722, `within` :725-736).
  - When GitHub cannot be read, the check fails open, except that Work together is refused with
    `TOGETHER_UNREADABLE` (:905-911).
  - The together verdict returns `{id, name, activeOn, login}` (:945-958). The id comes from the
    read made at the press, never from the page.
- `overviewOf` :996-1059. A together project gets `TOGETHER_OVERVIEW_LINE`
  ("Shared on GitHub with another Forerunner: each keeps its own tasks.", repository-words.ts:275).
  Any other project gets an `elsewhere` line with **Take it over only** (:1052-1058).
- `takeOverFacts` :1084-1134 refuses a together project (:1089).
- `chatLinkCheck` :658-675 adds `CHAT_TOGETHER_HINT` = "Open New project to work on it together."
  (repository-words.ts:359).

**Settings and words** (`repository-words.ts`):
- `TOGETHER_KEY = "together"` :16. `togetherOf` :42-52 returns `{name, at, activeOn, login}`.
  `isTogether` :55.
- `projectIdsOf` :28-32 is the project's id plus the ids in `joined_from`.
- `tookOverOf` :67-80. `scaffoldLeftNoMarker` :89-102.
- Words used:
  - `togetherStatusNote` :304 ("Kept in the app: you work on "X" together, so GitHub's copy is
    left as it is.");
  - `togetherDocNote` :312;
  - `togetherStatusPullRequestSentence` :299;
  - `heldStatusNote` :286.

**Creation** (`runtime/daemon/create-project.ts`):
- `createProjectRecord` :56-111. It checks the link first (:62-68), then makes the row with the
  repository's id (`...(linked.together ? { id } : {})` :89). The marker's name is kept when it is
  free (:72-74).
- `linkSettings` :114-134 writes `settings.together {name, at: clock.nowIso(), activeOn, login}`.
- `reviveTogether` :140-167 brings back a removed together row.
- `afterInsert` :170-201 always calls the scaffold. For a together project that only refreshes
  this computer's copy (docs.ts:846-864).
- Every project gets `settings.members: [deps.agent.id]` :100 (see 5.2).

**Entry points**:
- UI: `apps/ui/src/pages/NewProjectDialog.tsx:212-217` (button `offer-together`) and
  `apps/ui/src/pages/SourcesSection.tsx:292`.
- API: `CreateProjectBody.together` at `runtime/daemon/api-types.ts:1820`.

**What a together project does not write** (`runtime/loop/docs.ts`):
- `isProjectDocsPr` :215-250 returns false at once for together (:223). So does
  `isProjectStatusPr` :259-268 (:264). `ownsUnmarkedDocs` :280-300 returns false (:286).
- `scaffoldProject`: a together project gets a copy refresh and a `together: true` record; it
  pushes nothing (:846-864).
- `writeSessionStatus` :1126-1211: together, or the status pull request off, goes to `statusInApp`
  (:1144-1145).
- Settings:
  - the status pull request switch is hidden for together (`daemon/settings-view.ts:320`);
  - `settings.set` refuses it (`packages/commands/src/commands/settings.ts:428-435`).
- Docs tab (`daemon/docs-routes.ts`):
  - `keptNote` for together :246-256;
  - doc rows "the other Forerunner writes this doc" :290-301.
- Intake: `planOnlyFor` :2145-2151 gives a together project the plan-only form even with no tasks
  (:2150). The proposal's `docs` are emptied (:1512). The card is marked `plan_only` (:1583), so a
  rejection scaffolds nothing (:2282).

**Each Forerunner's pull requests are its own task rows'**:
- `daemon/pull-requests.ts`:
  - lists open pull requests (:376);
  - matches a row to a task only by `t.branch === pr.head.ref || t.pr_url === pr.htmlUrl`
    (:462);
  - lists docs pull requests only through `isProjectDocsPr` / `isJoinedStatusPr` (:512-515);
  - `isJoinedStatusPr` :53-60 is false for together (:57).
- `session/githost-watcher.ts:211-235` watches only the pull requests of task rows that have a
  `pr_url`.

**Join (OJ-01 to OJ-10) and the pair rule**:
- `commands/src/commands/project-join.ts` (keep by id or name, :43-44).
- `daemon/join-preview.ts:203-205`: of a pair here, a together project is the one kept
  (`keptTogetherLine`, `daemon/join-words.ts:207-209`).
- The UI comment is at `apps/ui/src/pages/project/JoinProjectsDialog.tsx:41`.

### 1.2 The W15-01 sole-linked leftover (never cut), with its root cause

Evidence: `leftovers-L4i.json` items "W15-01's sole-linked rule" (the fixer's new_problem, and
the review's note that Try again has it too). The real-daemon case is at
`apps/ui/test/real-daemon.test.ts:30240-30300`.

How the scaffold picks and writes a branch today:
1. `scaffoldInCopy` (docs.ts:921-949) computes
   `soleLinked = ownsUnmarked(project, repo)` (:925). It then builds
   `ours = isProjectDocsPr(project, pr, {soleLinked})` (:927).
2. `ownsUnmarkedDocs` (:280-300) answers true when all three hold:
   - the project is not together;
   - this computer's copy marker on the default branch names nothing, or names this project
     **or a project it took over** (`own` = `projectIdsOf` + `took_over.projects`, :287-291);
   - `index.usersOf(repo)` is exactly this project (:298-299).
3. `scaffoldBranchFor` (:958-985). For `fr/docs-scaffold`, any open pull request returns the
   branch at once (`branch === DOCS_SCAFFOLD_BRANCH || open.every(ours)`, :971). **The branch's
   own `.forerunner/project.json` is read only when no pull request is open** (:974-978).
4. `checkout` (:1375-1453) treats the open pull request as `foreign` only when `!ours(pr)`
   (:1428).
5. In `isProjectDocsPr`, a scaffold branch (:238-248) checks, in order: the recorded `pr_url`, the
   hidden mark, the L-16 line for its own id, any other visible id (false). After those it falls
   back to `return opts.soleLinked === true` (:247).
6. So an **unmarked** open `fr/docs-scaffold` pull request of another project becomes
   `existingPr`. Examples: a person's own pull request, one from a version before wave 15, or one
   whose body someone edited. `scaffoldOnBranch` (:988-1083) then:
   - checks it out from `origin/fr/docs-scaffold` (`fresh` is false while it is open);
   - commits the doc set and the marker;
   - pushes onto that branch (no force, :1052-1055);
   - comments on that pull request (:1056-1063).
7. Try again (`daemon/take-over-retry.ts`) runs the same `scaffoldProject`, so it writes there too.

Root cause: ownership of an open scaffold pull request is decided by its body alone, with
"this project is the only one linked here" as the fallback. The branch's marker file is the
stronger evidence (in the real-daemon case it names "Sandbox"), and it is never read while a pull
request is open. A take-over widens `own` with the taken-over id, so the copy-marker guard (:288-291)
lets it through.

The same fallback is used in four more places:
- the status pull request on `fr/status` (`isProjectStatusPr` :267; the write at :1155-1186 pushes
  and comments);
- `docsInPullRequests` (:1323-1326);
- the Pull requests list (`pull-requests.ts:413-415, 512-515`, listed with **Merge**).

So the "Never write to another Forerunner's pull request" rule (brief §9) can be broken by any
unmarked docs pull request.

Possible fixes, for the planner to choose from:
- In the scaffold path, treat an open pull request as foreign when the branch's marker names
  another id.
- Accept `soleLinked` only when the branch has no marker, or the marker is this project's.
- Accept `soleLinked` only when `pr.authorLogin` equals this install's login.
- Drop the fallback for writes and keep it only for listing.

A test must cover all of these: scaffold, Try again, status, and the list.

### 1.3 OJ-11 (Work together for a project already here): **not built**

`/tmp/frbench/leftovers-C4.json`: "OJ-11 (cut line, not built): Work together for a project
already here ... closing the closing project's own status pull request as the one GitHub write, a
two-home composed test with the fake host). project.join's moveWork and joinRefusal are written
for reuse. Goes to wave 8."

What this means in the code:
- `overviewOf` gives a project here, whose copy marker names an unknown project, only Take it
  over (repository-use.ts:1052-1058). It has no Work together button.
- `project.join` has no together form: `keep` is a string id or name
  (`project-join.ts:43-44`).
- Nothing closes a status pull request at a join. The only `updatePullRequest(..., {state:
  "closed"})` is the person's Close at `pull-requests.ts:938`.
- No code lists "docs pull requests of a project joined into a together project, as information
  only".

### 1.4 Chat `project.create` together flag: **not built**

`createParams` (`commands/src/commands/project.ts:230-236`) holds only name, goal, repos and
switch. Chat is sent to New project with `CHAT_TOGETHER_HINT` (repository-use.ts:670).

### 1.5 Status today

- The status pull request is **off by default** (C-57, `STATUS_PR_SETTING` docs.ts:120,
  `statusPullRequestOn` :123-125).
- With the setting off, every project, the maker included, keeps `docs/status.md` in
  `<projectsRoot>/<id>/app-status` (:127-128, `statusInApp` :1219-1256).
- So today neither Forerunner tells the other anything on GitHub, apart from pull requests.
- `fr/status` is one branch per repository (:111-112). When another project's status pull request
  holds it, the `STATUS_HELD_MARK` file (:138) records that (:1227-1239).

Risk: the session's status note carries money. The runner builds
`endedNote = "<ended>. Spent CHF x."` (`session/runner.ts:4167-4170`), and `writeStatusUpdate`
writes `- Note: ...` into `docs/status.md` (`packages/memory/src/docs.ts:199-200, :303`). With
the status pull request on, the note is pushed to `fr/status` (docs.ts:1166-1174). This breaks
"no costs on GitHub". Wave 8's status comment must not reuse this note. The status pull request
path goes in wave 8.

---

## 2. GitHost and its stand-ins: issues and comments

### 2.1 The interface (`packages/capabilities/src/githost/types.ts`)

What exists:
- `IssueInfo` :83-90 holds `{number, title, body, state, labels, htmlUrl}`. It has **no author,
  id or node id, updatedAt, locked, or comment count**.
- `CommentInfo` :92-98 holds `{id, body, author, createdAt, htmlUrl}`. It has **no updatedAt**.
- `RepoInfo` :11-29 has `permissions {pull, push, admin}` and `id`. It has **no `hasIssues`**.
- `PullRequestInfo.updatedAt` and `authorLogin` (:47-53) were added in run C.
- `GitHost` :259-398 has `createIssue` :351, `updateIssue` :355 (title, body, state, labels),
  `listIssues` :360 (state, labels) and `commentOnIssue` :364.
- `listPullRequestComments` :330 reads `/issues/:n/comments`, so it already lists an issue's
  comments with authors (any number).
- `AGENT_TEXT_MARKER` and `markAgentText` (:116-127) are added by every comment and review the
  port writes. `isAgentText` (:125) tells Forerunner's own text apart.

Missing:
- edit a comment (`PATCH /repos/:o/:r/issues/comments/:id`);
- get or delete a comment;
- list issue comments under an issue name, with `updatedAt`;
- pin (GraphQL `pinIssue`; needs the issue's node id), lock, and the issues-off answer (410);
- `has_issues` on `getRepo`;
- conditional reads (`If-None-Match` / 304) and ETag caching;
- `listIssues` by creator or sort, and paging;
- an issue's author and update time.

### 2.2 GitHub adapter (`packages/capabilities/src/githost/github.ts`, 1367 lines)

What exists:
- `commentOnPullRequest` :583-590 POSTs `/issues/:n/comments` with `markAgentText`.
- `listPullRequestComments` :592-604 is paged and accepts `since`.
- `createIssue` :642-653, `updateIssue` :655-663.
- `listIssues` :665-673 reads **one page of 100 with no paging**, and filters out pull requests.
- `commentOnIssue` :675-677 delegates to the pull request comment.
- Mappers: `toIssue` :1298-1309 (no `user.login`, `updated_at`, `id` or `node_id`) and `toComment`
  (no `updated_at`).
- `listPullRequests` :473-494 accepts `sort: "updated"`.
- Plumbing: `request` :172-258 handles the rate-limit 403; `paged` :349; `graphql` :785-860 (used
  by the Projects mirror only).

Missing: ETag/304 support. `request` keeps no cache and sends no conditional header, and every
poll costs a rate-limit point.

Repository permissions are mapped (:1169-1178). Only the merge path reads `permissions.admin`
(:573). **No runtime code reads `permissions.push`**, so "a second person without write access" is
never detected.

**No runtime code calls any issue method.** A grep over packages and apps finds only types.ts,
github.ts and memory.ts.

### 2.3 In-memory host (`packages/capabilities/src/githost/memory.ts`)

What exists: `createIssue` :396-411, `updateIssue` :413-422, `listIssues` :424-431 and
`commentOnIssue` :433-435. Issues share `nextNumber` with pull requests.

Missing: comment edit, issue author, pin, ETag.

Risky:
- One login per instance (`whoAmI` :134-136). `createPullRequest` stamps
  `authorLogin: this.login` (:248).
- `onerepo-together.test.ts:39-40` makes Bob with `Object.create(host)` and overrides only
  `whoAmI`, so **any pull request or comment Bob writes would carry Alice's login**.
- Any two-writer test on this host needs a real per-login view.

### 2.4 The fake HTTP host (`testenv/src/githost/`, 6218 lines)

What exists:
- `routes-issues.ts`:
  - `GET /issues` with `state`, `labels`, `creator` and `direction` (:46-66), paginated;
  - `POST /issues` (:68-82);
  - `GET` and `PATCH /issues/:n` (:84-138), which emit webhooks;
  - `GET` and `POST /issues/:n/comments` (:141-189), `since` included;
  - repository-wide `GET /issues/comments` (:191-199);
  - **`GET`, `PATCH` and `DELETE /issues/comments/:id`** (:202-246). PATCH lets any writer edit any
    comment, as GitHub does;
  - labels (:249-386).
- JSON shapes:
  - `store.issueJson` :501-540 carries `user`, `created_at`, `updated_at`, `locked: false` and
    `node_id`;
  - `commentJson` :648-663 carries `user`, `created_at` and `updated_at`;
  - `repoJson` sets `has_issues: true` (:452), always.
- Admin API (`fake-git-host.ts`): `createUser` :161, `createOrg` :165, `addMember` :169,
  `addCollaborator` :176, `createToken` per user :182. Two users with two tokens and an org are
  therefore possible.
- `routes-pulls.ts:46-59` sorts by `updated`. The request log is `host.requests()` (:343).

Missing:
- `sort=` on issues;
- ETag/304 on any route (`cgi.ts:130` handles 304 only for git http);
- `has_issues: false` / 410 (issues off);
- the GraphQL `pinIssue` and pinned issues (`routes-projects.ts` serves Projects v2 only);
- lock / `PUT /issues/:n/lock`;
- a permission matrix test for a person without push.

### 2.5 The bench `--githost`

What exists:
- `scripts/bench/start.mjs:79-103`: `--githost <port>` starts its **own** stand-in for this bench.
  `--githost-in-setup` lets the person paste the token.
- `scripts/bench/lib.mjs`:
  - `startGithost` spawns `scripts/bench/githost-server.ts` with `--root <bench>/githost`;
  - `storeGithubToken` runs `fr setup --non-interactive` with `FORERUNNER_GITHUB_API` and
    `FORERUNNER_GITHUB_TOKEN`.
- `githost-server.ts:30-38` makes **one user `bench`**, one classic token and two repositories
  (`bench/empty`, `bench/seeded`). It writes `githost.json` and logs requests to
  `githost-requests.jsonl` (:53-68).

Missing:
- a second user or an organisation;
- a way for a second bench to attach to a running stand-in (`--githost-url` or similar). Today
  two benches give two GitHubs;
- `--users ada,bob`;
- a "GitHub unreachable for one home" switch.

The 2026-11-02 collab tests named `--githost --users ada,bob` and a `--pg`; neither exists.

---

## 3. Branches, the marker, the guide, the intake's docs branch, decision numbers

### 3.1 Task branches (`packages/capabilities/src/githost/pr-executor.ts`)

What exists:
- `branchSegment` :513-520.
- `taskBranchName` :529-537 builds `fr/<last 8 hex of the task id>-<title segment>`. Two
  Forerunners never share a branch for the same work, so a match by branch is impossible across
  installs.
- Use: `task.branch || branchFor || taskBranchName` (:1031); `unusedBranch` (:1089).
- The pull request body ends with `Opened by Forerunner in the session started <UTC>` and
  `forerunnerMarker({project, task, session})` (:3126-3127). `forerunnerMarker` and
  `readForerunnerMarker` are at :558-590.
- For a together project, `project` in the mark is the **shared id**. That is why the maker's
  `readRepository` counts the together Forerunner's task pull requests as the project's activity.

Risky: the body quotes `task.outcome` and `report.slice(0, 2000)` (:3117-3123). Model text goes
on GitHub as it is. Updates add `report.slice(0,500)` as a comment (:3099-3109).

### 3.2 The marker (`runtime/sources/marker.ts`)

What exists:
- `INSTALL_MARKER_FILE = ".forerunner/project.json"` :14 with schema 1 `{schema, project, name}`
  :18-24.
- `parseInstallMarker` :48-64. `writeInstallMarker` :73-102 never overwrites another project's
  marker, except one it took over (`replace`).
- Written by:
  - the scaffold (`ProjectDocs.mark` in loop/docs.ts, :871, :1033; the first commit of an empty
    repository :1409);
  - the intake's `writeDocSet` (`session/intake.ts:2716`).
- Read by:
  - `readRepository` (repository-use.ts:512-521);
  - `overviewOf` through `copyMarker` (:1008);
  - `ownsUnmarkedDocs` (docs.ts:288);
  - `intakeBranchFor` (intake.ts:2651);
  - `scaffoldBranchFor` (docs.ts:975);
  - discovery.

Missing: the marker names no writer (install id or login) and no status issue. Wave 8's key K is
the marker's `project`. A together project never writes it (docs.ts:842-864).

### 3.3 The repository guide (AGENTS.md / CLAUDE.md): **does not exist**

- No code writes `AGENTS.md` or `CLAUDE.md`. Grep finds only comments that cite this
  repository's own AGENTS.md.
- The doc set is `STANDARD_DOCS` (`packages/memory/src/docs.ts:10-19`): README, overview,
  architecture, **docs/status.md**, decisions/, runbook, data, testing. The templates start at
  :41, and the `docs/status.md` template is at :59-62.

Risky: the owner's rule "No docs/status.md in repositories (remove the untrue template)"
(`collab-areas.json:415`). Today the scaffold and the intake still write `docs/status.md` into
every repository's doc set.

### 3.4 The intake's docs branch and decision numbers (`runtime/session/intake.ts`, 2867 lines)

What exists:
- `intakeDocsBranch` :173-183 builds `fr/intake-<8 hex of the project id>-<name>-docs`.
  `legacyIntakeDocsBranch` :189-190 uses the whole id.
- `intakeBranchFor` :2631-2655 takes the short branch when it is free or this project's, else the
  legacy one.
- Both are keyed by **project id**, so a together project that wrote a doc set would collide with
  the maker. It writes none (plan-only, §1.1).
- `FIRST_DECISION_PATH = /^docs\/decisions\/0001-<slug>\.md$/` :203. The allowlist is at
  :204-205 and the refusal words at :239.
- The plan requires a 0001 decision (:828, :838-841, :1854).
- No code allocates a decision number. Only the first plan writes one, and always as `0001`.

Missing: any numbering rule for a second writer (number at merge, date-based names, a docs branch
keyed by the writer).

---

## 4. Where a planner or a brief could read announced and merged work as data

### 4.1 The plan-only "Already in the project" block

What exists:
- `planOnlyFor` :2145-2151 holds **only this install's** task rows (`{title, status}`, up to
  2000).
- `PlanOnly` :2746-2748; `PLAN_ONLY_LISTED = 40` :2751.
- `userMessage` :2155-2200 appends `alreadyInProjectBlock(planOnly.tasks)` and
  "Plan only work that is not already in the project." (:2187-2192).
- `alreadyInProjectBlock` :2770-2788 writes the `<<<TASKS ... TASKS>>>` markers, neutralises
  quotes and adds "and N more".
- The system prompt's plan-only intro is at :2036-2038.
- The call site is :1498-1503.

Where to add: `PlanOnly` could gain `announced[]` and `merged[]` (titles, and files where
present). They would be rendered as further data lines in the same block, quoted and neutralised
as the tasks are ("Announced on GitHub by ada-gh's Forerunner: ...", "Merged on GitHub: ...").
`planOnlyFor` is the one place that collects them.

### 4.2 A task's brief

What exists:
- `DelegationBrief` is built at `session/executor.ts:1114-1160` (goal, context links,
  constraints).
- `taskContextBlock` (`session/task-context.ts:331-443`) adds `## Project`,
  `## Done before this task`, answers, `## The previous attempt` and the session note.

Missing: a "merged since" or "announced" section. `taskContextBlock` is the place, with JSON-quoted
data as for the previous attempt (:419-424).

### 4.3 Overlap before a claim (reusable)

What exists:
- `session/peers.ts` (313 lines): `PeerFeed`, `buildPeerFeed` :104, `extractPathHints` :208,
  `pathsOverlap` :225, `detectOverlap` :246, `overlapBlocks` :297, `overlapMessage` :302. It reads
  the shared store's claims, pull requests and handoffs.
- The runner checks every queued task before its claim (`session/runner.ts:2609-2646`):
  - it extracts path hints from the title, outcome and criteria;
  - an overlap emits `peer.overlap`, messages the peer and, when `overlapBlocks`, skips the task
    (`task.skipped`, reason `peer_in_flight`).

Missing: a GitHub-fed source for this feed (another Forerunner's status comment and its marked pull
requests). Wave 8's "skip or warn on the same files before a claim" can reuse `detectOverlap` and
`pathsOverlap` with a second feed, keyed by files, never by task id or branch.

### 4.4 Merges by anyone

What exists:
- `githost-watcher.ts:587-620` (`reportDefaultHeads`) reads each repository project's default
  branch head once per poll. The poll runs every `DEFAULT_GITHOST_POLL_MS = 60_000` (:61), and
  each head goes to `onDefaultBranchHead`.
- compose runs `docs.refreshCopy` on it (`daemon/compose.ts:2820`).
- The watcher runs only when `githostWatchEnabled` (compose.ts:780ff) holds: a real host or an
  injected one.

Missing: a record of what was merged since the last plan (titles and files), and a reader for it.

### 4.5 Chat recall

`RECALL_KINDS` (`runtime/conversation/recall-steps.ts:15-25`): conversation, sessions, tasks,
cards, decisions, lessons, documents, changes, spending. There is **no `status` kind**
(amendment 9).

---

## 5. State service, shared-store leftovers, the phone start path, install identity

### 5.1 The store and the state service

What exists:
- Store URL precedence: `opts.stateUrl ?? env.FORERUNNER_STATE_URL ?? config.stateUrl ?? default`
  (compose.ts:1638-1643). The CLI reads env, then config (`cli/main.ts:519`); setup reads it too
  (`setup/wizard.ts:262`).
- `remoteCommandsEnabled` (compose.ts:769-779) turns remote commands on only for a non-`sqlite:`
  store, or with `FORERUNNER_REMOTE_COMMANDS=1`.
- Install identity on a shared store: `daemon/identity.ts` (ADR 0082). `FORERUNNER_HUMAN` :20,
  selectors :101, and `identity_ambiguous` (:245) when several humans exist and nothing selects
  one.

Missing: a refusal in words for "a second **person** pointed at someone else's store". Today a
second human on a store is only ambiguous, not refused, when a selector picks them.

Risky: `/health` reports `rt.config?.stateUrl ?? "sqlite"` (`daemon/server.ts:657`), not the URL
compose used. With `FORERUNNER_STATE_URL` set and no config entry, `/health` says "sqlite" while
the daemon runs on Postgres. collab-identity's "/health names the store this PC uses" needs this
fixed.

### 5.2 members, shared_with and project.share

What exists:
- `ownsProject` (`commands/src/ownership.ts:21-33`, re-exported by `daemon/ownership.ts`) reads
  `settings.members` (agent ids), `settings.shared_with` (human ids) and `author_human`.
- `shared_with` is a high-risk setting at `commands/src/commands/settings.ts:506-515`.
  `executor.sharedWith` is at `commands/src/executor.ts:1203-1208`.
- Other readers: `join-preview.ts:124-131`, `loop/memory.ts:571`, `conversation/scope.ts:10`.
- Every new project gets `members: [own agent]` (create-project.ts:100).

Missing: a `project.share` command. There is none; sharing is only the raw setting.

The members, privacy and claims-2 areas all go under D9. The planner can leave these readers as
they are (they are harmless on one person's store) or remove `shared_with` with an ADR note.

### 5.3 The phone (remote watcher) plain start: never-cut money item

What exists:
- `remote/watcher.ts` `runStart` :779-800:
  - it checks the agent;
  - it asks `deps.startRefused(projectId)` (:789-790);
  - it calls `kill.resume()` (:792), then `deps.start(...)`, which is `scheduler.requestStart`.
- Wired at compose.ts:6051-6075. `startRefused` → `refusedStart(projectId, {evenStopped: true})`
  (compose.ts:4082-4106).

Root cause: `refusedStart` returns a sentence **only** when a refused-credential wait applies
(`!wait || wait.startable || wait.save?.to !== "/setup"` → null, :4096-4097), and only for
`nothing_runnable` (:4106). These refusals of `POST /sessions` (`daemon/server.ts:1979ff`) are
never asked on the phone path:
- `refuseOverMonth` (budget above the monthly cap, server.ts:1647-1666);
- `startBlocked`'s nothing-runnable without a credential problem (:1708ff, :2038, :2111);
- the one-wait / kept-start rules;
- the removed-project refusal (:2007-2015);
- the continuation's left budget (:1984-2003).

Fix shape: one shared start gate that `POST /sessions` and the phone row both call. The phone row
fails with the same sentence.

The review also notes that `kill.resume()` runs before `deps.start` can throw, so a refused start
from the phone lifts Stop all (`leftovers-L4i.json`, the review notes for l4-starts-carried).

### 5.4 The identity of an install on GitHub

What exists:
- Install id: the desktop device row (`remote/presence.ts` `registerDesktopDevice` :54-91).
  - It is stable across restarts through the identity file under the config dir (:36-51).
  - It is registered whenever services run (compose.ts:6017-6038), on every store, SQLite
    included.
  - It is exposed as `rt.remote.device?.id` (e.g. server.ts:2787).
- GitHub login: `whoAmI()`, read only in `readRepository` (repository-use.ts:536-541) and the
  watcher's `selfLogin` (githost-watcher.ts:639). Nothing stores it except
  `settings.together.login`.
- Agent name: the first principal, default `"Alice"` (compose.ts:1749-1757, `FORERUNNER_AGENT_NAME`
  or `identity.agentName`). Setup has no agent-name step.
- Commit author: `"<agent name> (Forerunner)"` with `human.email || "forerunner@localhost"`
  (compose.ts:2710-2715). The PR executor, docs and intake all use it (:2746-3188).

Risky:
- Two people who keep the default both commit as "Alice (Forerunner)" (collab-shared-repo,
  brief §5.4).
- The install id is a store row id. It is fine as a writer key, but it is not a secret, and the
  file's `publicKey` must never go to GitHub.

---

## 6. Tests and bench pieces for two homes

What exists:
- `packages/runtime/test/onerepo-together.test.ts` (326 lines):
  - Case 1, :25-216: two composed homes (`home-a` / `home-b`) on one `MemoryGitHost`, with a bare
    git repository and a `SimulatedClock`. It covers B's 409 offer, Take it over refused, and Work
    together (201, same id, marker name). `nothingWritten` checks branches, pull requests,
    comments and marker. Each lists only its own pull requests. It covers the B Overview line, B's
    status kept in the app with the status pull request on, and the Docs rows. B is composed again
    (a restart) and the same holds.
  - Case 2, :218ff: L4-github-105, the daemon clock stamp.
  - Gaps:
    - B never runs a task or opens a pull request;
    - both identities use `agentName: "Alice"` (:55);
    - Bob's host is an `Object.create` view whose writes carry Alice's login (§2.3);
    - nothing goes through the UI client (validation rule 1 asks for the person's boundary).
- `apps/ui/test/real-daemon.test.ts` drives the UI client against a real daemon:
  - OR-06 offer and activity :18009ff;
  - two unknown ids :18103ff;
  - import and Sources :18200ff;
  - Try again with the Sandbox scaffold pull request :30240-30300.
  Each is one home.
- `apps/ui/test/onerepo-link.test.tsx`, `settings-all.test.tsx`, `contracts.test.ts` and
  `fake-daemon.ts` (:2351, :2402) mirror the together words in the UI's fake daemon.
- Unit tests: `packages/runtime/test/repository-use.test.ts`; `loop-docs.test.ts:1388-1438`
  (together and `soleLinked` cases of `isProjectDocsPr`, `isProjectStatusPr` and
  `ownsUnmarkedDocs`); `docs-scaffold.test.ts`; `commands/test/onerepo-link.test.ts` and
  `together-settings.test.ts`.
- `testenv/test/githost.test.ts` covers the fake host. `runtime/test/peers.test.ts` covers the
  shared-store peer feed.
- Shared-store era pieces: `tests/e2e/src/scenario-world.ts`,
  `capabilities/test/phase2-gate.integration.test.ts`, `runtime/test/peers.test.ts`. The
  collab-tests.md note says they seed `members` by hand.

Missing:
- `apps/ui/test/two-installs.ts`, the two-homes harness through the UI client named in
  collab-tests.md. Not written.
- A two-home case on the **fake HTTP host** with two users and two tokens.
- A two-home bench (two `start.mjs` homes against one stand-in).
- OJ-11's two-home composed test.
- A restart case for any status-issue state, which does not exist yet.

---

## 7. Root causes the planner can name (summary)

| # | Problem | Root cause (file:line) |
|---|---|---|
| R1 | The scaffold and Try again write into another project's unmarked open `fr/docs-scaffold` pull request (W15-01, never cut). | `isProjectDocsPr` falls back to `soleLinked` (loop/docs.ts:247). `scaffoldBranchFor` returns `fr/docs-scaffold` whenever a pull request is open, without reading the branch's marker (:971 vs :974-978). `ownsUnmarkedDocs` counts taken-over ids as own (:287-291). The same fallback serves status (:267, :1155), `docsInPullRequests` (:1323) and the Pull requests list with Merge (pull-requests.ts:413-415, :512-515). |
| R2 | The phone's plain start skips POST /sessions' refusals (never cut, money). | `refusedStart` answers only for a refused-credential wait (compose.ts:4096-4106). `runStart` goes straight to `scheduler.requestStart` (remote/watcher.ts:792-800), and `kill.resume()` runs first (:792). |
| R3 | No status issue at all. | No issue method is called anywhere. `IssueInfo` / `CommentInfo` lack author, updatedAt, ids (types.ts:83-98). There is no comment edit, pin, ETag or has_issues in GitHost (types.ts:259-398), github.ts, memory.ts or the fake (has_issues fixed true, store.ts:452; no 304). |
| R4 | Two Forerunners plan the same work. | The plan-only block lists this install's task rows only (intake.ts:2145-2151, :2187-2192). The brief has no merged or announced section (task-context.ts:331-443). The pre-claim overlap reads the shared store only (runner.ts:2609-2646, peers.ts:104). |
| R5 | Main moves under you unseen by the plan. | The watcher sees the default head move (githost-watcher.ts:587-620) but records only a copy refresh (compose.ts:2820). No "merged since" is stored or read. |
| R6 | Decision and doc collisions between writers. | `FIRST_DECISION_PATH` is fixed at `0001` (intake.ts:203). The docs branch is keyed by project id (intake.ts:173-183), which a together project shares. |
| R7 | The guide does not exist; `docs/status.md` is still in the doc set. | `STANDARD_DOCS` (memory/src/docs.ts:10-19) has `docs/status.md` and no AGENTS.md or CLAUDE.md. Nothing writes a guide. |
| R8 | The take-over's activity ignores the issue. | `elsewhereOf` reads pull request `updatedAt` and `authorLogin` only, first 100 (repository-use.ts:522-535, :594-616). |
| R9 | Agents and commits do not tell people apart. | The default agent name is "Alice" (compose.ts:1752). The commit author is "<agent> (Forerunner)" (compose.ts:2710-2715). There is no setup step to name the agent. |
| R10 | A second person without push access is not told. | `permissions.push` is mapped (github.ts:1169-1178) but read nowhere in runtime. |
| R11 | Costs reach GitHub through the status file. | The `endedNote` "Spent CHF x" (runner.ts:4167-4170) is written as `- Note:` (memory/src/docs.ts:303) and pushed on `fr/status` when the setting is on (loop/docs.ts:1166-1174). The Projects mirror's `cost` field is a second path (capabilities/githost/projects-mirror.ts:92, :324-327). It is opt-in, behind a card. |
| R12 | `/health` can name the wrong store. | It reads `rt.config?.stateUrl` (server.ts:657), not compose's `stateUrl` (compose.ts:1638-1643). |
| R13 | A flaky UI test sends "human" as the actor (early, wave 8's first group). | `apps/ui/src/pages/UpdatesPage.tsx:136` `me?.id ?? "human"`. |
| R14 | Two-writer tests would lie about authors. | `MemoryGitHost` stamps `this.login` (memory.ts:248). The together test's Bob is an `Object.create` view (onerepo-together.test.ts:39-40). The bench stand-in has one user (scripts/bench/githost-server.ts:30-38). |

## 8. Where the brief no longer matches the code at c15d75e

- §3: "In chat, `project.create` takes `together: true`, read back." **Not built.** Chat answers
  with `CHAT_TOGETHER_HINT` and points to New project (commands project.ts:230-236;
  repository-use.ts:658-675).
- §3, OJ-11, "Work together on its Overview line ... closes the closing project's own status pull
  request": **not built** (leftovers-C4.json, cut line, sent to wave 8). Only the pair rule
  exists (join-preview.ts:203-205).
- §3: "Docs pull requests of a project joined into it (OJ-11) are listed as information only":
  not built.
- §3: "(Today `loop/docs.ts` :170-210 would answer true in all three cases)": this is now fixed.
  `isProjectDocsPr` :223, `isProjectStatusPr` :264 and `ownsUnmarkedDocs` :286 return false for
  together, and `loop-docs.test.ts:1388-1391` pins it.
- §3 and §5.1 cite `pr-executor.ts:512` and `:505-519`. Today `branchSegment` is at :513-520 and
  `taskBranchName` at :529-537.
- §3: `pull-requests.ts :377` is the listing at :376. The task-row match is at :462.
  `githost-watcher.ts ~:211-235` is correct.
- §1 and §3: "fr/status ... the join closes the closing project's own status pull request" is a
  plan, not code. Nothing in the join path calls `updatePullRequest`.
