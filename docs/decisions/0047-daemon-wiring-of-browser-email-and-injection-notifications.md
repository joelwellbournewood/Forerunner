# 0047 — Daemon wiring of the sandboxed browser, agent email and the injection notification

Date: 2026-10-20
Status: accepted

## Context

The sandboxed browser (ADR 0014, `packages/capabilities/src/browser`) and agent email (ADR 0013,
`packages/capabilities/src/email`) were built and reviewed as modules with ports, and the
notification module (ADR 0017, ADR 0038) had a producer for prompt injection
(`producers.injectionFlagged`) that nothing in the daemon called. Scenario 6 of the release
suite ("a web page and an email both try to hijack an agent; both are reported and ignored")
therefore assembled the wiring by hand in `tests/e2e/src/scenario-capabilities.ts` and
`docs/maintainers/testing.md` listed the gap as a known issue: `composeRuntime` registered
neither the browser tools nor the email tools, and no `injection_flagged` run event reached
the human. Putting the two capabilities into the one composition root (ADR 0029) and closing
the notification gap left points open that neither module's doc decides: when a run is
offered the tools at all; what the browser's per-run binding is read from inside the daemon;
where a project's site allowlist lives and how it reaches a run token whose registry entry
names no domains; whether an install without Chromium has a browser; which ports the email
tools and the notifier's email channel share; and what a notification about flagged content
may carry.

## Decision

1. **Presence per run, enforcement per call.** `toolsForRun()` (and the session grant) offer
   the eight `browser_*` tools only while the `browser` capability row is installed and
   enabled (added from the catalog, approved in the inbox, neither pending nor errored: the
   same reading as desktop control's binding, `extensionRowEnabled`), and the four `email_*`
   tools only while the agent's email settings row names a mailbox and the mode is not `off`.
   Both switches (`CapabilityPresence`, `src/wiring/browser-ports.ts`) are re-read at every
   session start (`startSession` calls `rt.capabilities.refresh()` before the runner starts),
   on every extension event of the `browser` row, and on demand. A run in flight keeps its
   tools but not its authority: the extension gate refuses a browser tool once the row is
   toggled off, the registry revokes the run tokens that carry the names, and the
   `BrowserSessionManager` revokes its sessions on the same event; the email policy reads the
   mode on every call. "Absent, not failing" therefore holds at run start, and "refused and
   audited" for whatever changed under a running session. A registry entry that names a
   capability tool while the capability is off gets one `registry.tool_unmapped` row
   (`unavailable`) at compose, as any unregistered name does (ADR 0043), and the name once the
   capability is on; the registry's own researcher still names `cc:WebFetch`, which stays
   unmapped on the loop driver.
2. **Browser mode: Chromium or the static reader, decided at compose.** `browserModeFor`:
   `ComposeOptions.browser.mode` (tests), else `FORERUNNER_BROWSER_MODE` (`static` |
   `chromium`), else `chromium` when `resolveChromiumExecutable` finds one and `static`
   otherwise. No launch is probed at compose (seconds and a display); a Chromium that exists
   but cannot launch surfaces as the first navigation's error, audited by the hooks. The
   static mode is the browser module's own `staticBrowserTools` (`src/browser/static.ts`,
   moved from the scenario's helper): the same eight specs with the same names, classes,
   risks, schemas and `domainFields` (so the token and the gate decide before anything runs),
   `browser_navigate` as an HTTP fetch after the same `SitePolicy.assert`, redirects followed
   hop by hop through the policy under `MAX_REDIRECT_HOPS` and never by `fetch` itself, the
   body capped, `browser_read` as `extractFromHtml` returning the same untrusted envelope, and
   every other tool refusing with `not_supported` (there is no page to click or type into).
   Each navigation and read is an audit row through the same port as the session's.
3. **The binding is the run token.** `browserBindingResolver` reads the run's live claims
   from the issuer (`TokenIssuer.claimsForRun`, new: the newest unrevoked, unexpired token of
   the run) for the allow list and the token id, the project's `settings.browser.blockedDomains`
   as the block list, and the autonomy level from the project (the human's default without
   one). A run whose token the issuer does not hold gets no domain and its first navigation is
   refused by the policy. The hooks already refused a URL outside the token (`domainFields`);
   the session policy covers subresources, redirects and WebSockets with the same patterns.
4. **The project's site allowlist is `settings.browser.allowedDomains`.** It joins the
   session grant's domains (next to the git host's) when the session has a project. Because
   `TokenIssuer.derive` only narrows, a registry entry's `allowed_domains: []` would leave a
   run without any site; the composition therefore passes `specialistSpecFrom` an
   `extraDomains` hook that adds the union of every project's allowlist to an entry that
   names a browser tool (and to no other entry: `[]` still means no network for a coder's
   sandbox). The derived run token caps that union to the session's project, so nothing is
   widened beyond the session grant. The union is re-read with the presence switches.
5. **One set of email ports.** `agentEmailPorts` (`src/wiring/email-ports.ts`) builds the
   settings store, identity, sent log, approval port, policy, event sink and the mailbox
   (opened by reference from the vault on first use, `mailboxFactory` in tests) once;
   `emailTools` and the notifier's `EmailChannel` (`notificationEmailPort`, now taking the
   ports) share them, so one connection and one policy serve both. The mode, the caps, the
   blocked content, the signature and the sent log stay the policy's per call; the composition
   decides nothing about a send.
6. **Every `injection_flagged` run event is one audit row and one urgent notification.** The
   composition listens on the runtime bus's `run` events, which both drivers' events reach
   through the executor's `onEvent`, and per run and tool (deduplicated for the life of the
   run; a retry is a new run) appends `injection.flagged` (`INJECTION_FLAGGED_AUDIT`,
   `allowed: true`: the content was wrapped as data and ignored, nothing was refused; the
   source, the rules, the counts and the score in the summaries) and calls
   `producers.injectionFlagged` with the session and project of the run. The producer's body
   is now `summarizeInjection`: the origin, the source, the number of passages and the rules
   with their counts, never the passages themselves, because a notification travels through
   channels (a toast's argv, a Telegram message, an email) where the flagged text has no
   business; the quoted passages are in the tool call's own audit row and the session log the
   notification links to, which is where spec S.2's "quoted to the human" is met.
7. **The catalog names the real tools.** The `browser` entry lists the eight `browser_*`
   tools with the classes `read`, `routine_reversible` and `credential`; the `email` entry
   lists the four `email_*` tools with `read`, `routine_reversible` and `external_send`. The
   gate checks an installed row against these; a manifest from a URL can no longer claim them
   because they carry no `<name>.` prefix.

## Consequences

- `RuntimeApp.capabilities` exposes the browser mode and manager, the email ports, both
  presence switches, the project allowlists in force and `refresh()`; `close()` closes the
  browser sessions. `ComposeOptions.browser` (mode, fetch, launch timeout) is the test seam;
  the email seam stays `notifications.mailboxFactory`.
- A fresh install has no browser and no email until a human adds the capability and configures
  the mailbox; nothing is granted by default (spec S.6).
- The daemon has no email settings route yet (the settings store is written by the capability
  routes mounted elsewhere, the CLI or a test); a change to the mode or the mailbox is picked
  up at the next session start.
- `tests/e2e/src/scenario-capabilities.ts` keeps its own copy of the static reader and its
  own wiring until the scenario is pointed at `composeRuntime`; `testing.md`'s known issue is
  closed on the runtime side.
- Not done: a runtime fallback from a Chromium that fails to launch to the static reader; run
  events of the critic and the conversation agent (they run the driver outside the executor
  and raise no `run` bus event, so a flagged read there is logged by the hooks but produces no
  `injection.flagged` row and no notification: S.2's notification covers executor runs); a
  per-agent block list (the project's is read); a reconcile of installed catalog rows against
  the catalog's tool names (a `browser` or `email` row installed under the old names keeps
  them until it is removed and re-added; `browser.md` and `email.md` Known issues).
- `TokenIssuer.claimsForRun` orders two tokens of one run issued in the same millisecond by
  issue order (the later one wins), so a re-issue under a simulated or tied clock never
  resolves to the older token.

## Alternatives considered

- Registering the browser and email tools unconditionally and letting the gate refuse them
  (the desktop pattern alone): the model would be offered tools every call of which fails, and
  a registry entry would carry names that can never run; presence per run start keeps the
  offer honest while the gate still covers runs in flight.
- Launching Chromium at compose to decide the mode (the scenario's `probeBrowser`): seconds
  on every daemon start and a display requirement on a headless runner, for a decision the
  first navigation makes anyway.
- Inheriting the session's domains whenever a registry entry names none (one line in the
  executor): would hand every coder's sandbox the git hosts and the project's sites; the
  union-then-cap hook touches only entries that name a browser tool.
- Keeping the quoted passages in the notification body (the producer's previous
  `describeInjection`): the spec's "quoted to the human" is met by the session log and the
  audit row; a toast or a Telegram message is not the place for text designed to steer a
  model.
