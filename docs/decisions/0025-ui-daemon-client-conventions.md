# 0025 — UI conventions over the local daemon API: config source, SSE auth, chat stream frames, open shapes

Date: 2026-10-20
Status: accepted

## Context

ADR 0011 fixes the daemon contract as zod schemas and a route table, but leaves a few things
open that the React UI (`apps/ui`) has to decide to be buildable and testable now, before the
daemon server lands: where the UI learns the daemon's address and token, how an `EventSource`
(which cannot send headers) authenticates, what the `/chat/stream` frames are called, what the
routes return whose shape the table does not spell out, and how the UI keeps the little state it
owns. The daemon implementation must follow the same choices, so they are recorded here.

## Decision

1. **Daemon config resolution** (`apps/ui/src/api/config.ts`), in order: `window.__FORERUNNER__`
   injected by the Tauri shells (`daemonUrl`, `daemonToken`, optional `installId`, `platform`,
   `shellVersion`); else `VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN` baked in at build time (dev
   server, Playwright); else `http://127.0.0.1:8787` with no token and a visible "not connected"
   state until `/health` answers. Nothing else is read from the environment or the file system.
2. **Bearer token on every request; `?token=` on the two EventSource routes.** `EventSource`
   cannot set `Authorization`, so `GET /events` and `GET /sessions/:id/events` also accept the
   same token as the `token` query parameter. The daemon must accept it there and nowhere else,
   and must not log query strings for these routes. CORS: the daemon allows the UI origin with
   the `Authorization`, `Content-Type` and `Accept` headers (the dev server and Playwright run
   the UI on another port; the Tauri shells use `tauri://` / `http://tauri.localhost`).
3. **Realtime degrades to polling, never to a silent spinner.** The SSE helper
   (`apps/ui/src/api/sse.ts`) uses `EventSource` and, when it is missing or gives up
   (`readyState` CLOSED, three consecutive errors), polls the JSON routes every 5 s
   (`/inbox` + `/sessions?status=running` for the install stream; `/sessions/:id/events?afterSeq=`
   + `/sessions/:id` for a session) and retries SSE every 30 s. The UI shows which mode it is in.
4. **`POST /chat/stream` frames.** Content type `text/event-stream`; `token` frames carry
   `{"text": "..."}` pieces of the reply in order; one final `reply` frame carries the full
   `ChatReplyView`; an `error` frame carries an `ErrorBody` and ends the stream. A daemon may
   answer with plain JSON (`ChatReplyView`) and the UI accepts that too. Read-back confirmations
   are answered by sending the words `yes` or `no` as ordinary chat messages (the conversation
   agent already treats them that way).
5. **Shapes the route table leaves open.** List routes return bare JSON arrays of the view
   type (`ProjectCard[]`, `TaskView[]`, `RunView[]`, `SessionView[]`, `SettingView[]`,
   `AgentView[]`); `GET /sessions/:id/events` in JSON mode returns `EventView[]` after
   `afterSeq`; mutations return the updated view (`POST /projects` → `ProjectCard`,
   `POST /projects/:id/tasks` and `POST /tasks/:id/transition` → `TaskView`, `POST /sessions`
   and `POST /sessions/:id/stop` → `SessionView`, `POST /requests/:id/answer` →
   `HumanRequestView`, `POST /messages/:id/read` → `MessageView`); `POST /kill` and
   `POST /kill/resume` return `{ "killActive": boolean, ... }` (extra fields allowed).
   Errors are `ErrorBody` with the HTTP status; `409` with code `conflict` on a stale `version`.
6. **Money.** The UI formats `chfMicro` only ("CHF 12.34", half-up, Swiss grouping) and shows
   the raw USD figure in a tooltip at most. CHF inputs (session and task budgets) are converted
   to `usdMicro` at the rate implied by the project's `budget` Money pair, falling back to the
   documented default 0.80 CHF/USD (ADR 0008) when the pair carries no CHF; the daemon
   re-prices at the day's rate when it records the cap.
7. **Per-install browser state.** Only two conveniences live in the webview's `localStorage`,
   namespaced by the shell's `installId` (`forerunner.ui.<installId>.activeProject` and
   `.theme`); everything else comes from the daemon. Dark mode follows
   `prefers-color-scheme` unless the stored override says otherwise; the resolved theme is
   written to `<html data-theme>` and Tailwind's `dark:` variant is bound to that attribute.
8. **Task transition buttons** mirror `TASK_TRANSITIONS` from `@forerunner/state` as a UI
   constant (the package needs Node); a unit test keeps the two identical and the daemon stays
   the authority.
9. **Testing against a fake daemon.** `apps/ui/test/fake-daemon.ts` is a Hono app serving every
   route from fixtures, used in-process by the unit tests (`app.fetch`) and as a child process
   by Playwright, with `GET /__test/calls` and `POST /__test/reset` for assertions. Playwright
   starts it and the Vite dev server on free 127.0.0.1 ports and pins the ports and a random
   token through the environment so worker processes see the same values.

## Consequences

- The daemon server (phase 1, `packages/runtime/src/daemon`) has a precise list of what the UI
  expects beyond ADR 0011; its tests can reuse the UI's fixtures as expected shapes.
- A proxy that buffers SSE or a webview without `EventSource` still gives a working, if slower,
  UI; the status badge says "polling" so nobody mistakes it for live.
- The token appears in the URL of two requests only; the daemon's logger must redact query
  strings on those routes (the Logger already redacts credential shapes).
- Two installs sharing one webview profile do not share the active project or theme.

## Alternatives considered

- Fetch-based SSE with headers instead of `EventSource`: works, but loses the browser's own
  reconnect handling and the spec of the task named `EventSource`; the parser exists anyway for
  the chat stream and could replace it later without changing the daemon.
- WebSocket for chat tokens: a second transport for no gain over SSE.
- A `/milestones` route for the Plan tab now: the phase-5 plan work (timeline, dependency
  graph) will define it; until then milestones are derived from the card and the tasks.
- Keeping the dark-mode override in the daemon's settings: it is a device preference, not a
  setting the agent should see or sync.
