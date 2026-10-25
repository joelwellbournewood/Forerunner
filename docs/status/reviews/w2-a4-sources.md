# w2-a4-sources

Item: source discovery (spec A.4): connect GitHub orgs, accounts, repositories and local
folders; scan, propose one project per repository or folder, detect an existing install, never
duplicate; add, rescan, remove. Built on `wave/w2-a4-sources`, merged in `1d849c8` (5 commits,
40 files) without a review; ADR 0056, migration 0003.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-25. Reviewed the item's changes
as they stand on the integration branch `ccr-af5a431d-jc9xqj` at `894b76d` (the code moved
since the merge: the A.3 import with its token-origin rule, the intake of ADR 0055, the docs
scaffold of ADR 0058). Read the brief, ADR 0056, the sources sections of runtime.md,
capabilities.md, apps.md, migrations.md and data-model.md, then traced `src/sources/*`,
`daemon/compose.ts` (the `SourceDiscovery` wiring, `repoFor`), `daemon/create-project.ts`,
`daemon/server.ts`, `cli/main.ts`, `githost/github.ts` (`paged`, `listRepos`),
`state/migrations/0003-sources.ts`, `repos/misc.ts` and `apps/ui/src/pages/SourcesSection.tsx`.
Ran the item's tests (`sources`, `sources-routes`, `sources-cli`, `github`: 18 passed),
`pnpm docs:schema` (data-model.md unchanged, so the generated doc is current), and two
throwaway tests (deleted afterwards) for the findings marked "verified with a throwaway test".

**Verdict: revise.** Score: 70/100. The item does what the brief asks on the happy path and
with care: kinds, one key per repository whatever its spelling, candidates as rows with the
envelope, idempotent rescans (gone and back), accept through the dashboard's
`createProjectRecord`, remove in one transaction that never touches a project, the owner rule,
references never values (a pasted token is refused without being echoed and no test fixture
names a real org or host). The pagination test is real (the fake host sees two pages) and the
tests notice when the duplicate rule or the gone rule is broken. What is wrong: the new
pagination sends the GitHub token to whatever origin the host names in `Link` (against the
token-origin rule the A.3 item set), a repository URL on another git host is accepted as a
GitHub repository, nothing bounds a scan's candidate count (and so its host calls), and the
install marker the detection relies on is never written by anything, so for repositories the
detection only ever fires on hand-marked ones.

### Requirements checked

- [x] A.4 "connects any sources (GitHub orgs or accounts, chosen repos, local folders; other
  git hosts later)": `add` with the four kinds; `gitlab` and `git_remote` refused with
  `not_supported` "come later" (`sources.test.ts`, the routes test).
- [x] "A scan lists what is there": org through `listRepos({ org })` paged; account through
  the token's own listing or `listRepos({ user })`; a chosen repository through `getRepo`; a
  folder's immediate subfolders (symlinks and dot-folders skipped) or the folder itself when
  it is a repository. Rate limits: the adapter waits once for the reset (bounded by
  `maxRateLimitWaitSec`) and then fails the scan, which is recorded on the source and
  rethrown (503); nothing half-written.
- [x] "proposes a project for each repo or folder": one candidate per key, `proposed_name`
  qualified when the name is taken; the human's accept is the only path to a project (no
  auto-creation anywhere; `accept` re-checks the projects at that moment).
- [~] "detects an existing Forerunner install": the install record (this checkout) and the
  `.forerunner/project.json` marker are read; nothing writes the marker (finding 4).
- [x] "never creates duplicates": `keysOfProject` reads a project's `repos` in every spelling
  (URL, `.git`, scp, ssh, `github.com/…`); a repository proposed by another source is
  `duplicate` of that proposal; `accept` turns the same key in other sources `duplicate`.
  Partly over-eager: a URL on another git host maps to a GitHub key (finding 2).
- [x] "added, rescanned or removed at any time": routes, `fr sources`, the Settings section
  with a confirmation that says projects stay.
- [x] Brief: `createProjectRecord` is the one function behind `POST /projects` and an accept
  (stage, members, event, active project; no brief, no intake; the composed-daemon test shows
  the card).
- [x] Brief: `PrTaskExecutor.repoFor` returns null for an absolute `repos[0]`; `parseRepoRef`
  (docs scaffold, ADR 0058) returns null for an absolute path too, and `ProjectDocs` reads a
  folder project's docs from that folder (no semantic conflict with the later merges; the A.3
  import resolves `owner/name` against `gitRemoteBase`, the same spelling an accept stores).
- [x] Secrets: a token value never reaches a row, a log, an audit row or a response
  (`credentialLength` only); the host is built from the vault at scan time; the scan error is
  redacted. Token destination: finding 1.
- [x] Time through the clock; paths through the platform; `ForerunnerError` codes
  everywhere but the CLI's kind check (finding 6); nothing hardcoded to an org, account or
  host (the default reference `secret:github_token` is the name `fr setup` stores).
- [x] Content from the scan: names and locators are rendered as React text and never fed to
  a model by this item; no README or description is read.
- [x] Docs agree with the code (runtime.md, capabilities.md, apps.md, migrations.md, ADR
  0056), the generated data-model.md is current, migration 0003 is frozen DDL proven equal to
  the generator's output and a v2 database migrates forward with its rows.

### Findings

1. **medium**: `packages/capabilities/src/githost/github.ts:145` (`request`: `path.startsWith("http") ? path : …`) and `:228-242` (`paged`). The listing follows the `next` URL of the host's `Link` header with the adapter's headers, the bearer token included, whatever origin that URL names. The header is data the host answers; a GHES behind a proxy that emits its internal hostname, or any misbehaving host, receives the token on another origin. The A.3 item set the opposite rule for the same token (`tokenHeaderKey` scopes it to one origin, `pickTokenRef` refuses another origin). Verified with a throwaway test: a stub API host whose page 1 names a second listener in `Link`; the second listener received `Authorization: Bearer tok-secret`. Smallest fix: `request` refuses an absolute URL whose origin is not `baseUrl`'s (`provider_error`, nothing sent); `uploadReleaseAsset` opts in explicitly for the host's upload origin (GitHub's `uploads.github.com`), which is the one place the API hands out another origin by design. Test: a `Link` to another origin stops the listing with `provider_error` and the other origin sees no request.

2. **medium**: `packages/runtime/src/sources/locators.ts:44-66` (`parseRepoLocator`) and `:79-92` (`keysOfProject`), reached from `discovery.ts:330` (`add`) and `:496` (the duplicate check). A URL or scp locator is accepted whatever host it names: `https://gitlab.com/acme/alpha` and `git@gitlab.com:acme/alpha.git` become the GitHub source `acme/alpha`, which the scan then reads from the install's GitHub host and proposes as a project, a repository the human never named (and, when the name is squatted, someone else's). The same parser gives a project linked to `https://gitlab.com/acme/alpha` the key `github:acme/alpha`, so the GitHub `acme/alpha` is a false duplicate. Verified with a throwaway test: `add({ kind: "github_repo", locator: "https://gitlab.com/acme/alpha" })` answered `locator: "acme/alpha"` and the scan proposed it; `keysOfProject(["https://gitlab.com/acme/alpha"])` gave `["github:acme/alpha"]`. Smallest fix: the parser takes the hosts a URL may name (default `github.com`; the daemon adds the host of `githubApiBase` and of `gitRemoteBase`), refuses a URL on another host at `add` with `validation` ("other git hosts come later") and skips it in `keysOfProject`; a bare `owner/name` stays as it is. Test: the GitLab forms refused and not keyed; a GHES host accepted when configured.

3. **medium**: `packages/runtime/src/sources/discovery.ts:546-568` (`repoCandidates`: one `getFile` per repository) and `:582-593` (`folderCandidates`). Nothing bounds how many candidates one scan produces. An organisation of 10,000 repositories (the listing's own cap, `MAX_LIST_PAGES`) costs 100 list calls and then 10,000 `contents` calls for the marker against a 5,000-per-hour PAT budget: the scan spends the hour's budget, waits for the reset, fails with `provider_rate_limit` and stores nothing, and the next scan repeats it. A folder with tens of thousands of subfolders becomes as many candidate rows (two `lstat`s and several queries each) while the route blocks. `MAX_PROJECTS` bounds the duplicate check; the candidates have no bound. Verified by reading the code (no limit, no option; the marker call is inside the per-repository loop). Smallest fix: `maxCandidates` (default 1,000) checked right after the listing and before any per-candidate host call or row; beyond it the scan is refused with `validation` naming the count and the bound (recorded on the source like any failed scan, 400 on the route) and the message says to connect narrower sources (a repository, a subfolder). Test: a folder of four subfolders with a bound of three refuses and with four passes; an org over the bound makes no `getFile` call.

4. **medium**: `packages/runtime/src/sources/discovery.ts:107` (`INSTALL_MARKER_FILE`) with ADR 0056 point 4 ("no code writes it yet"). The requirement sentence "detects an existing Forerunner install" is met for this install's own checkout (the install record) and for hand-marked repositories only: `grep -rn "\.forerunner/" packages/` finds the reader and the schema comment, nothing else, and the docs scaffold of ADR 0058 (`packages/runtime/src/loop/docs.ts`, the first thing Forerunner writes into a managed repository) writes the doc set without the marker. So two installs managing one repository, the case the sentence is about, goes unnoticed. Verified by reading the code and the scaffold. Smallest correct fix: `scaffoldDocs` adds `.forerunner/project.json` (`{ "schema": 1, "project": <id>, "name": <name> }`) to the same branch and PR as the doc set, and the scan's `repoHasMarker` keeps reading it on the default branch. That writer belongs to the G.5 module, which is under its own review in parallel; not changed here.

5. **low**: `packages/runtime/src/sources/discovery.ts:347-349` and `:370-375` (`add`, `findSame`). The 409 for a source another human of the install connected names that human's row id in `details.id` and says "already connected", while the owner rule hides other humans' sources everywhere else (`list` filters, every other operation answers 403). The `(kind, locator)` unique index of the `source` table (v1 schema) is what makes a second row impossible, so a refusal is right; the id is not. Verified with a throwaway test: Bob's `github_user someone-else`, then Ada's same `add`, rejected with `details.id === bobs.id`. Smallest fix: when the existing row is another human's, the conflict names no id and says another human connected it. Test in `sources.test.ts`.

6. **low**: `packages/runtime/src/sources/cli.ts:80` (`SourceKindSchema.parse(kind)`) and `:122` (`opts.status as SourceCandidateStatus`). `fr sources add bitbucket x` throws a raw `ZodError` (no `ForerunnerError`, no stable code; `sources-cli.test.ts:153` asserts only `toThrow()`), and `fr sources candidates <id> --status nope` passes the value through to the store filter unvalidated and prints "No candidates" where the route answers 400. Verified by reading the code and the test. Smallest fix: both validated with `ForerunnerError("validation")` naming the allowed values; the tests assert the code and the message.

7. **low** (wording): `apps/ui/test/sources.test.tsx:12` says "a token value never leaves the form as a credential" while the test types a token into the reference field, posts it to the daemon and asserts the daemon's refusal (lines 108-113), which is also what apps.md describes. The docblock claims what no test proves. Fix the sentence to what the test shows.

Not findings, checked: two concurrent scans of one source against the SQLite store both complete (the inserts do not collide); the folder scan reads one directory level only, never follows a symlink and refuses a symlinked root at `add`; `parseRepoRef` (docs, executor) returns null for an absolute path, so a folder project runs without the branch-and-PR flow and keeps its docs in the folder; `redact` covers the scan error; the UI escapes every scan string; the CLI test's token value is built from parts so the secret scan does not trip on it.
