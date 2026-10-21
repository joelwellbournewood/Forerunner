# 0050 — Audit log export: one module behind the daemon route, the state service and `fr audit export`

Date: 2026-10-20
Status: accepted

## Context

Spec S.9 wants the audit log, the append-only record of every tool call (who, what, when,
cost, result), to be exportable. The log existed with filters (`store.auditLog.list` by
actor, tool, allowed and time; triggers refuse `UPDATE` and `DELETE`) and every tool call,
email, desktop action, deploy and runner unlock wrote a row, but nothing read it out as a
file. Four surfaces need the export: the daemon's local API for the app, the state service
for a phone or the approvals web, the command line, and a button where the app shows its
performance data. Open points: how to read a log that may hold millions of rows without
loading it, which rows a caller may see when the state is shared between humans, what the
file contains, and which formats.

## Decision

1. **One module, `packages/runtime/src/daemon/audit-export.ts`.** It holds the query schema,
   the paging reader, the owner scope, the two serialisers and the Hono streaming step. The
   daemon mounts `createAuditRoutes` at `GET /audit/export`; the state service's
   `registerAuditRoutes` and `fr audit export` call the same functions. The state service
   already depends on `@forerunner/runtime` (the decision log), so no new edge.
2. **Pages, never the table.** `auditExportPages` reads `store.auditLog.list` with
   `limit: 500` (`AUDIT_EXPORT_PAGE_SIZE`) and a growing `offset` in the repository's stable
   `occurred_at, id` order until a short page; each page is serialised and written before the
   next is read. Offset paging is safe here because the log is append-only and a late row
   carries the clock's current time, which sorts after the page being read; keyset paging
   would need a filter the repository does not expose, and the repository belongs to another
   wave. The HTTP response is a chunked stream (`hono/streaming`); the CLI awaits each
   chunk's write before reading on.
3. **Rows as stored, no raw parameters.** The export writes `input_summary` and
   `result_summary` exactly as the hooks stored them: redacted (`redactForDisplay`) and
   capped (`summarize`) at write time. Nothing elsewhere holds the raw parameters, and the
   export adds no column that would. Each record carries `id, occurredAt, agentId, humanId,
   sessionId, runId, tokenId, tool, allowed, deniedReason, costUsdMicro, inputSummary,
   resultSummary, recordedAt` in that order (`AUDIT_EXPORT_COLUMNS`); `recordedAt` is the
   store's `created_at`, kept for forensic ordering beside the call's own time.
4. **The owner scope.** A row is a human's when it names them (`human_id`) or one of their
   agents (`agent_id`). The daemon and the CLI export the install's human's rows and, because
   the install is theirs, the install-level rows that name nobody (update health checks, the
   schema sync gate). A device reading through the state service gets the human's rows only:
   install-level rows of some runtime are not a phone's business. A requested `agentId` that
   is not one of the human's agents is `not_found` whether it belongs to another human or to
   nobody, so the answer does not confirm the id; a requested `humanId` of another human is
   `forbidden`, as on every state service route. The runtime's admin principal reads the whole
   log, or one human's rows when it names a `humanId`. The scope is a predicate applied per
   row on top of the SQL filters, since the repository's filter cannot express the `OR`.
5. **Two formats.** JSON lines (`application/x-ndjson`, one record per line, the default) and
   RFC 4180 CSV (`text/csv`, CRLF, the header first, quotes doubled). CSV cells a spreadsheet
   would evaluate (a leading `=`, `+`, `-`, `@`, tab or CR) get a leading apostrophe: the
   summaries contain text from web pages, emails and tool outputs, and CSV injection is the
   known way such text reaches a spreadsheet user. The guard runs before the quoting, so the
   altered cell is still well formed.
6. **Limits in code.** `format` is an enum, ids are capped at 200 characters, `from` and `to`
   must parse as ISO-8601 and `from` must not be after `to`; all of it is refused with
   `validation` before any read, and the headers go out only once the scope is settled. The
   page size is a constant, not a request parameter: a caller cannot ask for the table in one
   page. The CLI opens the file with `wx` and refuses an existing one unless `--force`.
7. **The file name comes from the server.** `Content-Disposition: attachment;
   filename="forerunner-audit-<UTC stamp>.<format>"` from the clock, exposed through CORS so
   the app reads it cross-origin; the client keeps the base name only and falls back to a
   fixed name. The app saves it through an object URL on a hidden anchor (`saveTextFile`),
   which reports false where object URLs do not exist so the page can say so and point at
   `fr audit export`.

## Consequences

- S.9 is done on all four surfaces with the same bytes: the UI's fake daemon serialises its
  fixture through the module's own `jsonlLine` / `csvLine`, so a contract drift fails the UI
  tests.
- An export of a very long log is bounded in memory by one page but still a full scan; a
  window (`from`, `to`) or a session narrows the read through the repository's indexes.
- A failure in the middle of the stream cannot change the status any more; it is logged and
  the body is truncated. A client that needs certainty counts the rows (the CLI prints the
  count it wrote).
- The Linux desktop shell (WebKitGTK) has no download handler yet, so the button's download
  is saved by the browser dev server and by WebView2 on Windows but may be ignored there; the
  CLI covers that case until the shell registers one (apps.md, Known issues).

## Alternatives considered

- **Load and serialise the whole log in one `list` call.** Simplest; rejected because the
  log grows without bound and the route runs inside the daemon that also runs sessions.
- **Keyset paging on `(occurred_at, id)`.** Better under concurrent inserts with older
  timestamps; rejected for 1.0 because the repository filter has no strict cursor and the
  state package is another wave's; the append-only clock argument makes offsets safe.
- **Filter by `human_id` in SQL instead of the per-row predicate.** Cheaper, but rows of the
  human's agents written without a `human_id` would be lost, and the predicate is one line.
- **Count rows up front for a `X-Row-Count` header.** `count()` loads every row through
  `list`; rejected. The CLI counts as it writes, the app counts the lines it received.
- **A JSON array instead of JSON lines.** Needs the whole body to parse; lines stream, grep
  and append.
- **No formula guard.** Spreadsheets are where a CSV goes; the apostrophe changes a cell that
  starts with those characters, which the record's JSON lines form does not, so the exact
  text is always available.
