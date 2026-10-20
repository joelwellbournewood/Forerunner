# 0014 — Browser policy enforcement points and what the browser never does

Date: 2026-10-20
Status: accepted

## Context

The spec gives the sandboxed browser (module L, "Browser and desktop control", "Rules that
apply everywhere") an isolated profile per agent, a site allowlist and blocklist, approval
before purchases and credential entry, content as data, live revocation and an audit row per
action. It leaves open where exactly the site policy is enforced and how far "a host outside
the allowlist" reaches. Three facts about the tools decide that:

1. Playwright's request interception (`context.route`) is called once per request Chromium
   starts, but not for the requests Chromium issues itself while following a redirect, and not
   for the request that follows a redirect answered through `route.fulfill`. A plain
   `route.continue()` policy therefore lets `allowed.example/redir -> blocked.example` through
   for documents and subresources alike. Measured on Playwright 1.64 / Chromium 156.
2. A document answered from interception carries no network address. Chromium's
   local-network-access check then treats it as public and refuses the real connections that
   remain (WebSockets, event streams) to loopback and LAN hosts, such as a local dev server.
   Chromium honours only the last `--disable-features` flag on its command line and Playwright
   does not merge a caller's flag into its own, and the headless shell exposes no way to read
   the command line it was given.
3. Whether a click is a purchase or a keystroke is a password is a property of the page
   element, not of the tool, so the runtime's per-tool action classes cannot decide it alone.
4. A human's "yes" to a purchase is an answer to one order. A session that remembered it
   would let one answer place any number of identical orders (double order, re-order after a
   cart change); the first review of this module found exactly that.
5. The runtime compares token domains as hostnames (`domainCovered`, `domainAllowed`). Any
   pattern syntax the browser alone understood would be unreachable through the tools.

## Decision

**Enforcement points**, all in code, each one sufficient on its own for what it covers:

| Point | Covers |
| --- | --- |
| `SitePolicy.assert(url)` before `page.goto`, before every download hop and before following every redirect stub; audited when it refuses | what the model asked for |
| runtime hooks on `domainFields` of `browser_navigate` and `browser_download` | the same, against the token before the tool runs |
| `context.route("**/*")`, once per agent browser, resolving the owning session per page | every HTTP(S) request of every frame; unowned pages get nothing |
| the route answers each allowed request itself with redirects disabled (`route.fetch({ maxRedirects: 0 })`): a 3xx to a host outside the policy is aborted; an allowed 3xx becomes a redirect stub for documents (the session follows it as a fresh routed navigation after `assert`) and is followed hop by hop, at most ten, for subresources | redirect chains |
| `page.routeWebSocket("**/*")`: close with 1008 before the handshake or connect and forward | WebSockets |
| `serviceWorkers: "block"` at launch | nothing answers requests behind the route |
| a final check of `page.url()` after navigation | a page that still ended outside the policy |
| the route records every main-frame document redirect it answers with a stub (`PendingRedirect`) with the owning session, before serving the stub; the session follows only that record, after `assert`, and only while the page still shows the stub; the stub's attribute is informational | what the session follows; a page cannot steer it |
| site patterns are hostnames exactly as the token carries them (`normaliseHostPattern`): a scheme, path or `:port` is a `validation` error; `browser-policy.test.ts` checks the policy against `domainAllowed` and `domainCovered` on one list of URLs | the policy and the hooks agree on every URL |
| `GuardEnforcer` per element through a small approval port (`BrowserApprovalPort.ask`), backed by `HumanRequestRepo` in production and a fake in tests; action classes credential and financial are always-human, personal data and terms free from autonomy 4, decided by the runtime's `decideAutonomy` | purchases, credentials, payment fields, personal data, terms |
| an approval for a credential, payment or purchase action is spent by that action: the enforcer caches none of them, `HumanRequestApprovalPort` hands an answered "yes" out once and marks the request spent (`change_card.consumedAt`, durable across restarts); a "no" stays denied; personal data and terms approvals are remembered per element and host | one answer, one action |
| `browser_fill_secret` is one card: the tool's `credential` class makes the hooks ask before `execute`, the tool passes `credentialApproved: true`, and `classifySecretFill` adds no second `credential` kind; the element's own kinds (payment, purchase or personal data on submit) are still asked | credential entry asked once, never skipped |
| values typed through `fillSecret` are scrubbed from `read()` and `describe()` results | a page echoing the password |
| `AuditPort.append` for every outward action and every approval ask, with token id | the audit log |
| `BrowserSession.revoke`, `AgentBrowser.revoke`, `BrowserSessionManager.revoke(scope)` and `attachKillSwitch` | live revocation: the page or the whole context closes at once, in-flight actions fail with `killed` |

Event sources and media are let through to the network after their host passed, because
buffering them would never finish. `LocalNetworkAccessChecks` is disabled; to do that without
losing Playwright's own disabled features, the module carries a copy of Playwright's list and a
unit test fails when the installed Playwright's list drifts from it.

**What the browser never does:**

- open the human's browser profile, the OS keychain or the human's own passwords; the profile
  is `data/browser/<agent>/`, the password store is `basic` with a mock keychain;
- grant a permission (geolocation, clipboard, notifications, camera, microphone) or open a
  popup or new window;
- send a request, follow a redirect, or open a socket to a host the policy does not cover, from
  any frame or resource type, or from a page no session owns;
- run `playwright install` or download a browser; a missing Chromium is `unavailable` and
  tests skip visibly;
- type a credential, a payment instrument or complete a purchase without a human's answer, at
  any autonomy level, and never two of them on one answer; or submit personal data or accept
  terms below autonomy 4 without one;
- put a secret value into a tool result, an approval card, an error, a log line or an audit
  row; `browser_fill_secret` takes a reference the runtime resolves;
- treat page content as instructions: visible text is wrapped as untrusted data and scanned,
  text a human cannot see is reported apart with the reason it is hidden, never merged; no
  attribute, script or text of a page decides where the session navigates next;
- understand a site pattern the token and the hooks do not (no port-qualified patterns);
- keep running after revocation or the kill switch: the context is closed, not asked to stop;
- hide its nature: the user agent carries a fixed suffix naming it an AI agent acting for a
  human.

## Consequences

- Every request is proxied through Playwright's Node fetch: bodies are buffered, HTTP/1.1,
  two extra round trips per request. Acceptable for an agent that reads pages and fills forms;
  not a general-purpose browser.
- A 307 or 308 answer to a document POST is followed as a GET (the stub cannot re-send a body).
  301, 302 and 303 behave as in a browser; cookies set on the redirect survive because the
  context's request API shares the browser's cookie jar.
- After the route aborts a document request Chromium commits its own error page a moment
  later; the session retries a navigation that this interrupts.
- A Playwright upgrade that changes its disabled-feature list fails a unit test until the copy
  is updated; one that changes `route.fetch`, `route.fulfill({ response })` or
  `routeWebSocket` fails the integration test.
- The cardholder's name (`autocomplete="cc-name"`) is personal data, not a payment instrument:
  typing it is free, submitting the form that holds it is a purchase.
- A retried purchase or password entry is a new card, by design; a human who approves a
  checkout flow answers once per order. A guard that asks from inside `execute` cannot pause
  the run as the hooks do; the model sees `approval_required` and retries after the answer.
- Two local test servers cannot be told apart by port; the integration test uses `127.0.0.1`
  and `localhost` on the loopback interface instead.

## Alternatives considered

- `route.continue()` with post-hoc detection of redirected requests through `request` events:
  detects the leak after the request was sent; rejected, enforcement must be before.
- Proxying document requests only and letting subresources through natively: closes the
  navigation hole, leaves `img -> 302 -> blocked host`; rejected, the gate says subresources.
- CDP response-stage interception (`Fetch.enable` at `Response`) beside Playwright's own
  routing: two interceptors on one target, undocumented interplay; rejected.
- Refusing every redirect: breaks ordinary sites (login flows, CDN paths); rejected.
- Reading Playwright's command line at runtime to merge `--disable-features`: `browser.process()`
  is gone in Playwright 1.64 and the headless shell refuses `chrome://version`; a static copy
  with a drift test was the honest option.
- Leaving local-network-access checks on and documenting that WebSockets to local dev servers
  fail: the policy is already the stricter rule; rejected in favour of the flag.
- A single always-human gate on every form submission instead of per-element guards: would make
  autonomy 4 meaningless for ordinary forms; the spec distinguishes the cases, so does the code.
- Remembering a purchase or credential approval for the session (the first version): one
  "yes" placed unlimited identical orders; rejected. A per-attempt nonce in the request key
  would have broken the pause-and-retry flow (the retry after the human's answer must find the
  answered request); marking the answered request spent keeps that flow and ends the replay.
- Reading the redirect target back from the stub's DOM attribute (the first version): any page
  could set the attribute and make the session throw or navigate elsewhere; replaced by the
  route's own record, which no page content can write.
- Port-qualified site patterns (`host:port`, the first version): narrower than the token, but
  unreachable through the hooks, which compare hostnames; adding ports to the runtime's
  `domainCovered` and `domainAllowed` in the same change was outside this module. Dropped, with
  a validation error so a port in a pattern is never silently ignored.
- Deduplicating the `browser_fill_secret` card inside the port by matching the runtime's
  approval key: depends on the hooks' hashing of tool input; rejected for the explicit
  `credentialApproved` flag that only the tool wrapper sets.
