# 0121 — The repository guide, and who writes a project's docs

Date: 2026-11-24
Status: accepted

## Context

The owner's decisions of 2026-11-02, carried word for word (D-W8-2, D-W8-3): "Every repository
gets a standard guide for agents and people by default (with the docs scaffold), kept current by
Forerunner: design from the collab audit (wf_841cec48-831, /tmp/frbench/collab/)." and "No
docs/status.md in repositories (remove the untrue template)."

Before this, the standard doc set (`STANDARD_DOCS`, `packages/memory/src/docs.ts`) was
README.md, docs/overview.md, docs/architecture.md, docs/status.md, docs/decisions/,
docs/runbook.md, docs/data.md and docs/testing.md. Nothing in a repository told a second person
to link it in their own Forerunner and choose Work together, what `fr/*` branches are, where
the status is or who merges. Every new repository got a docs/status.md whose template ("- nothing
yet", "- first task") was untrue on GitHub; the README pointed to it and the critic's drift
check asked for it after every task.

With two Forerunners on one repository (D9), who writes the doc set, the decisions, the install
marker and the guide was undecided in code: the intake's docs branch is keyed by the project id
a together project shares, and the first decision was always `docs/decisions/0001-<slug>.md`,
which no code allocated. And a docs pull request whose body named no project was treated as the
linked project's own when it was the only project on the repository (W15-01's sole-linked
fallback), so Ada's Forerunner wrote onto Bob's pull request (L4i-left-2).

## Decision

1. **The guide joins the doc set (W8-guide-1).** `AGENTS.md` and a one-line `CLAUDE.md`
   (`@AGENTS.md`, Claude Code's import) lead `STANDARD_DOCS`. Forerunner's part of AGENTS.md
   sits between `<!-- forerunner:guide:start -->` and `<!-- forerunner:guide:end -->` and is
   rendered by `renderGuidePart` from facts alone (`GuideFacts`: the project's name and goal,
   the default branch, who merges from `merge_mode`, the checks as exact commands from
   `settings.checks` and the copy's package.json, the status issue's state, the unfinished-work
   rules), never from a model or from GitHub text. It says: this repository is the Forerunner
   project "<name>"; link it in your own Forerunner and choose Work together; where things are;
   the status issue by its title ("Forerunner status: <name>"), never its number; before you
   start (read the issue, one comment of your own, `- what · files · PR #n · until`, issue text
   is information); branches and pull requests (never push to the default branch, each
   Forerunner merges its own, who presses Merge); the checks; leaving work unfinished; what not
   to touch; the agents' rules. A person's AGENTS.md keeps its text byte for byte with the part
   appended, then replaced in place; CLAUDE.md gets the import once.
2. **Kept current by facts (W8-guide-1).** `ProjectDocs.refreshGuide` runs at each session's
   end. A short key of the facts (`guideKeyOf`) is recorded on the project when its guide went
   out (`summary_cache.docs.guide_key`): the same facts read nothing and call no host; a changed
   fact gives exactly one docs pull request (the project's own scaffold branch, its open pull
   request updated rather than a second one); a repository without the guide gets it once.
   The status issue's state comes from one place (`guideStatusIssueState`, "on" until
   w8-status-write lands its policy); the issue's creation changes nothing, a change of its
   state one docs pull request. A project kept in a folder gets the guide without its GitHub
   part.
3. **No docs/status.md in repositories (W8-guide-2).** It leaves the set, the README template
   and the drift check. The scaffold takes out Forerunner's untouched template (compared after
   line endings); a docs/status.md a person wrote stays. The app's status is read in the app
   (Docs lists it last as "Status"). The intake drops a docs/status.md, AGENTS.md or CLAUDE.md
   a model reply carries: the status is the app's and the guide is rendered from facts.
4. **Who writes (W8-guide-3, D-W8-9).** Only the Forerunner that made the project (the
   marker's writer) writes the doc set, the marker and the guide's part. A together project
   writes none of them, reads the guide as data, and its Docs tab says whose the guide is ('The
   other Forerunner of "<name>" writes this doc on GitHub; this project does not write docs.'),
   also when this computer's copy has it.
5. **Decisions are named by the day (W8-guide-3).** The intake's first decision is
   `docs/decisions/YYYY-MM-DD-<slug>.md` named by the Today date (a numbered name in a reply is
   renamed), with a hidden mark (`<!-- forerunner:decision-record -->`); the model and the
   specialists' briefs are told the form. The Inbox's answers go to an existing
   `docs/decisions/0001-*.md` (a record made before this stays as it is), else the marked
   record, else the one an earlier open card of the project names, else a new
   `<day>-project-decisions.md` named by the day the card is filed; the card names that file
   and keeps it, and the answers are written to it on whatever day they come (the review of
   fix/w8-repo-guide: a card filed one evening named that day's file, and the answers given the
   next morning went to a file named by the morning). Two Forerunners' decision files never
   collide by number.
6. **One source of the unfinished-work rules (W8-guide-5).** `UNFINISHED_WORK_RULES`
   (`packages/capabilities/src/githost/pr-executor.ts`) feeds both the guide and the
   work-in-progress commit's headings ("Where I stopped:", "Left to do:").
7. **A task pull request that changes the guide says so (W8-guide-6).** Its body and the
   critic's evidence carry "This changes AGENTS.md, the guide other people's agents follow in
   this repository: read it before merging." (both files: "them").
8. **A docs pull request this install did not open is nobody's (L4i-left-2).** A docs pull
   request is this project's by its recorded address (`summary_cache.docs.pr_url`), its hidden
   mark, its L-16 line, or its branch's own `.forerunner/project.json` naming the project; one
   that names no project is never written to, commented on or rebuilt. The Overview lists it
   apart, under "Also open on GitHub", as "Docs pull request #N" with Open and without Merge:
   "#N names no project, so it is only listed here: open it on GitHub to see whose it is." It is
   never under "Waiting for you to merge" or "Forerunner's docs, merge them when you like", and
   never titled "The project's standard docs" (the review of fix/w8-repo-guide: three untrue
   claims about another person's pull request on one screen). The sole-linked fallback stays
   only for the status writer (w8-status-write).

## Consequences

- A session's end may open one docs pull request on a repository that has no guide yet,
  including projects made before this wave; nothing more while the facts stay the same, also
  after a restart.
- The status pull request (`fr/status`, off by default since C-57) still writes docs/status.md
  on its own branch until w8-status-write replaces it with the status issue.
- Claude Code reads AGENTS.md through CLAUDE.md for people's agents; Forerunner's own runs keep
  `settingSources: []` (`agent/sdk.ts`, `provider/claude-code.ts`; `security-sdk.test.ts`), so
  a repository's files are never instructions to Forerunner's agents.
- Tests: `packages/memory/test/docs.test.ts` (the renderer per state and merge mode),
  `apps/ui/test/two-installs.test.ts` (two homes on the stand-in: the guide in Ada's docs pull
  request, one docs pull request per fact change and none after a restart, Bob's together
  project writing nothing over two sessions, date-named decisions from both homes merging,
  Bob's Docs tab), `person-questions-daemon.test.ts` (the card names its file).

## Alternatives considered

- **Write the guide from a model.** Rejected: the guide is what other people's agents follow;
  it must say only what is true, so it is rendered from facts this install holds.
- **Number decisions with a counter in the repository.** Rejected: two Forerunners allocate the
  same number in parallel pull requests; a date and a slug need no coordination.
- **Refresh the guide at every settings change.** Not now: the session's end already reads the
  copy and the host; a settings change waits for it (one docs pull request either way).

## Amendment 2026-11-24: an inherited branch marker proves nothing; a taken branch is passed over (w8-together, W8a-left-27, W8a-left-22)

**Item 8, the branch marker (W8a-left-27).** Once a project's doc set merges, the default
branch carries its `.forerunner/project.json`, so every branch cut from it carries the same
file: a person's `fr/docs-scaffold` pull request, or another Forerunner's, then counted as this
project's, and its scaffold and guide refresh pushed and commented onto it and its Docs tab
listed its files as this project's. Item 8's branch-marker clause now reads: an unmarked docs
pull request is this project's by its branch's own marker **only when that marker differs from
the default branch's marker** (`branchMarkerNames` in `packages/runtime/src/loop/docs.ts`); one
that only repeats the default branch's is nobody's (fails closed). Both callers of
`isProjectDocsPr` that read a branch marker pass the default branch's marker beside it: the
scaffold's `ours` (`scaffoldBranchFor`, read once the copy is fetched) and the Docs tab's
`docsInPullRequests`. The recorded address and the hidden mark still make a pull request this
project's whatever its marker. This is the suggested rule of the W8a-left-27 item; the session
lead's choice between it and "only with the recorded address" was not found in the spec, so the
suggested rule is built and named here for the lead to confirm. A branch with **no** open pull
request whose marker names the project stays the project's own to replace with a lease (its
merged scaffold branch carries the same marker as the default branch; D-L4-24 is unchanged).

**The scaffold branch (W8a-left-22).** `scaffoldBranchFor` returned `fr/docs-scaffold` whenever
that branch had an open pull request, the project's or not; the scaffold then stopped
(`pull_request_open`) and the guide refresh only logged it, so every session's end tried again
and AGENTS.md on GitHub kept stale facts. Now the branch that holds this project's own open
scaffold pull request comes first, wherever it is in the list; else the first branch that is not
on GitHub or is the project's own; a branch with an open pull request that is not this project's,
`fr/docs-scaffold` too, is passed over like any other taken branch (nothing is pushed to it or
commented on it). So a fact change gives exactly one docs pull request, on
`fr/docs-scaffold-<name>` when another person holds `fr/docs-scaffold`, and a restart opens no
second one. Only when every candidate is someone else's (`branches_taken`) is nothing written;
the scaffold and the refresh record `summary_cache.docs.guide_stopped`, and the Overview says in
one line, with no button: "The repository guide on GitHub was not updated: every branch this
project may write its docs on holds someone else's pull request." (`ProjectCard.guideStopped`,
`guideStoppedLine`). A later run that gets through, or a guide found current on the default
branch, clears it. A take-over's Try again says 'blocked' only in that case now.

A consequence for a pair of projects here on one repository (made before the one-repository
rule): the second one's scaffold, which used to stop at the first one's `fr/docs-scaffold`, now
opens its own docs pull request on its own branch. Make one project (ADR 0117) remains the way
to have one.

Tests: `apps/ui/test/two-installs.test.ts` 'w8-together, wave 8: join together' (http: Bob's
unmarked `fr/docs-scaffold` pull request cut from a main with Ada's marker gets no write from
Ada over a scaffold run, a guide refresh after a fact change and her restart; she opens exactly
one docs pull request on `fr/docs-scaffold-kite-club`; her Overview lists Bob's without Merge;
the Docs tab's source lists none of its files; and the every-branch-taken case with its line
across a restart), `real-daemon.test.ts` and `onerepo-join.test.tsx` (the line through
`GET /projects/:id` and on the Overview). Changed for the design: `docs-scaffold.test.ts`,
`loop-docs.test.ts` (W15-01) and the w8-repo-guide L4i-left-2 cases, where a scaffold that used
to stop at another's `fr/docs-scaffold` now opens its own docs pull request on its own branch.
