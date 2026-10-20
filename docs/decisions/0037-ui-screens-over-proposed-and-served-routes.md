# 0037 — UI screens: proposed routes, the "route not available" state, mirrored schemas, charts and the settings command path

Date: 2026-10-20
Status: accepted

## Context

The remaining screens of spec module K (Reviews, Docs, Data, the Plan timeline and dependency
graph, Memory, Extensions, Updates, the Performance view, the change log, the next-session
queue, peers and decisions on the project page) were built while the daemon gained the routes
they need. Some routes existed (extensions, updates, model watch, estimates, peers,
decisions), some arrived during the work (reviews, memory, commands, the change log), and some
do not exist yet (the queue, milestones, data assets and imports, project docs, performance).
The UI also needs schemas that live in runtime modules the browser cannot import, has to draw
two charts without a chart library, and has to let the settings screen change a value through
the same command registry chat and voice use (spec Q.1, Q.12). The spec leaves open where the
queue, peers and decisions live on the project page, what a page shows when its daemon is
older than the UI, and how the desktop confirms a high-risk change.

## Decision

1. **One client, three kinds of route.** `apps/ui/src/api/client.ts` has a typed method for
   every entry of `DAEMON_ROUTES`. Routes the daemon does not list yet are declared in
   `PROPOSED_ROUTES` (`apps/ui/src/api/contracts.ts`) in the same notation, with their view
   schemas next to them; `proposedPath()` follows the daemon's entry of the same name as soon
   as one exists and `test/contracts.test.ts` fails when a proposed name reappears in
   `DAEMON_ROUTES` (the proposal must then be deleted and the page switched to the daemon's
   shape, which is what happened for reviews, memory, commands and changes during this work).
2. **A missing route is a visible state, never a blank panel.** `isRouteMissing(error)` is a
   404/405/501 whose body is not a typed `not_found` about an entity (Hono's plain-text
   answer, or the daemon's catch-all "no route"). `useAsync` exposes it as `routeMissing`;
   every page with such a route renders `<RouteMissing route=…>`, which names the verb and
   path and points to Updates. The Plan tab keeps working from the tasks and the project card
   when the milestones route is missing. The fake daemon takes `missingRoutes` (a path and
   its children) and `failing` (an exact path with a status and body) so both states are tested.
3. **Mirrors instead of imports.** Schemas from `extensions/types.ts`, `update/screen.ts`,
   `models/watch.ts` and `estimates/view.ts` are mirrored field for field in `contracts.ts`
   because those modules pull `@forerunner/platform` or Node modules. `test/contracts.test.ts`
   parses the fixtures with both the runtime schema (imported under Vitest, where Node is
   available) and the mirror, and compares the key sets of `ExtensionView` and `UpdatesView`;
   the mirror may be more lenient (strings where the runtime has enums) but never narrower.
4. **The settings screen is a client of the command registry.** A setting row maps to a
   command (`project.autonomy` → `autonomy.set`, `project.budget` and `human.monthly_cap` →
   `budget.set`, the keys of `SETTING_SPECS` → `settings.set`; anything else is read-only and
   says so). The screen posts `POST /commands/execute { commands: [one], wordsUsed:
   "Settings: <key> to <value>", projectId? }` without a confirmation, shows the card the
   daemon returns (`CommandResult`), answers a `needs_yes` card with `{ answer: "tap" }` and a
   `needs_device` card with `{ answer: "device", deviceId: <installId> }`: the desktop app is a
   paired device (ADR 0030) and the daemon, not the screen, decides whether that device is
   known. Undo calls `POST /changes/:id/undo` and shows the daemon's sentence. The same
   `CommandResult` component serves any other button that runs a command.
5. **Where the project-page extras live.** The next-session queue, the peers feed and the
   decision log are sections of the Summary tab, below the one-screen summary: the queue is
   what the next session reads, the feed and the decisions are what the summary leaves out.
   Costs keep the savings box and gain cost per accepted task (spec I.6).
6. **Three pages beyond the spec's nav.** `/changes` (spec Q.11), `/performance` (spec D.19)
   and `/updates` (spec M.3) are top-level pages with nav entries, palette commands and the
   shortcuts `g c`, `g t`, `g u`. The daemon's `restart.requested` frame shows a banner in the
   shell on every page until a heartbeat from the target version arrives.
7. **Charts without a library.** The grade trend is a single-hue SVG line with markers and the
   accept line as a dashed reference; the Performance view draws one thin bar per mode (the
   p95 against the target, status colour only for met/missed and always with the word beside
   it). Text uses the text tokens, grid and axes are recessive, every mark has a hover title,
   the table next to the chart carries the numbers, and dark mode comes from the same
   `data-theme` binding as the rest of the UI. No categorical palette exists to validate.
8. **The memory views.** The daemon's `GET /memory/scopes` lists the human's own principals,
   the critic and the shared store; the page adds the peers' principal agents from
   `GET /agents` as views that are listed but, per spec G.1 and S, not readable: a 403 from
   `GET /memory` shows as "not readable on this install", an empty answer as "a peer's private
   memory never syncs here". Consolidation proposals (spec G.4) are shown on the same page and
   answered in the inbox.
9. **The Updates page asks the feed first** (`GET /updates`) and falls back to
   `GET /updates/status` with a banner naming the feed error, so an offline machine still sees
   its version, the rejected releases and the rollback target.

## Consequences

- An older daemon never breaks a newer UI: the page says which route is missing and the rest
  of the app keeps working. The reverse (a newer daemon with a field the UI does not know) is
  covered by zod's default of dropping unknown keys.
- The fake daemon mirrors the real handlers for reviews, memory, commands and the change log
  (one card and one row per request, medium needs a yes or a tap, high needs the device, the
  `SOURCE_OF` mapping `text → chat`, `voice → voice`, `phone → chat`), so the UI tests exercise
  the same decisions the daemon makes.
- The daemon's `POST /commands/execute` body has no `ui` source yet (`text | voice | phone`),
  so a change made from the settings screen is logged with source `chat` and the words
  `Settings: <key> to <value>`; adding `ui` to the body and to `SOURCE_OF` is a daemon change
  listed under Known issues in `docs/maintainers/apps.md`.
- The proposed routes (queue, milestones, data, docs, performance) are a precise request to
  the daemon: paths, verbs and view schemas are in `PROPOSED_ROUTES` and the fixtures.

## Alternatives considered

- **Hiding tabs whose route is missing.** Rejected: the spec's tab list is fixed and a hidden
  tab reads as a bug; a named missing route reads as "update the daemon".
- **Importing the runtime's schemas into the browser bundle.** Rejected: `update/screen.ts`
  and `models/watch.ts` pull Node modules; a test-time comparison catches drift just as well.
- **A chart library.** Rejected: two small charts do not justify a dependency, and the
  dependency list is fixed for this work.
- **Separate tabs for the queue, peers and decisions.** Rejected: spec K.2 names eight tabs;
  the three are small lists that belong next to the summary.
- **Sending `confirm: "tap"` on the first execute from the settings screen.** Rejected: the
  human must see the card before the change; the first call shows it, the second confirms.
