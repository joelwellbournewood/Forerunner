# 0069 — GitHub repository import: the worktree layout, the migration branch rule and the token path

Date: 2026-10-23
Status: accepted

## Context

Spec A.3: "Import from ZIP, local folder, or existing GitHub repo. Original is preserved
untouched; migration runs on a branch." ZIP and folder import were built in phase 5
(`packages/runtime/src/data/import.ts`); the GitHub clause was open
(`docs/status/BLOCKERS.md`). The stand-in was the project's `repos` link plus the PR executor:
every code change goes through a branch and a PR, so the original is never written directly,
but nothing cloned a repository for a project and nothing opened the branch the migration
runs on. Four points needed deciding: where the checkout lives, how the branch is named and
kept, how a token reaches git, and what the import records.

## Decision

1. **The checkout lives beside the project's data, under the install's data dir.**
   `DataImporter.importGitHubRepo()` clones into
   `<projectsRoot>/<project id>/repos/<owner>/<name>` (`DataAssets.projectReposDir()`;
   `projectsRoot` is `<data>/projects`, `FORERUNNER_HOME` honoured), two `safeSegment()`
   levels so `a-b/c` and `a/b-c` never collide. It is not under the data dir
   (`<projectsRoot>/<id>/data`) so the gitignore guard and the "nothing under the data dir is
   a worktree" rule stay true, and not under `appDirs().worktrees`, which holds the per-task
   worktrees the PR executor clones fresh. One checkout per `owner/name` and project: a
   re-import first reads the checkout's `origin` URL and refuses (`validation`, the URL shown
   without userinfo) when it names another repository, so the same slug on another host never
   reuses, fetches or reports somebody else's checkout. A fresh clone that does not reach the
   migration branch (a checkout git refused, an empty repository, a clone killed at the time
   limit) is removed whole; a checkout that was already there is kept as it was.
2. **The migration branch is `forerunner/migration-<YYYY-MM-DD>` from the Clock, and it is
   kept.** A first import creates it from `origin/<default branch>` (the default branch as the
   clone recorded it in `refs/remotes/origin/HEAD`; an empty repository is `validation`). A
   later import of the same repository into the same project fetches, keeps the worktree and
   stays on the migration branch the checkout sits on (or checks out the newest
   `forerunner/migration-*` branch it finds) with every commit made on it; it never resets, never
   creates a second branch per day, and never writes a second asset row or `repos` entry. The
   import checks out the default branch under no circumstance, commits nothing and pushes
   nothing: after it, the code asserts the checkout is on the migration branch and not on the
   default one (`internal` otherwise). Pushing the branch and opening the PR stay with the PR
   executor (F.5), which is what later turns the migration into a reviewable change.
3. **The token goes by reference and reaches git through the environment.** The request names
   `tokenRef: secret:<name>` (or nothing, in which case the daemon's own
   `secret:github_token` from setup is used when the vault holds it **and the clone URL is on
   the git remote base's origin**, `https://github.com` unless composed otherwise; any other
   origin, and an install without the secret, clone anonymously, so a request naming some
   other server never receives the install's token). A reference the human names explicitly
   is used for whatever host the URL names. The value is resolved by `resolveSecretRefs` with
   that one name granted, at call time, and handed to `GitOps` with the repository's origin,
   which passes it as `http.<origin>/.extraheader` through `GIT_CONFIG_COUNT` /
   `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (git 2.31+) instead of a `-c` argument: a process
   listing never shows it, git never writes it into the clone's config, and git attaches it to
   URLs under that origin only, so a `url.*.insteadOf` rewrite in the user's git config or a
   remote on another host reaches that host without it. A clone URL with userinfo is refused
   (`validation`); so is any non-http(s) scheme. The audit row, the log line and the result
   carry the reference, never the value.
5. **A repository's content is data, and the import is bounded.** git itself refuses to check
   out a tree with `..` or `.git` entries (the import fails `provider_error` and the clone is
   removed) and never writes through a symlink; the walk, the folder asset and the sample skip
   symlinks (where the OS has none, git writes the link text as a plain file). Every git
   command runs under `DataImporterDeps.gitTimeoutMs` (default 10 minutes) through the
   platform runner, which kills the process at the limit and returns then, even while git's
   remote helper still holds the pipes; the import is `timeout` and a fresh clone is removed.
   The walk's entry, byte and depth limits bound what is listed, not what git downloads: a
   repository's size on disk is bounded by the time limit only.
4. **One folder asset and one `repos` entry record the import.** The checkout is registered
   as a `folder` data asset (`storage: linked`, locator the worktree, name `owner/name`) so the
   Data tab, `data_list`, `data_describe` and `data_sample` see the repository's files like a
   linked folder; the file list in the result comes from the same bounded walk (the clone's
   own `.git` left out). The project's `repos` list gains `owner/name`, the form
   `compose.ts`'s `repoFor` reads for the PR executor, once. A `github` import answers on the
   same route as the other kinds (`POST /projects/:id/data/import` with `source: "github"`,
   `path|locator` an `owner/name` or an http(s) URL, `tokenRef?`), and `ImportResultView` gains
   `repository` (slug, url, worktree, branch, default branch, head, asset id, reused), null
   for zip and folder.

## Consequences

- A.3 closes with `packages/runtime/test/data-import-github.test.ts` (against the fake git
  host over git smart HTTP; skipped with the reason when `git http-backend` is missing: the
  clone, the branch, the untouched default branch, the token on no surface, the idempotent
  re-import, the token origin rule including an `insteadOf` rewrite, the origin-mismatch
  refusal, a hostile tree, symlinks, an empty repository and a clone that never answers),
  `data-routes.test.ts` (the body and the dispatch), `data-wiring.test.ts` (the daemon route
  with the install's own reference), `packages/capabilities/test/git.test.ts` (the token on
  the environment, never on the command line, scoped to the origin; `timeout`; the
  default-branch, remote-URL and branch-listing helpers) and
  `packages/platform/test/shell.test.ts` (the runner back at the limit while a grandchild
  holds the pipes).
- `GitOps` behaves the same for the PR executor: the header moved from argv to env, and
  without `auth.origin` it still applies to every http(s) remote. Git older than 2.31 ignores
  `GIT_CONFIG_*` and would clone anonymously; Git for Windows and every supported Linux
  distribution ship newer.
- `@forerunner/platform`'s `run()` now resolves at a killed child's `exit` instead of `close`
  (`platform-notes.md`): before, a clone whose remote helper outlived the killed `git` held
  every caller of `run()` for as long as the helper lived, so no time limit on a process held.
- A user who wants the migration on the remote runs a task: the PR executor clones its own
  per-task worktree from the same remote and branches from the base; the import's checkout is
  the project's reference copy on the migration branch, not the task worktree. Making the PR
  executor reuse the import checkout is a later change (noted in `data.md` Known issues).
- `owner/name` resolves against `DataImporterDeps.gitRemoteBase` (default
  `https://github.com`; `ComposeOptions.data.gitRemoteBase` in the daemon); another host is
  reached by a full URL with an explicit `tokenRef` when it is private. Nothing is hardcoded
  to an org or account.

## Alternatives considered

- **Clone into `appDirs().worktrees` next to the task worktrees.** Those are per task and
  disposable; the import's checkout is per project and meant to stay, and the sandbox's
  allowed paths list the worktrees root for runs, which should not silently cover it.
- **Push the migration branch during the import.** The spec says the migration runs on a
  branch, not that the import publishes it; a push needs write access the token may not have,
  and the PR executor is the one path that pushes and opens PRs (F.5). Pushing nothing keeps
  "the original untouched" a property of the import alone.
- **A new migration branch per import (per date).** A second import would strand the earlier
  commits; keeping the branch found is what makes a re-import idempotent.
- **Register every file as its own asset, like a folder import.** Thousands of rows for a
  repository, and no row to reuse on a re-import; one folder row gives the same tab and tool
  view with the folder sample and the extension histogram.
- **Keep the token on `-c http.extraheader=`.** It was on the command line of every git
  process, visible in a process listing for the clone's whole duration.
- **Send the install's default token to any URL the request names.** Simpler, but a request
  naming another server would receive the human's GitHub token in its Authorization header.
- **Accept a token inside the clone URL.** git stores the remote URL in `.git/config`, which
  would put the value on disk and into every later `git remote -v`.
- **Key the checkout on host, owner and name.** It would let one project hold the same slug
  from two hosts, but the project's `repos` list (what the PR executor reads) is `owner/name`
  without a host, so the two would be indistinguishable there; one checkout per slug and a
  loud refusal is the honest shape until `repos` carries hosts.
- **Bound the clone's size with a partial clone (`--filter=blob:limit`).** The checkout
  fetches the filtered blobs lazily anyway, so the limit would not hold; the time limit is
  the bound that does.
