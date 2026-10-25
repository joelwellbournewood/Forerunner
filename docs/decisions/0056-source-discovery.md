# 0056 — Source discovery: source kinds, duplicate keys and how an existing install is told

Date: 2026-10-23
Status: accepted

## Context

Spec A.4: the user connects sources (GitHub orgs or accounts, chosen repos, local folders;
other git hosts later), a scan lists what is there, proposes a project for each repo or
folder, detects an existing Forerunner install and never creates duplicates; sources can be
added, rescanned or removed at any time. Before this item repositories were named one by one
(`fr setup --repos`, the New project dialog) and nothing in the code told whether a repository
or folder was already a project, already Forerunner's, or proposed before. The `source` table
existed (kinds `github_org`, `github_user`, `gitlab`, `git_remote`, `local_folder`, a JSON
`scan_result`) but no code wrote it, and a project's `repos` entries come in several spellings
(`owner/name` from the executor's convention, URLs from the dialog, absolute paths).

## Decision

1. **Kinds.** A chosen repository is a source kind of its own, `github_repo`, next to
   `github_org`, `github_user` and `local_folder`; `gitlab` and `git_remote` stay in the enum
   and are refused at `add` with `not_supported` ("come later") rather than removed. A GitHub
   source names its token by vault reference (`credential_ref`, `secret:<name>`, default
   `secret:github_token`, the name `fr setup` stores); a value is refused without being
   echoed. The host is built from the vault at scan time, so the row never holds more than
   a name. A folder source takes no credential.
2. **Candidates are rows.** `source_candidate` (migration 0003) holds one row per repository
   or folder a scan found, with the envelope, keyed by `(source_id, key)`, with `status`
   `proposed | accepted | duplicate | gone`, `existing_install` plus `install_marker`,
   `project_id` and `last_seen_at`. Rows, not entries in `scan_result`, so a rescan can
   upsert and keep ids, an accept can point at its project and the duplicate check can see
   other sources' candidates in one query. `scan_result` keeps the last scan's counts and
   error.
3. **One key per thing.** `github:<owner>/<name>` lower-cased for a repository whatever its
   spelling (`owner/name`, `.git`, `github.com/…`, `https://…/tree/…`, `git@…:…`, `ssh://…`);
   `folder:<normalised absolute path>` (lower-cased on Windows) for a folder. A project's
   `repos` entries are read with the same parser. A candidate is `duplicate` when a project
   covers its key or when another source already has it `proposed` or `accepted`
   (`details.duplicate_of`), so a repository is proposed once across every source; `accept`
   re-checks the projects at that moment and never creates a second project for a key. One
   GitHub host per install today, so the key does not carry the host; the `github:` prefix
   leaves room for `gitlab:` later.
4. **Existing install.** The marker is the file `.forerunner/project.json` at the root
   (default branch for a repository, the file system for a folder), or the folder being the
   checkout this install's `install.json` names (`install_record`). The marker is read only;
   no code writes it yet (the first session on a managed repository is the place to write
   it; until then only hand-marked repositories and this checkout show as installs). A
   marked candidate is still proposed: the mark is information for the human, not a refusal,
   since the project may well belong on this install too.
5. **Rescan semantics.** Upsert by key: new → `proposed` (or `duplicate`), seen again →
   facts and status recomputed with the id kept, not seen → `gone` (back to `proposed` when
   it returns), `accepted` → untouched whatever a later scan finds. A folder that is itself
   a repository, marked, or this checkout is one candidate; otherwise its immediate
   subfolders are (symlinks and dot-folders skipped). A user source lists the token's own
   repositories when the login is the token's (private ones included) and another user's
   public ones otherwise.
6. **Accept creates the project the dashboard's way.** `createProjectRecord` is the one
   function behind `POST /projects` and an accepted proposal, with `repos: [locator]` and no
   brief (intake is spec A.2). A project name that is taken is refused; the proposed name is
   qualified with the owner or parent folder when a project of that name exists. Removing a
   source removes its candidates in one transaction and never a project. Sources belong to
   the human who added them: another human's source is hidden and refused (403 `forbidden`).

## Consequences

- Migration 0003 rebuilds `source` on SQLite (the enum CHECK cannot be altered in place) and
  adds `source_candidate`; the frozen DDL is proven equal to the generator's output.
- The git host port's `listRepos` takes `{ org | user }` and follows pagination, so a scan
  sees an organisation whole; the install check costs one `contents` call per repository.
- A project created from a local folder links the path in `repos`; the PR executor treats an
  absolute path as "no host repository" and runs the inner executor without the
  branch-and-PR flow. Working in that folder as a worktree is a later item.
- The UI's Sources section and `fr sources` share the daemon's `SourceDiscovery`; the UI reads
  the daemon's own zod shapes through `daemon/api-types` (no mirror to drift).

## Alternatives considered

- Keeping candidates inside `source.scan_result` (JSON): no migration for a table, but no
  stable ids across rescans, no envelope on what the human accepts, and the cross-source
  duplicate check would scan every source's JSON. Rejected.
- Storing a chosen repository as `git_remote` with a URL: keeps the enum, but the scan would
  have to guess the host from the URL and the row would carry a second spelling of the same
  thing. A kind of its own is plainer. Rejected.
- Refusing a candidate that carries an install marker: safer against two installs managing
  one repository, but the common case is the same human reconnecting their own projects on a
  new machine. Marked and proposed, with the mark shown, was chosen.
- Checking for an install by looking for the standard doc set (`docs/status.md` and friends,
  spec G.5): those files are what Forerunner writes, but many repositories carry a `docs/`
  folder of their own. A dedicated marker file is unambiguous.

## Amendment (2026-10-25, independent review of w2-a4-sources)

1. **A URL names its host.** Point 3 dropped the host from the key because one GitHub host
   per install is enough; the parser nonetheless accepted a URL on any host, so
   `https://gitlab.com/acme/alpha` became the GitHub source `acme/alpha` (a repository the
   human never named) and a project linked to that URL made the GitHub `acme/alpha` a false
   duplicate. Now `parseRepoLocator` reports the host a URL or scp form names and accepts the
   install's git hosts only (`repoHostsFor`: the host of `githubApiBase` with `api.`
   dropped and of the import's `gitRemoteBase`, `github.com` by default); `add` refuses a URL
   elsewhere with `validation` ("other git hosts come later") and `keysOfProject` gives it no
   key. The key itself still carries no host.
2. **A bound on one scan.** `maxCandidates` (`DEFAULT_MAX_CANDIDATES`, 1,000) repositories
   or subfolders per scan, checked after the listing and before the per-repository marker
   call or any row. A scan beyond it is refused and recorded on the source like any failed
   scan, with the advice to connect narrower sources. An organisation of ten thousand
   repositories would otherwise cost as many `contents` requests against a token budget of
   five thousand an hour, and a folder of as many subfolders as many rows.
3. **The token's destination.** The adapter's pagination followed the `Link: rel="next"`
   URL with the bearer header whatever origin the host named. `GitHubHost.request` now
   refuses an absolute URL off `baseUrl`'s origin (`provider_error`, nothing sent); the
   release upload (`upload_url`, GitHub's `uploads.github.com`) is the one explicit opt-in.
   The same rule the A.3 import applies to git (ADR 0069).
4. **The 409 for another human's source** (one row per kind and locator) names neither the
   row nor the human; before it carried the row id, which the owner rule hides everywhere
   else.
5. **Point 4 stands as a gap.** Nothing writes `.forerunner/project.json`, so for
   repositories the existing-install mark fires on hand-marked ones only; this install's
   checkout is told by the install record. The G.5 docs scaffold (ADR 0058, the first thing
   Forerunner writes into a managed repository) is the place to write it, on the same branch
   and PR as the doc set. Recorded as an open review finding, not changed here.

## Amendment (2026-10-25, review of w2-g5-docs)

Point 5 above is closed: the G.5 docs scaffold writes `.forerunner/project.json`
(`{ "schema": 1, "project": <id>, "name": <name> }`, `packages/runtime/src/sources/marker.ts`)
beside the doc set, on the scaffold's branch and pull request for a repository and in the
workspace without one, and never over another project's marker (ADR 0058, amendment of
2026-10-25, point 3). The scan keeps reading it on the default branch, so a repository shows
as an existing install once that pull request is merged.
