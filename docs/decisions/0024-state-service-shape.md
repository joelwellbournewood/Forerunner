# 0024 — State service shape: direct Postgres for runtimes, a thin service for devices, realtime, remote commands and the mirror

Date: 2026-10-20
Status: accepted

## Context

Architecture item 3 asks for "Postgres plus a thin API" that holds tasks, messages,
receipts, claims, decisions, the cost ledger and critic reviews and pushes inbox events on a
realtime channel. The runtime already has `@forerunner/state` with atomic claims (one
`UPDATE` with the claim predicate), receipts and version checks in SQL. Module R needs the
phone to work without database credentials; module M needs "both apps on a compatible
version before sync resumes"; the phase 2 gate needs either install to be offline for 48
simulated hours without breaking the other.

## Decision

**Runtimes talk to Postgres directly.** The runtime on each PC and the cloud runner open the
shared database through `openStore({ url: "postgres://...", ... })` over TLS
(`FORERUNNER_STATE_URL`). Atomic claims, receipts, version conflicts and transactions stay in
SQL where they are already proven by the state package's conformance suite; nothing is
re-implemented behind HTTP.

**The service exists for five things** (`services/state-api`, Hono on `@hono/node-server`):

1. Devices that must not hold database credentials: the phone and the approvals web page
   pair with Ed25519 keys and scoped session tokens (ADR 0009) and use the HTTP API, which
   reuses the daemon API view shapes (ADR 0011) so one UI renders either source.
2. Realtime fan-out: `GET /events` (SSE, filtered to the caller's human, `Last-Event-ID`
   resume, heartbeat every 15 s) and `GET /sessions/:id/events` for the live log. The service
   issues `NOTIFY` on a per-schema channel after its own writes and listens for other
   instances; a change-counter poll every 2 s is the fallback that also sees writes the
   runtimes make straight to Postgres. No triggers: `packages/state` is unchanged.
3. Remote commands: the phone enqueues start / pause / stop / kill; the PC runtime or the
   cloud runner picks one up atomically (`RemoteCommandRepo.pickUp`) within seconds and
   reports completion or failure.
4. The one-way GitHub mirror of tasks and milestones to issues, with comments and closes
   syncing back as messages and allowed transitions.
5. Health, version and migration checks: `GET /health` reports the service version, the
   schema version the code knows, the one applied in the database and whether they agree;
   clients that send `X-Forerunner-Schema` get `409 schema_mismatch` until both sides agree.

**Service-owned state** that is not in the schema yet lives in small JSON files under
`<appDirs().data>/state-api/` (`tokens.json`, `idempotency.json`, `mirror.json`), written
atomically. A future migration may move them into tables; the `JsonState` interface is the
seam.

**Offline story.**

- Solo mode: one PC, local SQLite, no service, nothing to sync.
- Paired mode, PC online: it works on Postgres directly; the service only pushes.
- Paired mode, PC cannot reach Postgres: it stays read-only on its last state brief, does
  not claim or transition anything, and queues outbound messages, receipts, answers, notes
  and remote commands in a local outbox (the `Outbox` contract in
  `services/state-api/src/outbox.ts`; the SQLite implementation lives in the runtime
  package). On reconnect it flushes through `POST /sync/outbox`, where client ids make retries
  idempotent. Its claims lapse after 30 minutes without renewal (`TaskRepo.expireClaims`), so
  the other install keeps working; nothing on the other PC depends on it being reachable.
  The integration test runs 48 simulated hours of one install working while the other is
  silent and checks that the returning install sees every message and acknowledges every
  handoff.
- The phone: same outbox contract, keystore-backed, flushed on reconnect.

## Consequences

- Two code paths touch the database (runtime direct, service for devices) but one package
  implements the rules, so a claim made from the phone and one made by a runtime cannot
  disagree.
- The service is stateless apart from the JSON files and can run on Fly.io or a VPS as the
  runner image with `CMD pnpm state-api`; Postgres is the only shared dependency.
- Realtime is best effort; correctness never depends on it (polling and the next session's
  startup checklist always catch up).

## Alternatives considered

- Everything through the service (runtimes never touch Postgres): simpler trust model, but
  every claim would need an HTTP round trip with its own retry semantics, and offline PCs
  would still need the outbox. Rejected for 1.0; the service can grow that path later.
- Supabase (hosted Postgres with realtime and row-level security): attractive, but ties the
  realtime path to one vendor; the same Postgres works on Supabase, Fly, a VPS or a laptop.
- Database triggers for NOTIFY: cleaner than polling, but they would change the shared
  schema and still miss nothing the poll does not already see; revisit with the migration
  that moves the JSON files into tables.

## Mirror details decided during the build (2026-10-20)

- **The service process hosts the issues mirror.** `main.ts` builds `GitHubHost` with the
  token resolved by reference (`FORERUNNER_MIRROR_TOKEN_REF`, injected by the runner as
  `FORERUNNER_SECRET_<NAME>`, the same path as the admin token), a `GitHubMirror` and a
  `MirrorScheduler` that syncs every active project every `FORERUNNER_MIRROR_INTERVAL_MS`.
  The service needs no vault dependency for this; secret injection into service processes
  is by environment reference, as for every other service secret. The runtime's own
  `ProjectsMirror` (`@forerunner/capabilities`, GitHub Projects V2 board, scheduled by the
  daemon per project, never reads back) is a separate, board-shaped mirror; an operator
  enables either or both. Only one service instance should run the issues mirror per repo.
- **Board as labels, not a classic project.** GitHub retired classic projects for new
  organisations and the `GitHost` contract has no classic-board endpoints, so the "board" of
  the issues mirror is the label set `fr:task`, `fr:tier-N`, `fr:status:<status>`,
  `fr:milestone:<slug>`, and milestones are issues labelled `fr:milestone` listing their
  criteria and task issues. When `MemoryGitHost` implements the Projects V2 calls, the push
  can additionally place each task issue on a board with a Status field; the pick
  `MirrorHost` keeps that change additive.
- **Task to issue mapping in `mirror.json`, not on the task row.** `task` has no
  `mirrored_url` column (only `message` does), and the schema is not changed by this
  service. The mapping (issue number, URL, content hash, issue state, last comment id) lives
  in the service's JSON state under `<data>/state-api/mirror.json`, written atomically. A
  migration adding `task.mirrored_url` would let the UI link to the issue and move the
  mapping into Postgres; the `JsonState` seam is where that swap happens.
