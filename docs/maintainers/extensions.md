# Extensions registry and MCP connector catalog

`packages/runtime/src/extensions`: the Extensions panel's backend (spec K "Extensions panel",
L "Connectors", phase 6). Connectors (MCP servers), skills, specialists, capabilities and
model providers are `extension` rows with a status, permissions, cost, version and source.
Installing or widening a grant is "granting a new capability" and always needs a human.
Disabling or removing revokes live. ADR 0016 covers how MCP tools become ToolSpecs.

## Purpose

- One place that lists every capability an agent can reach, what each one may do (tools,
  action classes, domains, paths, secrets, scopes), what it has cost, and a toggle, remove
  and add-from-catalog-or-URL for each (K.6).
- MCP servers installed from a catalog or a URL, reviewed and permissioned on install (L.5).
- Every grant shows its scopes; least privilege (S.5). Granting a new capability needs a
  human at any autonomy level (S.6). Every change is an audit row and an event (S.9-style
  audit). Every capability can be revoked live from the panel (phase 6 gate).

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | zod shapes: `ExtensionPermissions`, `PermissionReview`, `ReviewedTool`, `ExtensionView`, kinds, statuses, the approval port, events, `widens()` |
| `catalog.ts`, `catalog.json` | the built-in catalog, `CatalogEntry`/`CatalogFile` schemas, `ConnectorTransport` (stdio argv or http), remote catalog fetch and `ExtensionCatalog` |
| `mcp.ts` | `McpConnector` (connect, list tools and resources, `review()`, `bridgeTools()`, `callTool()`, `close()`), class and field inference, `DefaultMcpConnectorFactory` |
| `approvals.ts` | `HumanRequestExtensionApprovals` (production port over `HumanRequestRepo`) and `MemoryExtensionApprovals` (tests) |
| `registry.ts` | `ExtensionRegistry`: list, get, add from catalog or URL, approve/deny, toggle, remove, updatePermissions, recordCost, start/close, bridged tools, tool index |
| `gate.ts` | `ExtensionGate.check()`, `GatedEnforcementHooks` (hooks with the gate in front of `beforeToolCall`), `gateTool()` |
| `routes.ts` | `createExtensionsRoutes(deps)`: the Hono sub-app for the panel |

### Kinds and statuses

Kinds (`EXTENSION_PANEL_KINDS`): `connector` (an MCP server; the state alias `mcp_server` is
shown as a connector), `skill`, `specialist`, `capability` (browser, email, desktop control,
cloudflare, voice providers), `model_provider`. `(kind, name)` is unique.

Panel status is derived from the row: `pending_approval` while `extension.status` is
`pending_approval`; `error` while it is `error` (the last error is in `config.error`);
otherwise `enabled` or `disabled` from `extension.enabled`.

### Permissions

`extension.permissions` is an `ExtensionPermissions` object: `tools` (bridged tool names),
`actionClasses`, `domains` (hostnames or `*.example.com`; never `*`), `paths` (absolute roots),
`secrets` (names only, never values), `scopes` (human-readable lines shown as granted). An
invalid blob parses as no permissions (fail closed). Empty `domains` or `paths` means "no
ceiling beyond the run token"; a non-empty list is a ceiling the gate enforces on top of the
token.

### Review and approval flow

1. `addFromCatalog(id)` or `addFromUrl(url)` (a URL serving a JSON manifest, i.e. one
   `CatalogEntry`, or else a streamable-HTTP MCP endpoint). Connectors are connected once for
   discovery: tools and resources are listed, `buildReview()` infers each tool's class, risk
   and path/domain fields (ADR 0016), adds the transport's host, absolute path arguments and
   `secret:` references, merges the entry's declared permissions, and the connection is
   closed. Other kinds get a review from their declared permissions.
2. The row is inserted with `status = pending_approval`, `enabled = false`, the review's
   permissions, the source (`catalog:<id>` or the URL) and the review in `config`. Audit row
   `extensions.add`, event `extension.requested`.
3. `ExtensionApprovalPort.ask()` is called. In production (`HumanRequestExtensionApprovals`)
   this inserts a blocking, high-risk `human_request` of kind `approval` whose `steps` are the
   review's summary lines and whose `options` are `approve` (with the permissions and review)
   and `deny`; the row stays pending. The inbox answers it; `syncApprovals()` (call it from the
   daemon loop) reads the answer through `port.status()`, or the panel calls
   `POST /extensions/:id/approve|deny` directly.
4. Yes → `approve()`: permissions applied, `enabled = true`, status `installed`, the connector
   is connected and its tools bridged (audit `extensions.approve`, events `extension.approved`
   and `extension.enabled`). No → `deny()`: a fresh install is deleted; a re-permissioning
   keeps the previous grant and leaves the extension disabled.

`updatePermissions()` compares with `widens()`: anything new (tool, class, domain, path,
secret, scope) makes the row pending again, revokes live and asks; pure narrowing applies at
once, revokes tokens that list a removed tool and re-bridges. `toggle(true)` on a pending row
throws `approval_required`; re-enabling an installed row never asks again.

### Live revocation

`toggle(false)` and `remove()` call `revokeLive()`: `TokenRevoker.revokeWhere()` (the
`TokenIssuer` the kill switch holds) revokes every run token whose `allowedTools` includes one
of the extension's tools, and the MCP connection is closed. A run holding a revoked token fails
its next hook with `killed`; a new token is refused by the gate for that tool. The event
carries the revoked token ids.

### The gate

`ExtensionGate.check(tool, ctx)` finds the tool's extension (`extensionId` on a bridged
spec, else the tool index built from every row's `permissions.tools`), reads the row fresh
and throws `ForerunnerError`: `tool_not_allowed` when the extension is disabled, in error,
removed or no longer grants the tool; `approval_required` while pending; `domain_not_allowed`
or `path_not_allowed` when the input's URL or path fields fall outside the extension's own
ceilings. Denials are audited with the token id. Tools that belong to no extension pass.
`GatedEnforcementHooks` is `EnforcementHooks` with the gate in front of `beforeToolCall`; the
drivers take it in place of the plain hooks. `gateTool()` wraps a spec's `execute()` for
callers that bypass the hooks. A bridged tool whose connection was closed refuses every call
by itself.

### Secrets

Transport `env` (stdio) and `headers` (http) values may be `secret:<name>` references. They
are resolved only in `McpConnector.connect()` through the `SecretsPort` (`SecretResolver` over
the vault in production), with the granted set = the approved `permissions.secrets` (at
discovery: the references the transport names). The resolved values live in the transport;
rows, reviews, human requests, events, audit rows and log lines carry names only, and tool
output is redacted with the same resolver. A missing vault value puts the extension in
`error` with the message, never the value.

### Cost

`extension.cost_usd_micro` is the counter; `recordCost(id, usdMicro)` increments it (call it
from `afterToolCall` with `result.costUsdMicro` for bridged tools, or from a capability
module). `ExtensionRegistryDeps.ledgerCost` adds a ledger query when charges are recorded by
extension elsewhere. Views show `{ usdMicro, chfMicro }` at `chfPerUsd()`.

### Catalog format

`catalog.json` is `{ "version": 1, "entries": [CatalogEntry, …] }`. An entry: `id`
(`[a-z][a-z0-9-]*`, unique), `kind`, `name`, `description`, `version`, optional `homepage`,
`transport` (connectors only: `{ type: "stdio", command, args, env, cwd? }` or
`{ type: "http", url, headers }`), `module` (what implements a capability or provider),
`permissions` (declared, same shape as the row), optional `requiresAutonomy`, `tags`. The
built-in file ships browser, email, desktop-control, cloudflare, voice-local,
voice-deepgram, voice-cartesia, voice-elevenlabs, anthropic, mcp-filesystem, mcp-fetch and
mcp-github. A remote catalog (`FORERUNNER_EXTENSION_CATALOG_URL`, or
`ExtensionCatalogOptions.remoteUrl`) is fetched by `ExtensionCatalog.refresh()`; its entries
never override built-in ids. Nothing in the catalog names an org, host or user path.

### Routes

`createExtensionsRoutes({ registry, actor })` returns a Hono sub-app; mount it with
`app.route("/", …)` behind the daemon's bearer check. `actor(c)` names the human for audit
rows.

| Route | Body | Result |
| --- | --- | --- |
| `GET /extensions?kind=` | | `ExtensionView[]` |
| `GET /extensions/catalog` | | `{ remoteUrl, entries }` |
| `GET /extensions/:id` | | `ExtensionView` |
| `POST /extensions` | `{ catalogId }` or `{ url }` | 201 enabled, 202 pending |
| `POST /extensions/:id/toggle` | `{ enabled }` | `ExtensionView` |
| `POST /extensions/:id/approve`, `/deny` | | `ExtensionView` / `{ ok }` |
| `PUT /extensions/:id/permissions` | `{ permissions }` (partial) | 200 applied, 202 pending |
| `DELETE /extensions/:id` | | `{ ok }` |

Errors are `{ code, message, details }` with 400 validation, 403 approval or allowlist
codes, 404, 409 version conflict, 503 unavailable.

### Wiring (for the orchestrator)

```ts
const catalog = new ExtensionCatalog(loadBuiltinCatalog(), { remoteUrl: catalogUrlFromEnv() });
const registry = new ExtensionRegistry({
  extensions: store.extension, audit: store.auditLog, clock, catalog,
  approvals: new HumanRequestExtensionApprovals(store.humanRequest),
  connectors: new DefaultMcpConnectorFactory(), secrets: secretResolver, tokens: tokenIssuer,
  events: (e) => sse.broadcast(e), chfPerUsd,
});
await registry.start();                       // reconnect enabled connectors
const gate = new ExtensionGate({ registry, clock, audit: store.auditLog });
const hooks = new GatedEnforcementHooks(hookDeps, gate);
for (const t of registry.bridgedTools()) toolRegistry.register(t);   // per run
app.route("/", createExtensionsRoutes({ registry, actor: () => ({ humanId }) }));
```

## How to change it

- New built-in capability: add an entry to `catalog.json` (the test asserts the file
  validates); the module that implements it registers tools under the names the entry lists.
- New transport: extend `ConnectorTransport` in `catalog.ts` and `defaultTransportFactory` in
  `mcp.ts`; keep secret resolution in `resolveTransportSecrets`.
- Class inference: edit `PATTERNS` in `mcp.ts` and the table in ADR 0016 together; add a row
  to the inference test.
- New panel field: add it to `ExtensionView` (zod) and `ExtensionRegistry.view()`.
- Never let a path apply permissions without `widens()`; never bridge a tool that is not in
  `permissions.tools`.

## Tests

`packages/runtime/test/extensions-*.test.ts` (shared fixtures in `extensions-helpers.ts`: an
in-process MCP server with two tools and one resource over `InMemoryTransport`, a stateless
streamable-HTTP server on 127.0.0.1, `sqlite::memory:` store, `SimulatedClock`,
`MemoryExtensionApprovals`, a `MemoryVault` whose only value is built by concatenation):

- `extensions-catalog.test.ts`: built-in catalog validates and lists the shipped
  capabilities; bad entries rejected; remote catalog over `node:http` merges without
  overriding built-ins; env URL.
- `extensions-mcp.test.ts`: class inference table, field inference, schema, review contents
  (classes, risk, fields, domains, secrets by name, scopes, summary), bridged ToolSpecs
  (extension id, untrusted output, grant filter), secrets resolved at spawn and absent from
  every log line, ungranted secret refused, closed connection refuses calls, unreachable server
  is `unavailable`.
- `extensions-registry.test.ts`: install pending before yes with the review in the request;
  yes enables, connects and bridges; no deletes; capability install with scopes; disable revokes
  tokens that list its tools and closes the connection, re-enable needs no approval; remove;
  narrowing applies at once; widening pends, deny keeps the old grant; cost in CHF; connect
  error → `error`; `start()` reconnects; add from URL (manifest and live HTTP MCP endpoint);
  `HumanRequestExtensionApprovals` round trip; audit rows and events for every change; no
  secret value in rows, requests or logs.
- `extensions-gate.test.ts`: approved tool runs through `GatedEnforcementHooks` and is wrapped
  as untrusted; pending → `approval_required` (audited); disable → `tool_not_allowed` in code
  and a running run's token revoked live (next hook `killed`, kill switch registration intact);
  removed → refused; extension domain/path ceilings; non-extension tools pass; `gateTool()`.
- `extensions-routes.test.ts`: every route, status codes, audit trail with the actor.

Run: `pnpm vitest run --project unit packages/runtime/test/extensions-*.test.ts`.

## Known issues

- Discovery spawns a stdio server before approval (ADR 0016); a catalog entry is still a
  command the human chose, but a remote catalog can point at any command. Treat remote
  catalogs as trusted configuration.
- `cost_ledger` has no extension column; cost is the row counter plus the optional
  `ledgerCost` query. Bridged MCP calls report no price of their own.
- Revocation is per token: a run that holds a token listing the extension's tool stops
  entirely (its token is revoked), not only for that tool. This is deliberate for a live
  revocation; the session can be resumed with a new token.
- Re-permissioning that widens disables the extension until the answer; the panel should say
  so.
- Skills and specialists are catalogued as rows only; their loader (`src/registry`) does not
  yet consult the registry for enabled state.

## Requirements covered

K.6 (Extensions panel: status, permissions, cost, version, toggle, remove, add from catalog
or URL), L.5 (connectors from a catalog or URL, reviewed and permissioned on install), S.5
(each grant shows its scopes), S.6 (granting a new capability always needs a human), S.3
(bridged tools are enforced by the run token and the hooks), S.8 (live revocation uses the
same token revocation as the kill switch), U.16 (the `extension` table), O.4 (voice providers
chosen in the panel: catalog entries), M.5 partial (connector versions are shown; the updates
screen is phase 7).
