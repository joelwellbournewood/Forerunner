# Adding a connector

A connector is an MCP server (spec L "Connectors") that an agent reaches through the
Extensions panel. It is one `extension` row of kind `connector` (the state alias
`mcp_server` is shown as one), installed from the built-in catalog or from a URL, reviewed
and permissioned by a human before anything runs, and bridged into the same `ToolSpec`s,
tokens, hooks, audit log and kill switch as every built-in tool. The registry itself (review
and approval flow, the gate, routes, cost) is documented in `extensions.md`; this guide is the
walk-through for adding one connector and for changing how connectors are mapped. ADR 0016
fixes the mapping of MCP tools to `ToolSpec`s and action classes.

## Purpose

- One entry in `packages/runtime/src/extensions/catalog.json` (or one manifest at a URL) is
  all a new connector needs; the runtime infers the rest from what the server reports.
- The human sees and approves exactly what will be enforced: every tool with its class and
  risk, the hosts and paths the transport touches, the secret *names* it receives.
- Nothing is started with a resolved secret before a yes, no tool outside the approved list
  is ever bridged, and a toggle or remove revokes live (`revokeLive`).

## How it works

### The catalog entry (`catalog.ts`, `catalog.json`)

`packages/runtime/src/extensions/catalog.json` is `{ "version": 1, "entries": [...] }`,
parsed by `CatalogFile` (duplicate ids are refused). Each entry is a `CatalogEntry`:

| Field | Rule |
| --- | --- |
| `id` | `CATALOG_ID_RE` (`^[a-z][a-z0-9-]*$`), unique in the file; the row's source is `catalog:<id>` |
| `kind` | `connector` for an MCP server (the other kinds: `skill`, `specialist`, `capability`, `model_provider`) |
| `name` | 1 to 80 characters; the `(kind, name)` pair is unique in the store and `name` is the tool prefix (below) |
| `description`, `version`, `homepage?`, `tags` | shown in the panel; `version` is free text (the shipped connectors say `latest`) |
| `transport` | required for a connector, refused for every other kind: `{ type: "stdio", command, args, env, cwd? }` (`StdioTransport`; `command` is resolved through `PATH` and spawned as an argv array, never a shell string) or `{ type: "http", url, headers }` (`HttpTransport`) |
| `permissions` | the declared `ExtensionPermissions` (default empty); the live review merges what the server exposes into it |
| `requiresAutonomy?` | 0 to 4, the autonomy level below which the capability may not act |
| `module` | capabilities, skills, specialists, providers only: what implements it; a connector has none |

`env` values (stdio) and `headers` values (http) may be `secret:<name>` references
(`secretRefsOf(transport)` lists them, `withoutSecretRefs(transport)` strips them for the
secret-free discovery start). The three shipped connectors are `mcp-filesystem`
(`npx -y @modelcontextprotocol/server-filesystem`), `mcp-fetch` (`uvx mcp-server-fetch`) and
`mcp-github` (`npx -y @modelcontextprotocol/server-github`, env
`GITHUB_PERSONAL_ACCESS_TOKEN: secret:github_pat`, declared `domains: ["api.github.com"]`,
`secrets: ["github_pat"]`). `loadBuiltinCatalog()` reads the file; `ExtensionCatalog`
merges a remote catalog (`FORERUNNER_EXTENSION_CATALOG_URL`, `ExtensionCatalog.refresh()`)
whose entries never override a built-in id, and `isBuiltin(id)` is true for the file's
entries only. Only a built-in entry is started for discovery before the human's first yes,
and only without its secrets (ADR 0016, "Discovery before the yes").

### From the server's tools to ToolSpecs (`mcp.ts`; ADR 0016)

`McpConnector.connect()` spawns or reaches the server (`StdioMcpTransport` through the
platform shell, or the SDK's streamable-HTTP client; `DEFAULT_CONNECT_TIMEOUT_MS` 30 s),
lists its tools and resources, and `review()` calls `buildReview()`:

- **Name.** `bridgedToolName(extensionName, tool)` is `<extension>.<tool>`, both parts
  through `safeToolName` (anything outside `[A-Za-z0-9_.-]` becomes `_`, a leading non-letter
  gets `t_`), checked against `BRIDGED_TOOL_NAME_RE`. `assignBridgedNames` hands two server
  tools whose sanitised names collide `_2`, `_3` suffixes in code-point order of the server
  names, so one approved name never stands for two server tools; the review says which
  server tool a renamed entry is. The prefix `toolPrefixOf(name)` (`<name>.`) is what the
  ownership rule checks (`ownsToolName`).
- **Action class.** `inferActionClass(tool)`: `classFromName` splits the tool name into words
  (`nameWords`, camelCase and separators) and takes the first word that matches `PATTERNS`,
  from the most severe class down: `financial` (pay, purchase, charge, transfer, ...),
  `credential` (password, login, authenticate, ...), `destructive` (delete, remove, drop,
  purge, wipe, revoke, ...), `deploy_production` (deploy, release, rollout), `merge_pr`
  (merge), `external_send` (send, post, publish, email, notify, message, upload, share, ...),
  `non_routine` (execute, run, shell, command, ...), `routine_reversible` (create, write,
  update, edit, add, set, commit, push, ...), `read` (get, list, read, search, fetch, query,
  describe, find, show, ...). Server annotations only tighten: `destructiveHint: true` raises
  a class ranked below `destructive` in `CLASS_RANK`; `readOnlyHint: true` gives `read` when
  the name says read or nothing, and when it contradicts a severe verb the name's class is
  kept with `inferredFrom: "conflict:readOnlyHint,name:<verb>"` and a summary line that
  flags the contradiction. No verb and no annotation is `non_routine` (`inferredFrom:
  "default"`), which runs freely only at autonomy 3 and asks below.
- **Risk.** `riskOf(actionClass)` (`types.ts`): `read` low; `routine_reversible` and
  `non_routine` medium; everything else high. The review's risk is the maximum over the
  tools, at least medium when a secret is referenced.
- **Path and domain fields.** `inferFields(inputSchema)` reads the schema's top-level
  properties that are strings, untyped, or arrays of strings: names matching
  `PATH_FIELD_RE` (`path`, `file`, `dir`, `cwd`, `*_path`, `*Dir`, ...) become `pathFields`,
  names matching `DOMAIN_FIELD_RE` (`url`, `uri`, `href`, `endpoint`, `host`, `*_url`, ...)
  become `domainFields`. The hooks check these
  against the run token's `allowedPaths` and `allowedDomains`, the gate against the
  extension's own ceilings.
- **Schema.** `zodFromJsonSchema` builds a loose zod object from the top-level properties
  and `required` list, so a malformed call is refused by the hooks before it reaches the
  server.
- **The spec.** `bridgeTools()` returns one `BridgedToolSpec` per granted tool: a `ToolSpec`
  (`name`, `description`, `schema`, `actionClass`, `risk`, `pathFields`, `domainFields`,
  `execute`; `packages/runtime/src/agent/tools.ts`) plus `extensionId`, `extensionName` and
  the `mcpTool` it stands for (`isBridgedTool`). `execute` calls the server
  (`DEFAULT_CALL_TIMEOUT_MS` 60 s), flattens the result to text (non-text blocks summarised,
  cut at `MAX_OUTPUT_CHARS`), redacts it through the `SecretsPort` and marks it
  `untrusted: { source: "tool_output", origin: "mcp:<extension name>" }`, so
  `afterToolCall` wraps it in the data envelope and scans it for injection (`security.md`,
  "Injection test suite").

The review (`PermissionReview`) carries the `ReviewedTool`s (`name`, `bridgedName`,
`description`, `actionClass`, `risk`, `pathFields`, `domainFields`, `inferredFrom`), the
resources, the merged `permissions`, the `risk` and the `summary` lines the approval card
shows (`tool <bridged name>: <class> (<risk> risk)`, `reads resource <uri>`, `reaches
<domain>`, `touches <path>`, `uses secret:<name> (value never shown)`, `scope: <line>`, the
transport as `runs <command> <args>` or `connects to <url>`).

### Permissions (`types.ts`, `registry.ts`, `gate.ts`)

`ExtensionPermissions` is what the row stores and the human approves: `tools` (bridged
names, no wildcard), `actionClasses` (from `ACTION_CLASSES`), `domains` (hostnames or
`*.example.com`, never `*`, lower-cased), `paths` (roots), `secrets` (names matching
`^[a-z][a-z0-9_.:-]{0,127}$`, never values) and `scopes` (lines shown as granted). An empty
`actionClasses`, `domains` or `paths` means no ceiling beyond the run token; a non-empty list
is a ceiling the gate enforces on top of it. The declared permissions of the entry are merged
with the review (`normalizePermissions`); `grantedToolNames(permissions, review)` is the set
in force (`tools` minus those whose reviewed class is outside `actionClasses`) and decides
what `bridgeTools()` bridges and which tokens a narrowing revokes.

Ownership: every tool a connector grants, every tool a manifest from a URL or a remote
catalog declares and every tool added later through `updatePermissions()` must start with the
extension's own prefix; a name another row grants or has pending, or one the daemon lists as
built-in (`ExtensionRegistryDeps.reservedTools`), is refused with `validation` before any row
is written (`assertToolsOwned`). Built-in catalog entries may declare their module's names
without the prefix (the `browser` capability lists `browser_navigate`).

At run time a run's `ToolRegistry` is built from the file tools plus
`registry.bridgedTools()` (`toolsForRun()` in `packages/runtime/src/daemon/compose.ts`) and
the session grant lists the bridged names; the hooks apply the token (allowlist, paths,
domains, secrets, autonomy) and `ExtensionGate.check()` in front of `beforeToolCall`
(`GatedEnforcementHooks`; the daemon's `DaemonHooks` extends it) refuses a disabled, errored
or removed extension's tool (`tool_not_allowed`), a pending one (`approval_required`), a
class outside the granted `actionClasses` (`tool_not_allowed`) and an input outside the
extension's own `domains` or `paths` (`domain_not_allowed`, `path_not_allowed`); each denial
is an audit row with the token id.

### Install, approval, live revocation (`registry.ts`)

`addFromCatalog(id)` or `addFromUrl(url)` inserts the row `pending_approval`, `enabled =
false`, with the review in `config` and the stage (`discovery` when the command has not been
started yet, `grant` when the tools are known); `ExtensionApprovalPort.ask()` files the
blocking high-risk `human_request` (`HumanRequestExtensionApprovals`). A yes at `discovery`
(`approve()`) starts the server once with its secrets, lists the tools and asks again; a yes
at `grant` applies the permissions, enables the row, connects with the granted secrets and
bridges the tools; `deny()` deletes a fresh install. Answers through the daemon's
`POST /requests/:id/answer` are applied at once (`rt.syncApprovals()`); answers given on a
phone or in the web approvals reach the daemon on its approvals poll
(`FORERUNNER_APPROVALS_POLL_MS`). The panel's `POST /extensions/:id/approve|deny` does the
same. `extensions.md`, "Review and approval flow", has the audit rows and events of each step.

`toggle(false)` and `remove()` call `revokeLive(row)`: `TokenRevoker.revokeWhere()` revokes
every run token whose `allowedTools` includes one of the extension's tools (a run holding one
fails its next hook with `killed`), and the connection is closed; the event carries the
revoked token ids. Every open connection is registered with the kill switch as
`agentId: "extensions"` (`EXTENSIONS_KILL_AGENT`), `sessionId: "extension:<id>"`
(`extensionKillSession`), with the child process for a stdio server, so `stop("all")` kills
the process tree; `registry.start()` reconnects enabled connectors after `resume()`.

### Secrets

References are resolved only in `McpConnector.connect()` (`resolveTransportSecrets` through
the `SecretsPort`, the `SecretResolver` over the vault in production), for the names the
grant (or the allowed discovery start) names. The value must be in the install's vault under
exactly the referenced name: `fr setup` stores `github_token`, `anthropic_api_key` and
`anthropic_subscription_token` (`SECRET_NAMES` in `packages/runtime/src/setup/wizard.ts`);
any other name is written with `Vault.set(name, value)` from `@forerunner/vault`
(`openVault({ profile })`). A missing value puts the row in `error` with the message, never a
value; rows, reviews, requests, events, audit rows and logs carry names only.

## How to change it

1. **Choose the source.** A connector this repository vouches for goes into
   `packages/runtime/src/extensions/catalog.json` (a built-in entry: started once for
   discovery without its secrets, one yes installs it). Anything else is a manifest, one
   `CatalogEntry` as JSON at a URL, or an entry of a remote catalog
   (`FORERUNNER_EXTENSION_CATALOG_URL`), or a bare streamable-HTTP MCP endpoint URL typed in
   the panel: two yeses, nothing started before the first.
2. **Write the entry.** `id` (lowercase letters, digits, dashes; unique), `kind:
   "connector"`, `name` (becomes the tool prefix `<name>.`), `description`, `version`,
   `transport` (`stdio` with `command`, `args`, `env`, optional `cwd`, or `http` with `url`
   and `headers`), `permissions` with the declared part: `secrets` naming every
   `secret:<name>` the transport references, `domains` for the hosts the server reaches,
   `scopes` lines for the human, and `actionClasses` only when you want a ceiling (the review
   adds the tools and their classes; a tool whose class falls outside the list is not
   bridged). Leave `tools` empty: the server's tool list fills it, prefixed. Nothing in the
   entry may name an org, account, host or user path (AGENTS.md). `parseCatalog` rejects a
   duplicate id, a connector without a transport, a `*` domain and unknown fields.
3. **Put the secret where the reference points.** The vault of each install that will run
   the connector needs the value under the referenced name (see "Secrets"); the human stores
   it, never the catalog or a test fixture.
4. **Check the review the server will get.** Tool names the verbs in `PATTERNS` do not
   recognise land in `non_routine` (approval below autonomy 3); a path or URL field whose
   name matches neither `PATH_FIELD_RE` nor `DOMAIN_FIELD_RE` is not checked against the
   token. To widen inference, edit `PATTERNS` or the field patterns and `CLASS_RANK` in
   `mcp.ts` together with the table in ADR 0016, and add a row to the inference table in
   `packages/runtime/test/extensions-mcp.test.ts` (name, annotations, class,
   `inferredFrom`). Annotations may only tighten a class, never loosen one.
5. **Tests.** A new built-in entry: add its `id` to the list `extensions-catalog.test.ts`
   asserts and, when it references a secret, assert the transport's `secret:<name>` the way
   the `mcp-github` assertion does; the file also proves the whole catalog parses. A new
   transport kind or inference rule: `extensions-mcp.test.ts`. Registry behaviour (two
   stages, ownership, narrowing and widening, errors): `extensions-registry.test.ts`. The
   gate and live revocation: `extensions-gate.test.ts`. Run `pnpm vitest run --project unit
   packages/runtime/test/extensions-*.test.ts`.
6. **Install it and watch it refuse.** Panel `/extensions`, Add, pick the entry (or paste
   the URL), or `POST /extensions { catalogId }` / `{ url }` (201 enabled, 202 pending with
   `pendingStage`); answer the approval card in the inbox; the row shows `enabled`,
   `connected: true` and the permissions; the next run's registry carries `<name>.<tool>`
   (`toolsForRun()`); toggle it off and the call is refused in code (`tool_not_allowed`) and
   the run's token revoked. `packages/runtime/test/wiring.test.ts` ("extensions: catalog ->
   add (pending) -> answer in the inbox -> enabled -> bridged tool in the run registry ->
   toggle off refuses in code") is this walk through the composed daemon.
7. **Docs.** `scripts/docs-check.mjs` maps `packages/runtime/` to `extensions.md` among
   others: update its "Catalog format" list of shipped entries and this guide where the
   mapping or the flow changed; a changed class table also changes ADR 0016.

## Tests

`pnpm vitest run --project unit packages/runtime/test/extensions-*.test.ts` (81 tests on
2026-10-25; the inference table in `extensions-mcp.test.ts` is one `it` per row).
Shared fixtures in `packages/runtime/test/extensions-helpers.ts`: `buildFakeMcpServer`, an
in-process MCP server `fake-mcp` with the tools `fetch_page` and `post_comment` and one
resource over the SDK's `InMemoryTransport`, optionally refusing to start without its
secret; `fakeCatalogEntry` / `testCatalog` (`FAKE_CATALOG_ID` is `fake-mcp`, extension name
`fake`, so the bridged names are `fake.fetch_page` and `fake.post_comment`);
`FAKE_STDIO_SERVER_SCRIPT`, a dependency-free stdio MCP server as a `node -e` script that
ignores SIGTERM; `startHttpFixture`, a stateless streamable-HTTP server on 127.0.0.1;
`registryHarness` (`sqlite::memory:` store, `SimulatedClock`, `MemoryExtensionApprovals`, a
`KillSwitch`, `RESERVED_TOOLS` as the daemon's built-in names, a `MemoryVault` whose only
value, `FAKE_TOKEN_VALUE`, is built by concatenation).

| File | Covers |
| --- | --- |
| `extensions-catalog.test.ts` (5) | the built-in file parses and lists the shipped ids (`mcp-filesystem`, `mcp-fetch`, `mcp-github` among them) with `mcp-github`'s env holding exactly `secret:github_pat`; duplicate ids, a connector without a transport and wildcard domains rejected; a remote catalog over `node:http` merged without overriding built-ins and not built-in; the env URL; `fetchJson` refusing by `content-length` and cutting a chunked body at the cap |
| `extensions-mcp.test.ts` (37) | the ADR 0016 inference table (name first, annotations only tighten, conflicts recorded), the conflict line in the summary, colliding names renamed deterministically, the prefix helpers, `withoutSecretRefs`, field inference, the loose schema, the review's contents, bridged `ToolSpec`s with the extension id and untrusted output, secrets resolved at spawn and absent from every log line, an ungranted secret refused, a closed connection refusing calls, an unreachable server `unavailable`; `StdioMcpTransport` with a real child process: pid exposed, tools listed, env seen by the server, a secret-free spec leaving it unset, `close()` killing a server that ignores SIGTERM, a missing command `unavailable` |
| `extensions-registry.test.ts` (25) | pending before the yes with the review in the request; discovery of a built-in entry without secrets; yes enables, connects with the secret and bridges; no deletes; nothing from outside the built-in catalog started before a yes (URL manifest, remote entry, bare endpoint); a built-in entry that needs its secret to boot asked first; a discovery failure kept pending with the redacted error and retried by `approve`; disable revokes tokens and closes, re-enable asks nothing; remove; narrowing by name and by class at once, widening pends, deny keeps the old grant; ownership (no tool outside the prefix, no shadowing of `browser.open`, no built-in name); cost in CHF; connect error → `error`; `start()` idempotent; `HumanRequestExtensionApprovals` round trip; every change audited; no secret value anywhere on any path |
| `extensions-gate.test.ts` (9) | an approved tool through `GatedEnforcementHooks`, wrapped as untrusted; pending `approval_required` (audited); disable `tool_not_allowed` in code and a running run's token revoked live (next hook `killed`); removed refused; the extension's domain and path ceilings; non-extension tools pass; `gateTool()`; narrowing the classes refuses `fake.post_comment` while `fake.fetch_page` passes; `stop("all")` closes every connector and kills a real stdio process tree, a scoped stop does not, a frozen switch cuts a reopen off, `start()` after `resume()` reconnects |
| `extensions-routes.test.ts` (5) | every route and status code, 202 on `approve` after a discovery yes, the audit trail with the actor |

Also: `packages/runtime/test/wiring.test.ts` (the composed daemon, catalog to refused tool,
see step 6) and `apps/ui/test/extensions.test.tsx` (the panel: every kind listed with status,
version, cost and permissions, pending rows first; "adds a connector from the catalog, which
waits for approval, then approves it"; "adds an MCP server from a URL and denies it"; toggle,
and remove after a confirmation; reload on an `extension.changed` frame).

## Known issues

- No command or route stores an arbitrary vault name: `fr setup --github-token` stores
  `github_token`, while the shipped `mcp-github` entry references `secret:github_pat`. Until
  the value is stored under `github_pat` (`Vault.set` through `openVault`), approving
  `mcp-github` ends in `error` with the missing-value message. Either align the entry's
  reference with `SECRET_NAMES.github` or add a way to store a named secret; both are
  outside this guide.
- The shipped connectors say `version: "latest"` and are fetched by `npx -y` or `uvx` at
  every start: the host needs those tools and network access, and nothing pins the server's
  version (the updates screen, spec M.5, is phase 7).
- Class inference knows English verbs only; a server with opaque or non-English tool names
  lands every tool in `non_routine`. The human can narrow a class in the review, never widen
  one.
- Field inference reads top-level string properties only; a path or URL nested inside an
  object is not checked against the token or the extension's ceilings (the server validates
  it). Add the field name to the patterns or flatten the schema.
- `addFromUrl` fetches the typed URL (manifest probe) before any approval, loopback and
  private ranges included; it yields at most a pending row (`extensions.md`, Known issues).
- A connector's cost stays 0 until a capability module charges through the ledger under
  `extension:<id>`; bridged MCP calls carry no price (`extensions.md`, "Cost").
