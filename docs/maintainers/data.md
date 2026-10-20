# Files and data

`packages/runtime/src/data`: the Data tab's backend and the data tools (spec L "Files and
data", K "Project page" Data tab, A "Projects and onboarding" ZIP and folder import, build
order phase 5). Files, folders and datasets are registered by path or URI as `data_asset`
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
- Removing data needs a human at every autonomy level (S.6); file content is data, not
  instructions (S.2): every tool output is marked untrusted so the hooks wrap and scan it.
- Every registration, upload, import and removal is an `audit_log` row.

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | zod shapes (`DataAssetView`, `DataMetadata`, `DataSample`, `ImportResultView`, `StoredAssetInfo`), kinds, storage modes, `REMOTE_SCHEMES`, `DataLimits` with `DEFAULT_DATA_LIMITS` and `resolveDataLimits()`, `largeDataNote()`, `formatBytes()` |
| `metadata.ts` | format detection (magic bytes, then extension), encoding detection, CSV parser and delimiter sniffing, type inference, JSON/JSONL shape, PNG/JPEG/GIF dimensions from headers, bounded head reads, streamed line counts, `describeFile()`, `sampleFile()`, `describeFolder()`, `parseUri()`, `describeRemote()` |
| `walk.ts` | `walkFolder()`: bounded, symlink-free walk that skips `.git`, `node_modules` and friends |
| `assets.ts` | `DataAssets`: `register`, `registerUpload`, `list`, `get`/`describe`, `sample`, `remove`, `view`, `projectDataDir`; `normalizeKind()`, `isRemoteSource()`, `safeFileName()` |
| `import.ts` | `DataImporter.importZip()` and `importFolder()`, `checkZipEntryName()`, `isSymlinkEntry()`, `ensureDataDirIgnored()`, `WORKTREE_DATA_DIR` |
| `tools.ts` | `dataTools(deps)` and `registerDataTools(registry, deps)`: the four ToolSpecs; `renderSample()` |
| `routes.ts` | `createDataRoutes(deps)`: the Hono sub-app for the Data tab, `DATA_ROUTES`, request bodies |
| `index.ts` | exports (the runtime's `src/index.ts` re-exports it once the daemon wires the module) |

### Layout on disk

```
<projectsRoot>/<project id>/data/                      projectDataDir(projectId)
<projectsRoot>/<project id>/data/<asset id>-<name>     copies (mode "copy") and uploads
<projectsRoot>/<project id>/data/imports/<name>-<suffix>/   extracted ZIPs and copied folders
```

`projectsRoot` defaults to `appDirs().data/projects` (`FORERUNNER_HOME` honoured) and is a
constructor option so tests and the two-install environment put it elsewhere. Project ids
pass through `safeSegment()`. Nothing under this tree is ever a symlink.

### Registration (`DataAssets.register`)

1. The project must exist (`not_found`), the source must be non-empty, `kind` one of
   `file | folder | dataset` (default: `folder` for a directory, `file` otherwise). A URI
   (`scheme://...`) must use one of `REMOTE_SCHEMES` (`s3 r2 gs az hf https http`); a local
   source must be an absolute path that exists and is not a symlink.
2. Storage decision, in code: a URI is `remote` (never fetched; `mode: "copy"` is
   `not_supported`). A local source larger than `copyThresholdBytes`, or a folder whose walk
   hits a limit, is `linked` whatever the caller asked and gets `largeDataNote()`. A small
   source with `mode: "copy"` is copied to `<dataDir>/<id>-<safe name>` (folders file by
   file) and is `copied`. A source already inside the project data dir is `copied` without
   another copy. Everything else is `linked` at its original path.
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
characters, trailing dots and spaces, reserved device names). Extraction goes to
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
`approval_required` while the answer is pending or when it is no. In production the port is
`StateApprovals` (a blocking `human_request`); tests use `AutoApprove`. There is no removal
tool: `DataAssets.remove()` throws `approval_required` for an actor without a `humanId`.

### Routes (`createDataRoutes`)

| Route | Body | Response |
| --- | --- | --- |
| `GET /projects/:id/data` | | `DataAssetView[]` |
| `POST /projects/:id/data` | JSON `{ locator, kind?, mode?, name?, sizeBytes? }` | 201 `DataAssetView` |
| `POST /projects/:id/data` | multipart `file` (+ `kind`, `name`) | 201 `DataAssetView`; 413 above `uploadMaxBytes` |
| `POST /projects/:id/data/import` | `{ source: "zip" \| "folder", path \| locator, copy? }` | `ImportResultView` |
| `GET /data/:id` | | `DataAssetView` |
| `GET /data/:id/sample?rows=&bytes=` | | `DataSample` |
| `DELETE /data/:id` | | `{ ok: true, id, deletedFromDisk }` |

`kind` accepts the UI's words (`folder`, `csv`, `parquet`, `sqlite`, `zip`, `dataset`,
`other`): `folder` and `dataset` map to themselves, everything else to `file`; the content
format is detected, not declared. Errors are `{ code, message, details }` with 400 for
`validation`/`not_supported`, 403 for `approval_required`, 404 for `not_found`, 413 for an
oversized upload. `deps.actor(c)` names who acts (the daemon's human); `DELETE` answers 403
without a human. Mount with `app.route("/", createDataRoutes(deps))`.

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

## How to change it

- A new format: add the extension to `FORMAT_BY_EXT`, the mime to `MIME_BY_FORMAT`, magic
  bytes to `sniffFormat()`, and a branch in `describeFile()`/`sampleFile()`; add a fixture in
  `test/data-helpers.ts` and a case in `data-assets.test.ts`.
- A new limit: add it to `DataLimits` and `DEFAULT_DATA_LIMITS`, enforce it in code, list it
  in the table above, and add a test that fails without the check.
- A new URI scheme: `REMOTE_SCHEMES` in `types.ts` (keep it a list the human can read).
- A new tool: add it in `tools.ts`, keep `untrusted` on anything that echoes file content,
  and never return more than `sampleBytes`; add it to `DATA_TOOL_NAMES` and the tests.
- Wiring in the daemon: build `new DataAssets({ store, clock, limits })` and
  `new DataImporter({ assets, store, clock })`, mount `createDataRoutes({ assets, importer,
  actor, worktreeFor })`, register `dataTools({ assets, approvals })` with the run's tool
  registry, and re-export `./data/index.ts` from `packages/runtime/src/index.ts`.

## Tests

`packages/runtime/test/data-helpers.ts` builds a temp directory (fixtures under `src/`,
`projectsRoot` under `projects/`), a `sqlite::memory:` store with two projects, a
`SimulatedClock`, and fixture writers (`csvText`, `jsonlText`, `pngBytes`, `jpegBytes`,
`makeZip` with raw entry names so hostile archives reach the importer).

- `data-assets.test.ts`: registration kinds (file, folder, URI), copy vs link, the large-file
  rule and note, validation, the default projects root, metadata for csv (exact and
  estimated counts), jsonl, json, png/jpeg, encodings, sample caps, folder samples, moved
  files, removal (human only, copies deleted, originals kept, audit), state-service rows.
- `data-import.test.ts`: zip extraction and registration, zip-slip and absolute entries
  rejected before any write, symlink and `__MACOSX` entries skipped, entry and byte limits
  with cleanup, folder import (symlinks and VCS dirs skipped, copy mode, threshold note,
  limits), the gitignore guard (create, append, idempotent, relative pattern, via imports).
- `data-tools.test.ts`: exactly four tools, project scoping, untrusted output, schema and
  service caps, the hooks wrapping and scanning a planted instruction, `data_register` with
  and without approval (approved, pending, denied, URI), the large-file note.
- `data-routes.test.ts`: list, JSON register, describe, sample, delete, error codes, delete
  without a human, multipart upload (sanitised name, 413), zip and folder import with the
  gitignore guard.

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

## Requirement IDs covered

- L.1 Files and data: upload, link folders, register large datasets by path or URI; agents
  see metadata and samples, not whole files; large data never goes into git (the copy
  threshold, the note, the gitignore guard).
- A.3 Import from ZIP or local folder (the original untouched); the GitHub clause is the
  project import elsewhere.
- K.2 Data tab backend (routes and view shape).
- U.4, U.16 `data_asset` rows and the project's `data_assets` list.
- S.2 content is data (untrusted tool output), S.6 deleting data needs a human.
