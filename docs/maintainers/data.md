# Files and data

`packages/runtime/src/data`: the Data tab's backend and the data tools (spec L "Files and
data", K "Project page" Data tab, A "Projects and onboarding" ZIP, folder and GitHub
repository import, build order phase 5; the repository import is ADR 0069). Files, folders and datasets are registered by path or URI as `data_asset`
rows; agents see metadata and capped samples, never whole files; large data is linked where
it sits and never copied; ZIP and folder imports are bounded and zip-slip safe; the project
worktree's `.gitignore` is kept covering the data dir.

## Purpose

- Upload a file, link a folder, or register a large dataset by path or URI, per project (L.1).
- Agents get `data_list`, `data_describe`, `data_sample` and `data_register`: metadata
  (format, mime, encoding, columns with inferred types, row counts, image dimensions, folder
  entries) and samples capped at 64 KB and 200 rows. No tool returns a whole file (L.1).
- Large data never goes into git: above the copy threshold (50 MB) a source is linked, never
  copied, and the row carries a note pointing to Git LFS, R2 or S3 (L.1).
- ZIP and folder import with entry, byte and depth limits, absolute-path and traversal
  entries refused, symlinks skipped, the result listing what was imported (A.3, phase 5).
- Import of an existing GitHub repository (A.3, ADR 0069): cloned under the project's repos
  dir onto the migration branch `forerunner/migration-<date>`, the default branch never
  written, the token by secret reference only, a re-import idempotent.
- Removing data needs a human at every autonomy level (S.6); file content is data, not
  instructions (S.2): every tool output is marked untrusted so the hooks wrap and scan it.
- Every registration, upload, import and removal is an `audit_log` row.

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | zod shapes (`DataAssetView`, `DataMetadata`, `DataSample`, `ImportResultView` with `RepositoryImportView`, `StoredAssetInfo`), `IMPORT_SOURCES`, kinds, storage modes, `REMOTE_SCHEMES`, `DataLimits` with `DEFAULT_DATA_LIMITS` and `resolveDataLimits()`, the notes `largeDataNote()`, `truncatedWalkNote()`, `URI_STRIPPED_NOTE` (all ending in `LARGE_DATA_ADVICE`), `formatBytes()` |
| `metadata.ts` | format detection (magic bytes, then extension), encoding detection, CSV parser and delimiter sniffing, type inference, JSON/JSONL shape, PNG/JPEG/GIF dimensions from headers, bounded head reads, streamed line counts, `describeFile()`, `sampleFile()`, `describeFolder()`, `parseUri()` (returns a `ParsedUri` whose `locator` drops credentials, query and fragment), `describeRemote()` |
| `walk.ts` | `walkFolder()`: bounded, symlink-free walk that skips `.git`, `node_modules` and friends |
| `assets.ts` | `DataAssets`: `register`, `registerUpload`, `list`, `get`/`describe`, `sample`, `remove`, `view`, `projectDataDir`, `projectReposDir`; `normalizeKind()`, `isRemoteSource()`, `safeFileName()` |
| `import.ts` | `DataImporter.importZip()`, `importFolder()` and `importGitHubRepo()`, `parseRepositorySource()`, `migrationBranchName()`, `MIGRATION_BRANCH_PREFIX`, `DEFAULT_GIT_REMOTE_BASE`, `checkZipEntryName()`, `isSymlinkEntry()`, `recordZipEntry()` (name-conflict table), `ensureDataDirIgnored()`, `WORKTREE_DATA_DIR` |
| `tools.ts` | `dataTools(deps)` and `registerDataTools(registry, deps)`: the four ToolSpecs; `renderSample()` |
| `routes.ts` | `createDataRoutes(deps)`: the Hono sub-app for the Data tab, `DATA_ROUTES`, request bodies |
| `index.ts` | exports (re-exported by the runtime's `src/index.ts`) |

### Layout on disk

```
<projectsRoot>/<project id>/data/                      projectDataDir(projectId)
<projectsRoot>/<project id>/data/<asset id>-<name>     copies (mode "copy") and uploads
<projectsRoot>/<project id>/data/imports/<name>-<suffix>/   extracted ZIPs and copied folders
<projectsRoot>/<project id>/repos/<owner>/<name>/      imported repositories (projectReposDir)
```

The repos dir sits beside the data dir, never inside it (a checkout is a worktree; nothing
under the data dir is), and is not `appDirs().worktrees`, which holds the PR executor's
disposable per-task worktrees (ADR 0069).

`projectsRoot` defaults to `appDirs().data/projects` (`FORERUNNER_HOME` honoured) and is a
constructor option so tests and the two-install environment put it elsewhere. Project ids
pass through `safeSegment()`. Nothing under this tree is ever a symlink.

### Registration (`DataAssets.register`)

1. The project must exist (`not_found`), the source must be non-empty, `kind` one of
   `file | folder | dataset` (default: `folder` for a directory, `file` otherwise). A URI
   (`scheme://...`) must use one of `REMOTE_SCHEMES` (`s3 r2 gs az hf https http`); a local
   source must be an absolute path that exists and is not a symlink.
   A URI is reduced by `parseUri()` to `scheme://host/path` before anything else happens:
   userinfo (`user:pass@`), the query (presigned signatures, access tokens) and the fragment
   never reach the stored `locator`, `metadata.host`, the audit row, an approval request or
   a tool output. When something was dropped the row's `note` ends with `URI_STRIPPED_NOTE`
   (keep bucket credentials in the vault as a secret reference; the run injects them).
2. Storage decision, in code: a URI is `remote` (never fetched; `mode: "copy"` is
   `not_supported`). A local source larger than `copyThresholdBytes` is `linked` whatever the
   caller asked and gets `largeDataNote()` (size and threshold). A folder whose walk hit a
   limit is `linked` too and gets `truncatedWalkNote()`, which names the limit (`entries`,
   `bytes` or `depth` with its value) and never quotes the size threshold, because the size of
   such a folder is unknown. A small source with `mode: "copy"` is copied to
   `<dataDir>/<id>-<safe name>` (folders file by file) and is `copied`. A source already
   inside the project data dir is `copied` without another copy. Everything else is `linked`
   at its original path.
3. Metadata and a small stored sample (`storedSampleRows`, `storedSampleBytes`) are computed
   (below) and written to the row's `sample` column as a `StoredAssetInfo` (`v: 1`).
4. The row is inserted with `project_ids = [projectId]`, `locator` (path or URI),
   `size_bytes`, `kind`, `registered_by` (agent id, else human id, else device, else
   `runtime`), `author_human`/`author_agent` from the actor; the project's `data_assets`
   list gains the id; an audit row `data.register` is appended (imports pass `audit: false`
   and write one `data.import` row instead).

`registerUpload()` (bytes from the daemon API) refuses more than `uploadMaxBytes` with
`validation` + `details.tooLarge` (the route answers 413), writes the file into the data
dir with mode 0600 under `<id>-<safe name>`, registers it as a copy and audits `data.upload`.

### Metadata

`describeFile()` reads at most `headBytes` (64 KB) from the head of the file:

- Format: magic bytes first (png, jpeg, gif, webp, pdf, zip, gzip, parquet, sqlite), then
  the extension (csv/tsv, json, jsonl/ndjson, text-like extensions), then `text` or
  `binary` by the encoding check. A `.csv` that starts with a PNG header is a PNG.
- Encoding: BOMs (`utf-8-bom`, `utf-16le`, `utf-16be`), NUL bytes mean `binary` (with a
  UTF-16-without-BOM heuristic), a strict UTF-8 decode of the head gives `utf-8`, else
  `latin1`.
- CSV: delimiter sniffed from the first line (`, \t ; |`; `.tsv` is tab), an RFC 4180 parser
  (quotes, doubled quotes, newlines inside quotes) over the head, column names from the
  header row, types from the first rows (`integer number boolean date string empty`, merged
  to `number` or `mixed`), row count = streamed newline count minus the header. Files larger
  than `rowCountMaxBytes` get an estimate from the bytes read, flagged `rowCountExact: false`.
- JSONL: one object per line, columns from the union of keys in the head, row count streamed.
- JSON: documents up to `jsonParseMaxBytes` are parsed whole: arrays of objects give columns
  and `rowCount`, other arrays an element type, objects their top-level keys. Bigger documents
  report `truncated: true` and the shape of the head (`$: array|object`).
- Images: width and height from the PNG IHDR chunk, the first JPEG SOF marker, the GIF
  logical screen descriptor.
- Text: line count streamed, the first `storedSampleBytes` as the stored sample.
- Folders (`describeFolder()`): file count, total bytes, extension histogram, the first
  `folderSampleEntries` relative paths; `truncated` when a walk limit stopped it.
- URIs: scheme and host only.

`metadata.truncated` is true whenever the numbers come from a partial read.

### Samples

`DataAssets.sample(id, { rows, bytes })` reads the file again, fresh, and returns the first
`rows` rows (csv, jsonl, json arrays), the first `bytes` of text, a hex preview of 256 bytes
for binary formats, or the first entries of a folder. `bytes` is clamped to
`limits.sampleBytes` (64 KB) and `rows` to `limits.maxSampleRows` (200) whatever the caller
passes; `truncated` says whether the source holds more. Remote assets return their stored
sample or `kind: "none"`; a linked file that is no longer at its path throws `not_found`
(`available: false` in the view). The route `GET /data/:id/sample?rows=&bytes=` and the
`data_sample` tool go through this method.

### Views

`DataAssets.view(row)` is a superset of the UI's proposed `DataAssetView` (`id`,
`projectIds`, `locator`, `name`, `sizeBytes`, `kind`, `ownerDeviceId`, `sample`,
`registeredBy`, `createdAt`) plus `updatedAt`, `storage`, `format`, `mime`, `metadata`,
`note` and `available`. Rows the state service's `/projects/:id/uploads` route wrote (a
different `sample` shape) still render: name from the locator without the id prefix,
`linked`, format from the extension, no metadata.

### Imports (`DataImporter`)

`importZip(zipPath, projectId, opts)` opens the archive with adm-zip and, before writing
anything, checks every entry name with `checkZipEntryName()`: absolute names (`/x`, `C:\x`,
`\\server\x`) and any `..` segment throw `validation` (the whole import is refused); empty
names, `__MACOSX/`, entries deeper than `maxDepth` and symlink entries (unix mode `0xA000` in
the external attributes) are skipped and listed. More than `maxEntries` entries or more than
`maxTotalBytes` declared throws. Segments are sanitised for Windows (`<>:"|?*`, control
characters, trailing dots and spaces, reserved device names). Conflicting entries throw
`validation` as well (`conflicting entries in archive: <a> and <b>`, with `details.entry` and
`details.conflictsWith`): a file and a folder of one name (`a` next to `a/` or `a/b.txt`),
two entries that sanitise to the same name (`a?.txt` and `a_.txt`), or names that differ only
by case, which collide on Windows and are therefore refused on every OS so an import behaves
the same everywhere (`recordZipEntry()` keeps the table of seen paths and implied folders).
All of that is pass 1, before any write, so the route answers 400 and nothing is left on
disk; only a genuine I/O failure during extraction is `internal` (500). Extraction goes to
`<dataDir>/imports/<zip name>-<suffix>/`, re-checked with `isInside()`; the running total of
real bytes is checked again against `maxTotalBytes` (a zip bomb with lying headers stops and
the destination is removed). Each extracted file is registered (`copied`) unless
`register: false`; the result sorts `imported` by relative path.

`importFolder(folderPath, projectId, opts)` walks with `walkFolder()` (same limits; a hit
throws `validation` with `details.limit`), registers each file linked in place, or copies the
tree into `<dataDir>/imports/<name>-<suffix>/` when `copy: true` and the total is under the
copy threshold (above it the files stay linked and `note` says why).

Both write one `data.import` audit row and, when `opts.worktreePath` is given, run the
gitignore guard. `importZip` and `importFolder` never touch the original (A.3).

`importGitHubRepo({ repo, tokenRef? }, projectId, opts)` (ADR 0069):

1. `parseRepositorySource()` takes `owner/name` (resolved against `gitRemoteBase`, default
   `https://github.com`) or an http(s) URL and returns owner, name, slug and a clone URL
   without userinfo, query or fragment. A URL with credentials, a non-http scheme (ssh, scp
   form), a path without `owner/name` and a segment outside `[A-Za-z0-9_.-]` are `validation`.
2. The token: a named `tokenRef` must be `secret:<name>` (`validation` otherwise) and is used
   for whatever host the URL names. Without one, `defaultTokenRef` (the daemon passes
   `secret:github_token`) is used only when the vault holds it **and** the clone URL is on
   `gitRemoteBase`'s origin; any other origin clones anonymously, so a request naming another
   server never receives the install's token. The value is resolved with `resolveSecretRefs`
   at call time (`not_found` for a missing name, `not_supported` without a vault) and reaches
   git only through `GitOps`' environment (`GIT_CONFIG_*`), never argv, the clone's config, a
   log line, a row or the result.
3. The project must exist (`not_found`). All of the above happens before any disk or network
   access.
4. Clone into `<projectsRoot>/<id>/repos/<owner>/<name>` (both segments through
   `safeSegment()`); a failed clone removes the half checkout and records nothing. When the
   checkout already exists, `git fetch` instead.
5. The migration branch: on a re-import, the branch the checkout sits on when it is a
   `forerunner/migration-*` branch, else the newest such local branch (checked out), else a
   new `migrationBranchName(clock)` = `forerunner/migration-<YYYY-MM-DD>` created from
   `origin/<default branch>` (`refs/remotes/origin/HEAD`; an empty repository is
   `validation`). The import never checks out, commits to or pushes the default branch, and
   it pushes nothing at all; it then asserts the checkout is on the migration branch and not
   the default one (`internal` otherwise).
6. The checkout is walked with `walkFolder()` (the clone's `.git` skipped and not reported);
   a walk that hit a limit sets `note` (`truncatedWalkNote()`) and does not fail the import.
7. Records: one `folder` asset (`storage: linked`, locator the checkout, name `owner/name`;
   reused by locator on a re-import; skipped with `register: false`), `owner/name` appended
   once to the project's `repos` (the list the PR executor's `repoFor` reads), and one
   `data.import` audit row naming the slug, branch, default branch and the reference (never
   the value). The result's `repository` carries slug, url, worktree, branch, defaultBranch,
   headSha, assetId and `reused`; `gitignore` is null (the guard is for data, not the clone).

The repository's files are then visible to `GET /projects/:id/data`, `data_list`,
`data_describe` and `data_sample` through the folder asset, like a linked folder.

### The gitignore guard

`ensureDataDirIgnored(worktreePath, dataDir)` makes sure the worktree's `.gitignore` has
`/.forerunner-data/` (the in-worktree convention `WORKTREE_DATA_DIR`, where an agent may keep
scratch data) and, when the project data dir lies inside the worktree, its relative path as
`/<rel>/`. Lines already present in any equivalent spelling are left alone; missing lines
are appended under a comment, creating the file when needed. The daemon passes the worktree
through `DataRoutesDeps.worktreeFor`.

### Tools

`dataTools({ assets, approvals })` returns four `ToolSpec`s; `registerDataTools()` adds them
to a `ToolRegistry`. All run inside the enforcement hooks like any other tool.

| Tool | Class | What it does |
| --- | --- | --- |
| `data_list` | read | one line per asset of the run's project: id, kind/format, name, size, rows, storage |
| `data_describe {assetId}` | read | the view with metadata and the stored sample, clipped to the sample cap |
| `data_sample {assetId, rows?, bytes?}` | read | `DataAssets.sample()`; the schema refuses `bytes` above `sampleBytes` and `rows` above `maxSampleRows`, the service clamps again, the rendered output is cut at the cap |
| `data_register {source, kind?, mode?, name?}` | non_routine | registers for the run's project; a relative source resolves against the run's cwd |

`data_describe` and `data_sample` refuse an asset that is not in the run's project
(`not_found`); a run without a project gets `validation`. Their output carries
`untrusted: { source: "attachment", origin: <name> }`, so `afterToolCall` wraps it in the
data envelope and scans it (`packages/runtime/test/data-tools.test.ts` proves it end to end
with a planted instruction). `data_register` with a path inside the token's `allowedPaths`
needs no approval; a path outside them or a URI calls `ApprovalPort.request()` (class
`capability_grant`, the agent gains read access to data it could not reach) and throws
`approval_required` while the answer is pending or when it is no. For a URI the tool reduces
the source to `scheme://host/path` before the approval request is built, so `why`,
`input.source`, the `approval_required` details, the stored row, the audit row and the tool's
own output never carry credentials or a signed query (`data-tools.test.ts` registers a URI
with a password and a signature and sweeps every one of those surfaces). In production the
port is `StateApprovals` (a blocking `human_request`); tests use `AutoApprove`. There is no
removal tool: `DataAssets.remove()` throws `approval_required` for an actor without a
`humanId`.

### Routes (`createDataRoutes`)

| Route | Body | Response |
| --- | --- | --- |
| `GET /projects/:id/data` | | `DataAssetView[]` |
| `POST /projects/:id/data` | JSON `{ locator, kind?, mode?, name?, sizeBytes? }` | 201 `DataAssetView` |
| `POST /projects/:id/data` | multipart `file` (+ `kind`, `name`) | 201 `DataAssetView`; 413 above `uploadMaxBytes` |
| `POST /projects/:id/data/import` | `{ source: "zip" \| "folder" \| "github", path \| locator, copy?, tokenRef? }` | `ImportResultView` |
| `GET /data/:id` | | `DataAssetView` |
| `GET /data/:id/sample?rows=&bytes=` | | `DataSample` |
| `DELETE /data/:id` | | `{ ok: true, id, deletedFromDisk }` |

`kind` accepts the UI's words (`folder`, `csv`, `parquet`, `sqlite`, `zip`, `dataset`,
`other`): `folder` and `dataset` map to themselves, everything else to `file`; the content
format is detected, not declared. Errors are `{ code, message, details }` with 400 for
`validation`/`not_supported`, 403 for `approval_required`, 404 for `not_found`, 413 for an
oversized upload. `deps.actor(c)` names who acts (the daemon's human); `DELETE` answers 403
without a human. Mount with `app.route("/", createDataRoutes(deps))`.

For `source: "github"`, `path`/`locator` is `owner/name` or an http(s) URL; `tokenRef` must
match `secret:<name>` (a raw value is refused by the schema) and is accepted for `github`
only; `copy` is refused for `github`. The route hands the actor to `importGitHubRepo()` and
does not call `worktreeFor`.

### Limits

| Limit | Default | Enforced in |
| --- | --- | --- |
| `sampleBytes` | 64 KB | `sample()`, tool schema, `renderSample()`, `data_describe` clip |
| `sampleRows` / `maxSampleRows` | 20 / 200 | `sample()`, tool schema |
| `copyThresholdBytes` | 50 MB | `register()` (file and folder), `importFolder(copy)` |
| `headBytes` | 64 KB | every metadata read |
| `rowCountMaxBytes` | 256 MB | `countLines()`; beyond it an estimate |
| `jsonParseMaxBytes` | 8 MB | `describeJson()` |
| `maxEntries` / `maxTotalBytes` / `maxDepth` | 10 000 / 2 GB / 32 | `walkFolder()`, `importZip()` |
| `uploadMaxBytes` | = copy threshold | `registerUpload()`, the multipart route |
| `folderSampleEntries` | 50 | folder samples |
| `storedSampleRows` / `storedSampleBytes` | 5 / 1 KB | the sample kept on the row |

All are `DataAssetsOptions.limits` overrides, validated by `resolveDataLimits()`.

### Decisions recorded here

No ADR number was reserved for this module, so the open points are decided here:

- `kind` is structural (`file | folder | dataset`); the content `format` is detected and
  stored separately, so a `.csv` of PNG bytes is a PNG.
- Remote URIs are registered, described and never fetched by the runtime: credentials for
  buckets stay in the vault and the code a specialist writes reads the data in its sandbox.
- A path outside the run's allowed roots is a capability grant, not a read, so an agent's
  `data_register` asks the human for it; inside the roots it is free.
- The copy threshold is 50 MB and the sample cap 64 KB; both are limits, not prompt text.
- `.forerunner-data/` is the in-worktree data folder convention the guard always ignores.
- A registered URI is stored as `scheme://host/path` only. Userinfo, query and fragment are
  dropped rather than redacted on output, so no copy of a presigned link or an embedded
  password exists anywhere in the store; a URI that needs them is registered without them and
  the credentials go to the vault.
- An archive whose entries conflict (file against folder, duplicate after sanitising, or a
  case-only difference) is refused whole on every OS, instead of letting the later entry win,
  because the outcome would otherwise differ between Windows and Linux.

## How to change it

- A new format: add the extension to `FORMAT_BY_EXT`, the mime to `MIME_BY_FORMAT`, magic
  bytes to `sniffFormat()`, and a branch in `describeFile()`/`sampleFile()`; add a fixture in
  `test/data-helpers.ts` and a case in `data-assets.test.ts`.
- A new limit: add it to `DataLimits` and `DEFAULT_DATA_LIMITS`, enforce it in code, list it
  in the table above, and add a test that fails without the check.
- A new URI scheme: `REMOTE_SCHEMES` in `types.ts` (keep it a list the human can read).
- A new tool: add it in `tools.ts`, keep `untrusted` on anything that echoes file content,
  and never return more than `sampleBytes`; add it to `DATA_TOOL_NAMES` and the tests.
- Wiring in the daemon (done, ADR 0039; `runtime.md` "Files and data"): `compose.ts` builds
  `new DataAssets({ store, clock, projectsRoot: <data>/projects, limits })` and
  `new DataImporter({ assets, store, clock, vault, defaultTokenRef: "secret:github_token",
  gitRemoteBase? })` (`ComposeOptions.data.gitRemoteBase`, default github.com), registers `registerDataTools(tools, { assets,
  approvals })` with the hooks' `StateApprovals` into the built-in tool registry, and
  `server.ts` mounts `createDataRoutes({ assets, importer, actor: () => ({ humanId }) })` at
  the root; `ComposeOptions.data` overrides the root and the limits, `RuntimeApp.data` exposes
  the registry and the importer. A new route or tool goes into this module and needs nothing
  in the daemon beyond `DAEMON_ROUTES`.

## Tests

`packages/runtime/test/data-helpers.ts` builds a temp directory (fixtures under `src/`,
`projectsRoot` under `projects/`), a `sqlite::memory:` store with two projects, a
`SimulatedClock`, and fixture writers (`csvText`, `jsonlText`, `pngBytes`, `jpegBytes`,
`makeZip` with raw entry names so hostile archives reach the importer).

- `data-assets.test.ts`: registration kinds (file, folder, URI), a URI with a password, a
  signed query and a fragment stored and audited without any of them, copy vs link, the
  large-file rule and note, the truncated-walk note naming the limit instead of the threshold,
  validation, the default projects root, metadata for csv (exact and estimated counts),
  jsonl, json, png/jpeg, encodings, sample caps, folder samples, moved files, removal (human
  only, copies deleted, originals kept, audit), state-service rows.
- `data-import.test.ts`: zip extraction and registration, zip-slip and absolute entries
  rejected before any write, conflicting entries (file against folder in both orders,
  duplicates after sanitising, case-only differences) rejected before any write while a folder
  declared explicitly and implicitly is fine, symlink and `__MACOSX` entries skipped, entry
  and byte limits with cleanup, folder import (symlinks and VCS dirs skipped, copy mode,
  threshold note, limits), the gitignore guard (create, append, idempotent, relative pattern,
  via imports).
- `data-tools.test.ts`: exactly four tools, project scoping, untrusted output, schema and
  service caps, the hooks wrapping and scanning a planted instruction, `data_register` with
  and without approval (approved, pending, denied, URI), the large-file note, and a URI with
  a password and a signature never reaching the approval text, the model-facing output of any
  tool, the refusal details or the audit log.
- `data-routes.test.ts`: list, JSON register, describe, sample, delete, error codes, delete
  without a human, multipart upload (sanitised name, 413), zip and folder import with the
  gitignore guard, a conflicting archive answered 400 with nothing registered, and a
  `github` body (schema checks on `tokenRef` and `copy`, the importer receiving the reference
  and the daemon's human).
- `data-import-github.test.ts` (against `FakeGitHost` over git smart HTTP; each git case is
  skipped with the reason when `git http-backend` is missing): clone under the repos dir onto
  `forerunner/migration-<date>` from the Clock, the remote's branches and `main` unchanged
  after the import and after a commit on the migration branch, one folder asset and one
  `repos` entry, the token absent from logs, rows, the result and `.git/config`, a re-import
  keeping the worktree, the branch with its commit and the row; `owner/name` against the git
  base, a public clone without a token, `register: false`, a private clone failing without a
  token with the half checkout removed, the install's default reference used on its own git
  host and withheld from another origin while an explicit reference is honoured; credentials
  in the URL, a raw token as `tokenRef`, an unknown reference, ssh and scp forms, a missing
  project and a missing vault refused before any request reaches the host.

- `data-wiring.test.ts` (the module inside `composeRuntime` and the daemon, ADR 0039): the
  four tools registered as built-in tools and the routes listed in `DAEMON_ROUTES`, a folder
  import through `POST /projects/:id/data/import` landing in the registry, the project's
  `data_assets` and `GET /projects/:id/data` (with describe and sample routes behind the
  bearer token and one `data.import` audit row), the tools behind the hooks (listing, a
  sample under the cap, the over-cap call refused by the schema and audited), a zip-slip
  archive answered 400 with nothing registered or written, `data_register` for a path outside
  the run's roots refused as `approval_required` with a `capability_grant` request in the
  inbox and nothing registered while a path inside registers freely, and removal only through
  the route as the daemon's human; a `github` import through the route with the install's
  own `secret:github_token` (the fake host as `data.gitRemoteBase`): refused for another
  origin (anonymous clone of a private repository, nothing left), then cloned under
  `<data>/projects`, listed as a folder asset, linked in `repos`, audited without the token,
  and a missing reference answered 404.

Run: `pnpm vitest run --project unit packages/runtime/test/data-*.test.ts`.

## Known issues

- Row counts of CSV files count newlines, so a quoted field with an embedded newline past
  the head inflates the count by one line; column inference and samples parse quotes
  correctly.
- JPEG dimensions need the SOF marker within the first `headBytes`; a file whose EXIF block
  is larger than 64 KB reports no dimensions.
- `importZip` holds each entry in memory while extracting (adm-zip's API); the total-bytes
  limit bounds it, there is no per-entry limit.
- The samples route and tool read the file fresh each call; a file replaced in place after
  registration keeps its old metadata until it is registered again.
- Multipart uploads are buffered whole by Hono before the size check; the cap keeps that
  bounded, but a client that lies about `content-length` still costs the daemon the bytes.
- Archives with names that differ only by case are refused on Linux too, where they would
  extract fine; the price of one behaviour on both OSes.
- Dropping the query from a URI means a presigned link cannot be registered as such; the
  object's plain URI is stored and the signature has to be produced again at read time.
- The daemon sets no `worktreeFor`: its worktrees are per task and cloned fresh from the
  repository, and the project data dir lies outside them, so the gitignore guard runs only
  for a caller that hands the importer a worktree (ADR 0039 point 12). A project that keeps
  data inside its own checkout relies on the `.forerunner-data/` convention.
- Multipart uploads through the daemon are bounded by `uploadMaxBytes`, but the UI's data tab
  registers by locator only (`POST /projects/:id/data` JSON); the upload form is not built.
- The UI's import form still posts to the proposed `POST /projects/:id/import` with
  `source: "repo"`; it is not wired to `POST /projects/:id/data/import` with `source: "github"`.
- The repository import does not push the migration branch or open a PR; the PR executor
  clones its own per-task worktree from the remote, so commits made in the import's checkout
  reach the remote only when a later change makes the executor reuse it (ADR 0069).
- A GitHub Enterprise or other host is reached by a full URL; the install's default token is
  sent only to `gitRemoteBase`'s origin, so a private repository there needs an explicit
  `tokenRef` unless the daemon is composed with that base.
- `GitOps` hands the token to git through `GIT_CONFIG_*` (git 2.31+); an older git ignores it
  and clones anonymously.

## Requirement IDs covered

- L.1 Files and data: upload, link folders, register large datasets by path or URI; agents
  see metadata and samples, not whole files; large data never goes into git (the copy
  threshold, the note, the gitignore guard).
- A.3 Import from ZIP, local folder or an existing GitHub repository (the original
  untouched; the repository's migration runs on `forerunner/migration-<date>`, ADR 0069).
- K.2 Data tab backend (routes and view shape).
- U.4, U.16 `data_asset` rows and the project's `data_assets` list.
- S.2 content is data (untrusted tool output), S.6 deleting data needs a human.
