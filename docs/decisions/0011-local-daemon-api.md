# 0011 — Local daemon API between the shells and the runtime

Date: 2026-10-20
Status: accepted

## Context

The desktop app is a Tauri shell around one React UI that also runs on Android; the approvals
web page and the CLI need the same functions. The runtime is TypeScript on Node (Claude Agent
SDK, node:sqlite, pg); Tauri's Rust side should not re-implement any of it. The UI must never
touch the database directly, and the phone never runs agents.

## Decision

The runtime runs as a local daemon (`fr daemon`), a Hono server bound to `127.0.0.1` on a
random free port. It writes `daemon.json` (port, bearer token, pid, version) with owner-only
permissions into the runtime directory from `appDirs()`. The desktop shell starts the daemon
as a sidecar on launch (and restarts it on crash), reads `daemon.json` and hands the UI the
base URL and token. The approvals web page and the Android app do not reach the daemon: they
talk to the shared state service, which relays remote commands (start, pause, stop) that the
daemon picks up within seconds (spec R). The CLI reads the same file.

The contract lives in `packages/runtime/src/daemon/api-types.ts` as zod schemas (`ProjectCard`,
`TaskView`, `RunView`, `SessionView`, `EventView`, `InboxView`, `CostView`, `ChatReplyView`,
request bodies, `HealthView`) and a route table. Realtime is server-sent events: `/events` for
inbox, session and project changes and `/sessions/:id/events` for the live log; SSE needs no
extra dependency and works through Tauri's webview on both desktop platforms.

Every mutation goes through the same command registry as chat and voice (module Q, phase 5):
until the registry lands, the daemon exposes the small set of phase-1 actions (create project
and task, transition task, start/stop session, kill, answer request, chat).

## Consequences

- The UI is testable against a fake daemon (an in-process Hono server returning fixtures) and
  the daemon is testable without a UI.
- One token per install; it never leaves the machine. Phones get scoped session tokens from
  the state service (ADR 0009), not the daemon token.
- Money crosses the API as USD micro-units plus CHF micro-units computed by the daemon; the UI
  formats CHF only.

## Alternatives considered

- Tauri commands (IPC) implemented in Rust calling into Node: duplicates logic in two languages
  and does not serve the web fallback or the CLI.
- WebSocket for realtime: fine, but SSE is simpler, proxies well and suffices for one-way
  pushes; chat tokens stream over SSE too.
