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
   record, else a new `<day>-project-decisions.md`; the card names that file. Two Forerunners'
   decision files never collide by number.
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
   without Merge: "#N names no project, so it is only listed here: open it on GitHub to see
   whose it is." The sole-linked fallback stays only for the status writer (w8-status-write).

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
