# Extensions registry and MCP connector catalog

`packages/runtime/src/extensions`: the Extensions panel's backend (spec K "Extensions panel",
L "Connectors", phase 6). Connectors (MCP servers), skills, specialists, capabilities and
model providers are `extension` rows with a status, permissions, cost, version and source.
Installing or widening a grant is "granting a new capability" and always needs a human;
nothing from outside the built-in catalog is started, and no secret is resolved, before the
human says so. Disabling or removing revokes live. ADR 0016 covers how MCP tools become
ToolSpecs, how classes are inferred and who may be started for discovery.

## Purpose

- One place that lists every capability an agent can reach, what each one may do (tools,
  action classes, domains, paths, secrets, scopes), what it has cost, and a toggle, remove
  and add-from-catalog-or-URL for each (K.6).
- MCP servers installed from a catalog or a URL, reviewed and permissioned on install (L.5).
- Every grant shows its scopes and the shown grant is the enforced grant; least privilege
  (S.5). Granting a new capability, and starting a program with a secret, needs a human at
  any autonomy level (S.6, S.4). Every change is an audit row and an event (S.9). Every
  capability can be revoked live from the panel (phase 6 gate), and a global stop kills
  connector processes too (S.8).

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | zod shapes: `ExtensionPermissions`, `PermissionReview`, `ReviewedTool`, `ExtensionView`, kinds, statuses, grant stages, the approval port, events, `widens()` |
| `catalog.ts`, `catalog.json` | the built-in catalog, `CatalogEntry`/`CatalogFile` schemas, `ConnectorTransport` (stdio argv or http), bounded `fetchJson`, remote catalog fetch and `ExtensionCatalog` (`isBuiltin`) |
| `mcp.ts` | `McpConnector` (connect, list tools and resources, `review()`, `bridgeTools()`, `callTool()`, `close()`, `child`), `StdioMcpTransport` over the platform shell, class and field inference, `assignBridgedNames`, `withoutSecretRefs`, `toolPrefixOf`/`ownsToolName`, `DefaultMcpConnectorFactory` |
| `approvals.ts` | `HumanRequestExtensionApprovals` (production port over `HumanRequestRepo`) and `MemoryExtensionApprovals` (tests) |
| `registry.ts` | `ExtensionRegistry`: list, get, add from catalog or URL, approve/deny (two stages), toggle, remove, updatePermissions, recordCost, start/close, bridged tools, tool ownership index, `enabledCatalogEntries(kind?)` (the enabled catalog rows with their entry, for the voice preferences); `grantedToolNames()`, `extensionCostKey()`, `ledgerCostByExtension()`, `KillPort`, `EXTENSIONS_KILL_AGENT` |
| `gate.ts` | `ExtensionGate.check()`, `GatedEnforcementHooks` (hooks with the gate in front of `beforeToolCall`), `gateTool()` |
| `routes.ts` | `createExtensionsRoutes(deps)`: the Hono sub-app for the panel |

### Kinds and statuses

Kinds (`EXTENSION_PANEL_KINDS`): `connector` (an MCP server; the state alias `mcp_server` is
shown as a connector), `skill`, `specialist`, `capability` (browser, email, desktop control,
cloudflare, voice providers), `model_provider`. `(kind, name)` is unique.

**Voice rows (spec O.4).** Enabling a `voice-*` capability is how the human chooses a voice
provider: `enabledCatalogEntries("capability")` hands the enabled installed rows with their
catalog entry (a fresh read each call) to `src/voice/providers.ts`, which takes the entry's
`voice` provider names and the row's granted `secrets` and resolves the preferred STT and TTS
at every voice status read and session start (`voice.md`, "Which provider is preferred").
A pending, disabled or errored row, or one whose entry left the catalog, is not listed.

Panel status is derived from the row: `pending_approval` while `extension.status` is
`pending_approval` (the view's `pendingStage` says whether the human is asked to allow the
discovery start or the grant); `error` while it is `error` (the last error is in
`config.error`); otherwise `enabled` or `disabled` from `extension.enabled`.

### Permissions

`extension.permissions` is an `ExtensionPermissions` object: `tools` (bridged tool names),
`actionClasses`, `domains` (hostnames or `*.example.com`; never `*`), `paths` (absolute roots),
`secrets` (names only, never values), `scopes` (human-readable lines shown as granted). An
invalid blob parses as no permissions (fail closed). Empty `domains`, `paths` or
`actionClasses` means "no ceiling beyond the run token"; a non-empty list is a ceiling the
gate enforces on top of the token. `grantedToolNames(permissions, review)` is the tool set
in force: `tools` minus those whose reviewed class is outside `actionClasses`; it decides what
is bridged and which tokens a narrowing revokes, so the panel and the gate agree.

**Ownership.** A grant may name a tool only when no other extension row grants or has it
pending, it is not one of the daemon's built-in tools (`ExtensionRegistryDeps.reservedTools`),
and, for connectors, for anything installed from a URL or a remote catalog, and for every
tool added through `updatePermissions`, it starts with the extension's own prefix
(`toolPrefixOf(name)`, e.g. `fake.`). Built-in catalog entries may declare their module's
names (`browser.open`) without the prefix. Violations are `validation` errors before any row
is written, so a manifest cannot shadow or re-ceiling another extension's tools and
disabling one extension never refuses another's.

### Review and approval flow

1. `addFromCatalog(id)` or `addFromUrl(url)` (a URL serving a JSON manifest, i.e. one
   `CatalogEntry`, or else a streamable-HTTP MCP endpoint). Only a **built-in catalog entry**
   (`catalog.isBuiltin(id)`) is started for discovery at this point, and only **without its
   secrets**: `withoutSecretRefs()` drops every `secret:` env or header entry and the granted
   set is empty, so nothing is resolved. Tools and resources are listed, `buildReview()`
   infers each tool's class, risk and path/domain fields (ADR 0016), adds the transport's
   host, absolute path arguments and secret *names*, merges the entry's declared permissions,
   and the connection is closed. Other kinds get a review from their declared permissions.
2. A manifest from a URL, a remote catalog entry, a bare endpoint URL, and a built-in entry
   whose secret-free start failed, are **not started**. Their review is the declared
   permissions plus `runs <command> <args>` / `connects to <url>`, `uses secret:<name>` and a
   "not started yet" note, and the row is inserted at `pendingStage = "discovery"`.
3. The row is inserted with `status = pending_approval`, `enabled = false`, the review's
   permissions, the source (`catalog:<id>` or the URL) and the review and stage in `config`.
   Tool names are checked for ownership first. Audit row `extensions.add` (with `stage` and
   `trusted`), event `extension.requested`.
4. `ExtensionApprovalPort.ask()` is called with the stage. In production
   (`HumanRequestExtensionApprovals`) this inserts a blocking, high-risk `human_request` of
   kind `approval` whose `steps` are the review's summary lines (first line: the step) and
   whose `options` are `approve` (with the stage, permissions and review) and `deny`; the row
   stays pending. The inbox answers it; `syncApprovals()` (call it from the daemon loop) reads
   the answer through `port.status()`, or the panel calls `POST /extensions/:id/approve|deny`.
5. Yes at stage `discovery` → `approve()` audits `extensions.approve_discovery`, starts the
   server once with the secrets the transport names (now granted for that start), lists its
   tools, checks ownership, stores the full review (`extensions.discovered`,
   `extension.discovered`), moves the row to `pendingStage = "grant"` and asks again. A
   failure leaves the row pending at `discovery` with the redacted error in `config.error`
   and clears the request id so the sync loop does not retry; `approve` again retries.
6. Yes at stage `grant` → permissions applied, `enabled = true`, status `installed`, the
   connector is connected with the granted secrets and its tools bridged (audit
   `extensions.approve`, events `extension.approved` and `extension.enabled`). No →
   `deny()`: a fresh install (either stage) is deleted; a re-permissioning keeps the previous
   grant and leaves the extension disabled.

`updatePermissions()` compares with `widens()`: anything new (tool, class, domain, path,
secret, scope) makes the row pending again at stage `grant`, revokes live and asks; pure
narrowing applies at once, revokes tokens that list a tool no longer granted (by name or by
class) and re-bridges. Added tool names must pass the ownership rule. `toggle(true)` on a
pending row throws `approval_required`; re-enabling an installed row never asks again.
`syncApprovals()` returns `{ approved, denied, discovered }` (`discovered`: a discovery yes
that is now waiting for the grant).

### Live revocation and the kill switch

`toggle(false)` and `remove()` call `revokeLive()`: `TokenRevoker.revokeWhere()` (the
`TokenIssuer` the kill switch holds) revokes every run token whose `allowedTools` includes one
of the extension's tools, and the MCP connection is closed. A run holding a revoked token fails
its next hook with `killed`; a new token is refused by the gate for that tool. The event
carries the revoked token ids. The run's own kill switch registration is untouched.

Every open connection is registered with the kill switch (`ExtensionRegistryDeps.kill`,
`KillSwitch.register`) as `agentId: "extensions"`, `sessionId: "extension:<id>"`, with an
abort controller and, for stdio servers, the child process. `stop("all")` kills the process
tree (`killTree`) and aborts the controller; the registry closes the client one macrotask
later (after the kill switch's loop), so `connected` turns false and the bridged tools are
gone. A scoped stop (one agent or session) does not touch connectors: they are shared, and
that agent's tokens are revoked by the stop itself. While the switch is frozen a connection
opened by `toggle`, `approve` or `start()` is aborted at once. After `resume()` call
`registry.start()`: it reconnects every enabled connector that is not connected.

### The gate

`ExtensionGate.check(tool, ctx)` finds the tool's extension (`extensionId` on a bridged
spec, else the ownership index built from every row's granted and pending `permissions.tools`),
reads the row fresh and throws `ForerunnerError`: `tool_not_allowed` when the extension is
disabled, in error, removed, no longer grants the tool by name, or grants classes that do not
include the tool's `actionClass`; `approval_required` while pending; `domain_not_allowed` or
`path_not_allowed` when the input's URL or path fields fall outside the extension's own
ceilings. Denials are audited with the token id. Tools that belong to no extension pass.
`GatedEnforcementHooks` is `EnforcementHooks` with the gate in front of `beforeToolCall`; the
drivers take it in place of the plain hooks. `gateTool()` wraps a spec's `execute()` for
callers that bypass the hooks. A bridged tool whose connection was closed refuses every call
by itself.

### Secrets

Transport `env` (stdio) and `headers` (http) values may be `secret:<name>` references. They
are resolved only in `McpConnector.connect()` through the `SecretsPort` (`SecretResolver` over
the vault in production), with the granted set = the approved `permissions.secrets`, or, for
the discovery start the human allowed at stage `discovery`, the names the transport references.
Discovery before any yes runs with the references stripped and nothing granted. The resolved
values live in the transport; rows, reviews, human requests, events, audit rows and log lines
carry names only, and tool output is redacted with the same resolver. A missing vault value
puts the extension in `error` with the message, never the value. A reserved name
(`forerunner.*`, the install wrapping key; `RESERVED_SECRET_PREFIX` in `@forerunner/vault`) in
an entry's `permissions.secrets` or as a `secret:` reference in its transport is refused with
`secret_reserved` at add (no row, nothing started, nobody asked), at every approval and at a
re-permissioning (`refuseReservedSecrets` in `registry.ts`); the hooks' resolver and the token
issuer refuse the same names again.

### Processes

`StdioMcpTransport` spawns the server through `@forerunner/platform` `spawnProcess` (argv
arrays, never a shell string; `.cmd` shims such as `npx` go through `cmd.exe /c` on Windows),
with the SDK's default safe environment plus the resolved env, stderr drained and dropped.
`close()` ends stdin, sends SIGTERM and kills the tree after 2 s. The connector exposes the
`ChildProcess` as `child` for the kill switch.

### Cost

`extension.cost_usd_micro` is the counter; `recordCost(id, usdMicro)` increments it (call it
from `afterToolCall` with `result.costUsdMicro` for bridged tools, or from a capability
module). `cost_ledger` has no extension column: a capability module that charges through the
ledger on behalf of an extension writes `specialist = extensionCostKey(id)` (`extension:<id>`),
and `ledgerCostByExtension(store.costLedger)` is the `ExtensionRegistryDeps.ledgerCost` that
sums those rows into the view. Views show `{ usdMicro, chfMicro }` (counter plus ledger) at
`chfPerUsd()`. Bridged MCP calls carry no price of their own, so a connector's cost stays 0
until a capability module charges through the ledger.

### Catalog format

`catalog.json` is `{ "version": 1, "entries": [CatalogEntry, …] }`. An entry: `id`
(`[a-z][a-z0-9-]*`, unique), `kind`, `name`, `description`, `version`, optional `homepage`,
`transport` (connectors only: `{ type: "stdio", command, args, env, cwd? }` or
`{ type: "http", url, headers }`), `module` (what implements a capability or provider),
`permissions` (declared, same shape as the row), optional `requiresAutonomy`, optional
`voice` (capabilities only: `{ stt?: [names], tts?: [names] }`, the voice registry's provider
names the entry stands for, in order of preference; at least one side), `tags`. The
built-in file ships browser, email, desktop-control, cloudflare, voice-local,
voice-deepgram, voice-cartesia, voice-elevenlabs, anthropic, mcp-filesystem, mcp-fetch and
mcp-github. A remote catalog (`FORERUNNER_EXTENSION_CATALOG_URL`, or
`ExtensionCatalogOptions.remoteUrl`) is fetched by `ExtensionCatalog.refresh()`; its entries
never override built-in ids and are not trusted for an early start (`isBuiltin()` is false).
Nothing in the catalog names an org, host or user path.

`fetchJson` (manifests and remote catalogs) refuses a `content-length` above `maxBytes`
(1 MB) before reading, and otherwise reads the body chunk by chunk, aborting the request as
soon as the count passes the cap; a 10 s timeout applies. It follows redirects and accepts
any http(s) host, loopback and private ranges included: the URL is one the human typed or
configured, and a manifest can only ever lead to a pending row (see "Known issues").

### Routes

`createExtensionsRoutes({ registry, actor })` returns a Hono sub-app; mount it with
`app.route("/", …)` behind the daemon's bearer check. `actor(c)` names the human for audit
rows.

| Route | Body | Result |
| --- | --- | --- |
| `GET /extensions?kind=` | | `ExtensionView[]` |
| `GET /extensions/catalog` | | `{ remoteUrl, entries }` |
| `GET /extensions/:id` | | `ExtensionView` |
| `POST /extensions` | `{ catalogId }` or `{ url }` | 201 enabled, 202 pending (`pendingStage` says which step) |
| `POST /extensions/:id/toggle` | `{ enabled }` | `ExtensionView` |
| `POST /extensions/:id/approve` | | 202 after a discovery yes (grant still open), 200 enabled |
| `POST /extensions/:id/deny` | | `{ ok }` |
| `PUT /extensions/:id/permissions` | `{ permissions }` (partial) | 200 applied, 202 pending |
| `DELETE /extensions/:id` | | `{ ok }` |

Errors are `{ code, message, details }` with 400 validation (including an already installed
entry and a tool name the extension may not claim), 403 approval or allowlist codes, 404,
409 version conflict, 503 unavailable.

### Wiring (for the orchestrator)

```ts
const catalog = new ExtensionCatalog(loadBuiltinCatalog(), { remoteUrl: catalogUrlFromEnv() });
const registry = new ExtensionRegistry({
  extensions: store.extension, audit: store.auditLog, clock, catalog,
  approvals: new HumanRequestExtensionApprovals(store.humanRequest),
  connectors: new DefaultMcpConnectorFactory(), secrets: secretResolver, tokens: tokenIssuer,
  kill,                                        // connector processes die with stop("all")
  reservedTools: () => builtinTools.names(),   // names no extension may claim
  events: (e) => sse.broadcast(e), chfPerUsd, ledgerCost: ledgerCostByExtension(store.costLedger),
});
await registry.start();                       // reconnect enabled connectors; again after kill.resume()
const gate = new ExtensionGate({ registry, clock, audit: store.auditLog });
const hooks = new GatedEnforcementHooks(hookDeps, gate);
for (const t of registry.bridgedTools()) toolRegistry.register(t);   // per run
app.route("/", createExtensionsRoutes({ registry, actor: () => ({ humanId }) }));
```

## How to change it

- New built-in capability: add an entry to `catalog.json` (the test asserts the file
  validates); the module that implements it registers tools under the names the entry lists;
  no other entry may list the same names.
- New transport: extend `ConnectorTransport` in `catalog.ts` and `defaultTransportFactory` in
  `mcp.ts`; keep secret resolution in `resolveTransportSecrets` and expose the child process
  (`ProcessTransport`) when one exists; keep `withoutSecretRefs` in step.
- Class inference: edit `PATTERNS` and `CLASS_RANK` in `mcp.ts` and the table in ADR 0016
  together; add a row to the inference test (name, annotations, class, `inferredFrom`).
  Annotations may only tighten.
- New panel field: add it to `ExtensionView` (zod) and `ExtensionRegistry.view()`.
- Never let a path apply permissions without `widens()`; never bridge a tool that is not in
  `grantedToolNames()`; never start a transport with a resolved secret outside `approve()`
  (stage `discovery`) and `open()`; never grant a name without `assertToolsOwned`.

## Tests

`packages/runtime/test/extensions-*.test.ts` (shared fixtures in `extensions-helpers.ts`: an
in-process MCP server with two tools and one resource over `InMemoryTransport`, optionally
refusing to start without its secret; a dependency-free stdio MCP server as a `node -e`
script that ignores SIGTERM; a stateless streamable-HTTP server on 127.0.0.1 with custom
handlers; `sqlite::memory:` store, `SimulatedClock`, `MemoryExtensionApprovals`, a `KillSwitch`
and reserved tool names wired into the registry, a `MemoryVault` whose only value is built by
concatenation):

- `extensions-catalog.test.ts`: built-in catalog validates and lists the shipped
  capabilities and the `voice` provider names of the `voice-*` entries (and none elsewhere);
  a `voice` field on a non-capability, or naming no provider, is rejected; bad entries rejected; remote catalog over `node:http` merges without
  overriding built-ins and is not built-in; env URL; `fetchJson` refuses by content-length and
  cuts a chunked stream at the cap.
- `extensions-mcp.test.ts`: inference table (name first, annotations only tighten, conflicts
  recorded), conflict flagged in the summary, colliding names renamed deterministically,
  prefix helpers, `withoutSecretRefs`, field inference, schema, review contents, bridged
  ToolSpecs (extension id, untrusted output, grant and class filters), secrets resolved at
  spawn and absent from every log line, ungranted secret refused, closed connection refuses
  calls, unreachable server is `unavailable`; `StdioMcpTransport` with a real child process:
  pid exposed, tools listed, env seen by the server, secret-free spec leaves it unset, `close()`
  kills a server that ignores SIGTERM, missing command is `unavailable`.
- `extensions-registry.test.ts`: install pending before yes with the review in the request,
  discovery of a built-in entry without secrets; yes enables, connects (now with the secret)
  and bridges; no deletes; capability install with scopes; concurrent adds → one row and a
  `validation` error; **nothing from outside the built-in catalog starts before a yes**: a URL
  manifest naming its own command and a secret stays at stage `discovery` with no transport
  built and no value anywhere (requests, rows, audit, logs), the discovery yes starts it with
  the secret and asks for the grant, the second yes enables; a remote catalog entry likewise,
  and a no removes it; a built-in entry that needs its secret to boot is asked first; a
  discovery failure after the yes stays pending with the redacted error and is retried by
  `approve`, not by the sync loop; disable revokes tokens and closes, re-enable needs no
  approval; remove; narrowing by name and by class applies at once (not bridged, tokens
  revoked, shown as granted), widening pends, deny keeps the old grant; ownership: no tool
  outside the prefix via `updatePermissions`, no shadowing of `browser.open` from a URL
  (installed or not), no built-in tool name; cost in CHF, counter plus ledger rows; connect
  error → `error`; `start()` reconnects and is idempotent; add from URL (manifest: two yeses;
  bare endpoint: no connection before the yes, reviewed live after it);
  `HumanRequestExtensionApprovals` round trip with the stage; audit rows and events for every
  change; no secret value in rows, requests, audit rows or logs on the install, approve,
  toggle, error and remove paths; an entry that declares or references the install wrapping
  key refused at add (catalog and URL manifest) and at `updatePermissions` with
  `secret_reserved`, nothing started, nobody asked, the grant unchanged.
- `extensions-gate.test.ts`: approved tool runs through `GatedEnforcementHooks` and is wrapped
  as untrusted; pending → `approval_required` (audited); disable → `tool_not_allowed` in code
  and a running run's token revoked live (next hook `killed`, its kill switch registration
  still counted); removed → refused; extension domain/path ceilings; non-extension tools pass;
  `gateTool()`; narrowing the classes refuses `fake.post_comment` in code while `fake.fetch_page`
  passes; `stop("all")` closes every connector, a scoped stop does not, a frozen switch cuts a
  reopen off, `start()` after `resume()` reconnects; `stop("all")` kills a real stdio
  connector's process tree (`killedProcesses: 1`) and the client closes.
- `extensions-routes.test.ts`: every route, status codes, 202 on `approve` after a discovery
  yes, audit trail with the actor.

Run: `pnpm vitest run --project unit packages/runtime/test/extensions-*.test.ts`.

## Known issues

- `addFromUrl` fetches the URL the human typed (manifest probe) before any approval, and
  `fetchJson` accepts loopback and private addresses: a daemon-side request to an address the
  human chose. It yields at most a pending row; nothing is started from it. If the daemon ever
  takes URLs from a non-human source, add an address filter in `fetchJson`.
- The kill switch skips a child whose `killed` flag is already set; the registry therefore
  closes the client one macrotask after the abort so the switch's own `killTree` runs first.
  A connector closed by a global stop is reconnected only by `registry.start()` (call it after
  `resume()`); the row stays `enabled` meanwhile with `connected: false`.
- `cost_ledger` has no extension column; cost is the row counter plus the ledger rows that
  name the extension in `specialist` (see "Cost"). Bridged MCP calls report no price of their
  own. `list()` runs the ledger breakdown once per row; fine for a panel, not for a hot path.
- Revocation is per token: a run that holds a token listing the extension's tool stops
  entirely (its token is revoked), not only for that tool. This is deliberate for a live
  revocation; the session can be resumed with a new token.
- Re-permissioning that widens disables the extension until the answer; the panel should say
  so.
- Skills and specialists are catalogued as rows only; their loader (`src/registry`) does not
  yet consult the registry for enabled state.
- Legacy rows that share a tool name (written before the ownership rule) resolve to the
  oldest row; new grants cannot create such a collision.

## Requirements covered

K.6 (Extensions panel: status, permissions, cost, version, toggle, remove, add from catalog
or URL), L.5 (connectors from a catalog or URL, reviewed and permissioned on install), S.4
(secrets by reference: never resolved before the human allowed the start, never in rows,
requests or logs), S.5 (each grant shows its scopes and the shown classes are enforced), S.6
(granting a new capability, and starting a program with a secret, always needs a human), S.3
(bridged tools are enforced by the run token and the hooks), S.8 (live revocation uses the
same token revocation as the kill switch; connector processes are registered with it), S.9
(every change audited), U.16 (the `extension` table), O.4 (voice providers chosen in the
panel: catalog entries), M.5 partial (connector versions are shown; the updates screen is
phase 7).
