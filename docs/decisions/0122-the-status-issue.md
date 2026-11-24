# 0122 — The status issue: one pinned issue per project, one comment per Forerunner

Date: 2026-11-24
Status: accepted

## Context

The owner's status design of 2026-11-02, carried word for word (D-W8-2): "GitHub issue page
only: one pinned issue per project ('Forerunner status: <project>', hidden marker), summary
rewritten after each session, 'Working on now' updated when a task starts and ends, each
person/agent/install its own comment edited in place, read when a repository is connected (new or
familiar), before planning and before every task, untrusted text never instructions, author
marked, no costs; stays in the app with one sentence when issues are off / no permission /
offline. No docs/status.md in repositories (remove the untrue template)."

The owner's answer 1 of 2026-11-09 (D9) made the issue the main channel between two people's
Forerunners: "if multiple people will be running it they will be using their own api and
subscription and running it on their pc." and "if 2 people are working on the same project they
should be able to work seamlessly in the same git."

Before this decision a repository project's status went to `docs/status.md` on `fr/status` with
a standing pull request only when the person turned `status_pull_request` on (C-57, ADR 0106
point 3), else it stayed in the app; a together project's always stayed in the app ("Kept in the
app: you work on ... together, so GitHub's copy is left as it is."). So two Forerunners of one
project told each other nothing on GitHub but their pull requests. The status pull request also
took an unmarked status pull request as the project's own when the project was the only one
linked here (the sole-linked fallback), so a project could write into another project's pull
request, and with it on, the session's note ("Ended. Spent CHF 0.09.") reached GitHub (R11).

## Decision

1. **One issue per project, keyed by the project id K** (the marker's `project`). Title
   `Forerunner status: <project>`; the body's first line `<!-- forerunner:status v1 key=K -->`;
   the label `forerunner:status` when the repository allows it. It is found by the stored number,
   then the open issues carrying the marker of K, then the title, each opened by someone with
   write access; the lowest number wins. It is opened by the first Forerunner that starts a task or
   ends a session on the repository, never when a repository is linked and never at the Work
   together press (OR-15). Two opening at once: the higher number is closed by its own writer with
   one line ("Closed: #N is this project's status issue."). It is pinned while fewer than three
   issues are pinned; otherwise it works unpinned and Settings says so. Code:
   `packages/runtime/src/loop/status-board.ts`, `status-board-words.ts`.

2. **One comment per Forerunner, edited in place.** The writer is this runtime's device row (the
   install id) and the token's login; the comment's first line is
   `<!-- forerunner:status-writer v1 key=K writer=W -->` where W is the first 16 hex characters of
   SHA-256 over the device row id and K, never the row id itself (D-W8-35): the hidden markers are
   the one place an id is written. Two installs with one login keep two comments (D-W8-15). The
   header is `**<agent> (Forerunner)** · <login> · updated <time UTC>`, then the sections that
   have lines: Working on now (`- "title" · files x · since 21:00 · until 22:30 UTC`), Waiting for
   Merge (`- #12 "title" · files x`), Paused (what is done and left from the handoff, and whether
   the checks pass on the kept work; a pause that got no further waits for its owner's answer),
   then the Last session line (`Last session (2 Nov 20:59 UTC): did 1 task: "...". Next: "...".`).
   Compose registers the device row whenever the board is wired (`registerDevice`), so a
   `startServices: false` runtime that can reach GitHub has its install id; the cloud runner
   composes it unwired.

3. **No money, email, mention or chat on GitHub.** Every quoted text (a task title, the handoff,
   a Next line, the project's name in the title) passes `redactQuoted`, which removes money
   figures (a number beside CHF, USD, EUR, $, € or £) and email addresses and drops an @mention's
   @, and nothing else ("Fix the cost page" stays). The runner's `endedNote` ("... Spent CHF x.")
   stays the app's (docs/status.md in the app's folder) and is never sent.

4. **Which issue a project writes (D-W8-45).** Only issue K, and only while the default branch's
   `.forerunner/project.json` names K or none. A project whose repository's marker names another
   project and which is not together writes no issue and no comment; its Settings row and Docs
   row say "Status stays in the app: o/kite is the Forerunner project "Kite club"; Work together
   on the Overview shares its status issue." A together project shares K and writes its own
   comment on issue K.

5. **When.** A task's start (it may open the issue), each task boundary (a task that ended leaves
   Working on now), a session's end (it may open the issue; the body is rebuilt), every 30
   minutes while a task runs, and Quit (Working on now cleared, best effort, within 5 s; then
   nothing of the writer runs). Writes coalesce: one pending text per writer and issue, kept in
   this install's data folder beside the app's status (`status-issue.json`, read the same way
   after a restart; no migration), sent once when GitHub answers (a retry after a minute, and
   whenever Settings or the Docs tab asks where the status is). A text whose content is the one
   last sent is not sent again and reads nothing.

6. **The body is a view** rebuilt by any writer, at most once per 30 s, from the comments that
   pass the one writer filter (`writerFilter`, D-W8-37: a valid marker for K, the header naming the
   login that wrote it, and that login's write access read with `getRepoPermission`; a refused
   read counts as none). It quotes each writer's parsed lines, redacted again, between
   `<!-- forerunner:status-quote -->` markers; it never copies a comment whole, and a comment can
   only make Forerunner more careful.

7. **Tamper and loss (W8-write-8).** This writer's comment is known by its stored id, its login and
   its writer key; a comment by another login carrying this writer key is that login's and is
   never edited. GitHub's REST comment names no editor, so an edit by anyone is found by comparing
   the comment's body with the text this writer last sent; the person is told once (an Update) and
   the comment gets this writer's text again. A deleted comment is written again; a closed issue
   is never reopened ("The status issue #12 was closed on GitHub; reopen it there to use it
   again."); a deleted issue gets one new issue and the person is told once.

8. **When GitHub cannot be written (W8-write-7)**, the status stays in the app with one sentence in
   Settings and the Docs tab: "Status stays in the app: issues are turned off on owner/repo.",
   "Status stays in the app: Forerunner may not write issues on owner/repo (the GitHub key needs
   Issues: read and write).", "Status on GitHub: last updated 14:05; it updates when GitHub
   answers." Otherwise Settings says "Status on GitHub: issue #12 (pinned)" and the Docs tab "In
   the app; also on GitHub: issue #12".

9. **The switch (W8-write-10; D-W8-13, owner question 7 of 2026-11-02, decided by the session lead
   from the brief's proposal; the owner can overrule).** Not locked; on by default with a
   per-project switch, Settings' "Status issue on GitHub" (`settings.set status_issue`; one place:
   `statusIssuePolicy`). Off, this install writes no issue and no comment for the project and its
   status stays in the app ("Status stays in the app: the status issue is turned off for "Team
   site" in Settings."). On a public repository Settings adds "Everyone who can see this repository
   can read it." The status issue's state (on, switched off, issues off) is one of the guide's
   facts (D-W8-44), never its number; a change of it gives one docs pull request.

10. **The status pull request goes (amendment 2).** `fr/status`, the `status_pull_request`
    setting, its Settings row, the held mark and the together "Kept in the app" note are removed;
    `statusInApp` stays as the app's status writer and keeps this computer's copy of the
    repository current at each session's end. An open status pull request an earlier version of
    this install opened for the project (its mark and a `docs.status_written` record of one of the
    project's sessions) is closed by this install with one line, at its first status write
    (`closeOwnStatusPullRequest`, also the one GitHub write w8-together's join makes); one of
    another project, an unmarked one or one without this install's record is never touched.
    U-087 is closed as superseded.

## Consequences

- Two Forerunners of one project see each other's work on GitHub: the issue's comments and their
  pull requests. w8-status-read reads the comments with `parseWriterComment` and the same writer
  filter before planning and before every task; w8-github-feed shows them.
- The Projects mirror's cost field is a separate path and is dropped by the owner's question 7
  default; see the area's report for where it stands.
- A pair of projects made here before the one-repository rule writes one issue each while the
  repository's marker names neither (the cut line of W8-write-9); a join leaves one.
- The cloud runner writes no status comment yet (its runner row would be its writer).

Supersedes ADR 0106's status part (point 3, C-57's status pull request) and C-57's setting;
amends 0117 (the status issue across Forerunners).

## Amendment 2026-11-24: the start sends what waited; a 404 is read again (fixup-w8-status-write)

Point 5's "sent once when GitHub answers" held only while the daemon ran: a text Quit or a lost
connection left waiting was sent at a restart only when a screen asked. The daemon's start now
sends it (`StatusBoard.resumeAll`, called by compose once the device row is registered; GitHub
still out, the minute's retry sends it later). The start and Quit's clear belong to the install's
daemon only (`ComposeOptions.statusDaemon`, default the daemon): an `fr` one-shot composed beside a
running daemon neither sends nor clears, so it never takes the daemon's live Working on now lines
off GitHub.

GitHub answers 404 for a deleted comment or issue and for a private repository the token no longer
sees alike. The writer reads again with the same host before it writes again: the repository not
readable, or everything readable while the write was refused, says the no-permission sentence and
sets no timer (the next task, session or screen tries again); the stored issue or this writer's
comment gone means one more write at once (the comment written again, a deleted issue by point 8's
rule); it never opens a second issue or comment because an edit answered 404.

A project whose docs the other Forerunner keeps (together) shows "The other Forerunner keeps these
docs on GitHub; this project keeps only its status." above its Docs rows (W8a-left-4).
