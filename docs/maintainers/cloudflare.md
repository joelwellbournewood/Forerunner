# Cloudflare deploys

> Status: implemented in `packages/capabilities/src/cloudflare/` (phase 6), tested against the
> fake Cloudflare API in `packages/capabilities/test/helpers/fake-cloudflare.ts`. No real token
> exists yet (`docs/status/BLOCKERS.md`); the re-test against a named test zone is listed under
> "Known issues". The orchestrator wires the ports under "How to wire it".

## Purpose

Spec: Build order phase 6 "Cloudflare integration for deploys"; "Rules that apply everywhere"
-> Least privilege ("Cloudflare token scoped to named zones and Workers. Each grant shows its
scopes in the Extensions panel") and "Always needs a human ... spending real money"; module J
autonomy levels ("3 Trusted: also ... deploys to staging", "4 Autopilot: everything except
destructive, financial and credential actions"); Human checklist ("Cloudflare API token scoped
to the zones and Workers it may touch"). ADR 0035 records the decisions the spec left open.

An agent can deploy a Worker or a Pages site to staging or production and upsert DNS records,
only inside the one account and the zones a project names, with every limit a check in code
that runs before any request leaves the machine. The token is a vault reference; its value is
never in model context, logs, audit rows or error messages.

## Scopes the token needs

Create the token in the Cloudflare dashboard ("Create Custom Token") with exactly these
permission groups, restricted to the account and the zones the project may touch:

| Permission group | Resource | Needed for |
| --- | --- | --- |
| Workers Scripts: Edit | the account | `deployWorker` (multipart upload) |
| Workers Routes: Edit | the named zones | routes on the deploy's hosts |
| Cloudflare Pages: Edit | the account | `deployPages` (direct upload) |
| DNS: Edit | the named zones | `dnsUpsert` |
| Zone: Read | the named zones | zone lookup by host, plan shown in `plan()` |
| Account Settings: Read | the account | `getAccount`, zone listing |
| API Tokens: Read | the user | `verifyToken()` reading its own policies for the panel |

No billing or subscription permission: the module refuses plan changes without a human
anyway, and a token without "Billing" permission cannot spend even if a check were wrong.
`verifyToken()` reports what the token actually grants (`scopes`, one line per permission group
and resource) and warns when the configured zones or account are not named by any allow
policy; without "API Tokens Read" it says the scopes are unknown instead of guessing.

## Project settings

`project.settings.cloudflare` (JSON, `CloudflareSettingsSchema` in `settings.ts`):

| Key | Default | Meaning |
| --- | --- | --- |
| `account_id` | required | the one account the project may touch |
| `zone_ids` | `[]` | zones the project may touch; anything else is refused before any request |
| `secret_ref` | `secret:cloudflare_api_token` | a reference, never a value (`validation` otherwise) |
| `base_url` | `https://api.cloudflare.com/client/v4` | only the stand-in changes it |
| `workers.staging_suffix` | `-staging` | staging Workers deploy to `<name><suffix>` |
| `pages.staging_branch` | `staging` | staging Pages deploys are preview deployments on this branch |

`cloudflareSettingsOf(project)` returns `null` when the project has no settings and throws
`validation` when they are present but invalid, so a typo never widens the scope. Nothing is
hardcoded to an account, zone or host; the catalog entry (`packages/runtime/src/extensions/catalog.json`,
id `cloudflare`) declares the domain `api.cloudflare.com` and the secret `cloudflare_api_token`.

## How it works

### `client.ts`: `CloudflareClient`

REST v4 over an injected `fetch` and base URL. The token comes from `TokenSource`
(`cloudflareTokenSource({ vault, ref })` resolves the reference on every call;
`staticTokenSource` for callers that already hold a value). Every token and Pages upload JWT the
client hands out is remembered so `scrub(text)` can remove it (plus the platform `redact`) from
error messages, log lines and audit rows, even when a hostile server echoes the header back.

Scope in code: `zonePath(zoneId, suffix)` builds every zone-scoped path and throws
`tool_not_allowed` for an id outside `scope.zoneIds`; `accountPath(suffix)` only knows the
configured account; `listZones()` asks for the account's zones and keeps the configured ones;
`getZone` refuses a zone that belongs to another account; `zoneForHost(host)` returns the
configured zone that contains the host (longest match) or throws `domain_not_allowed`.

Money in code: `MONEY_PATH_PATTERNS` (`/subscription`, `/billing`, `/rate_plans`,
`/purchases`, `/workers/subscription`) are refused with `approval_required` unless the request
carries `moneyApproved: true`, which only the deployer sets after a one-shot human answer.

Errors: 401/403 and codes 10000/9109 -> `provider_auth`; 404 -> `not_found`; 429 ->
`provider_rate_limit` (retryable, `retryAfterMs`); 5xx -> `provider_error` (retryable); other
4xx -> `validation`; network failure -> `unavailable`. 429 waits for `Retry-After` on the
injected `Clock` (bounded by `maxRateLimitWaitSec`, default 60 s); 5xx retries twice with
backoff; at most three attempts.

Endpoints: token verify and policies; account; zones; Worker scripts (`uploadWorkerScript`:
multipart with a `metadata` JSON part — `main_module`, `bindings`, `compatibility_date`,
`compatibility_flags`, `migrations`, `logpush`, `usage_model` — and the module part typed
`application/javascript+module`); Worker routes; Pages project, upload token, `check-missing`,
`upload`, `upsert-hashes`, deployments (multipart `manifest` + `branch`); DNS list, create,
update; zone subscription (money).

### `deploy.ts`: `CloudflareDeployer`

Every method follows the same order: resolve the scope with reads only, decide, ask, then
write, then audit.

| Method | Action class | Writes | Scope label |
| --- | --- | --- | --- |
| `plan(req, actor)` | none (dry run) | none; lists `changes` (create/update/unchanged), the autonomy `decision` and `paid` items | per kind |
| `deployWorker(req, actor)` | `deploy_staging` or `deploy_production` by `env` | PUT script, then one route per host (create, update or unchanged) | `account:<id> zone:<id>…` of the route hosts |
| `deployPages(req, actor)` | by `env` | upload token, check-missing, upload only the missing hashes in buckets (100 files / 20 MiB), upsert-hashes, deployment on the branch | account (+ zones of `hosts`) |
| `dnsUpsert(req, actor)` | `deploy_production` always | POST or PUT one record; equal records are left alone | `account:<id> zone:<id>` |
| `changeZonePlan(req, actor)` | `financial` | PUT subscription with `moneyApproved` | zone |
| `verifyToken(actor)` | read | none | account and zones |

Staging and production rules (J.9, J.10, S.6), all in `gate()`:

1. `decideAutonomy(actionClass, { level, planApproved })`: staging is free at level 3 and 4,
   production at 4 only; below that the approval port is asked with `oneShot: false` and the
   class on the card. A "pending" answer returns `{ status: "awaiting_approval" }` (nothing
   written, audit row `allowed: false`, `approval_required: pending`); a "denied" answer
   throws `approval_required`. Level 0 always asks.
2. Paid resources (`paidWorkerFeatures`: Durable Object `migrations`, `logpush`, `usageModel`)
   and plan changes ask the port with `actionClass: "financial"`, `oneShot: true`, at every
   level including 4; the answer is spent by that one action. The money ask comes last so a
   pending production approval never consumes a money "yes".

The approval card shows the tool input (the script path, the target, the hosts) when the
deploy comes through a tool. A direct caller without `actor.tool` gets a summary instead:
`{ name, env, hosts, scriptChars, scriptSha256 }` for a Worker (never the script source, so
the card stays small and a changed script still asks again), `{ project, env, files }` for
Pages, the zone and record for DNS.

Worker naming: staging deploys `<name><workers.staging_suffix>`, production `<name>`; routes
are `<host><routePath>` (default `/*`) and each host must be inside a configured zone
(`zoneForHost`, so a host outside the zones is refused before the script is uploaded). Pages:
the project must already exist (`not_found` otherwise, a human creates it); staging deploys on
`pages.staging_branch` and refuses when that equals the production branch; production deploys
on the project's production branch. Files are collected with `lstat`, symlinks are never
followed, files over 25 MiB or more than 20 000 files are refused (`validation`), the manifest
key is the posix path with a leading slash and the asset key is `hashAsset(content, path)`
(default: sha256 of content plus extension, 32 hex chars; injectable).

Audit (S.9): `CloudflareAuditPort` is structurally `AuditLogRepo`. One row per outward action:
`cloudflare.verify_token`, `cloudflare.deploy_worker`, `cloudflare.worker_route`,
`cloudflare.pages_upload`, `cloudflare.deploy_pages`, `cloudflare.dns_upsert`,
`cloudflare.change_plan`; denials and pending approvals are rows with `allowed: false` and the
reason; `input_summary` always carries the scope label; everything passes through `scrub`.

### `approvals.ts`: the human port

`CloudflareApprovalPort.ask(request)` -> `approved | denied | pending`. Production:
`HumanRequestCloudflareApprovals(humanRequestRepo, clock)` files a blocking `human_request` of
kind `approval` with the operation, scope, environment and action class in `steps` and a
`change_card` carrying the key (`cloudflare:<operation>:<money|autonomy>:<scope>:<tool hash>`).
The first ask returns "pending"; the model retries the same call once the human answered
(J.3, J.4 semantics: one question, one answer). A one-shot "yes" is marked `consumedAt` on
the row (optimistic concurrency, so two deploys cannot both spend it). It is spent when
`ask()` hands it out, before the write is sent: if the upload or plan change then fails
(network, 5xx after the retries), the answer is gone and the human must answer again. That is
deliberate (spending real money always needs a human); the cost is one extra question after a
failed write. A non-one-shot ask also
accepts the row the runtime hooks' `StateApprovals` filed for the same tool call when its
action class matches, so a staging deploy at level 2 is approved once, not twice.
`FakeCloudflareApprovals(answer)` for tests; `cloudflareApprovalsFromRuntime(port)` adapts the
runtime's `ApprovalPort`.

### `tools.ts`: ToolSpecs

| Tool | Class | Risk | `pathFields` | `domainFields` |
| --- | --- | --- | --- | --- |
| `cloudflare_plan` | `read` | low | `target.scriptPath`, `target.directory` | — |
| `cloudflare_deploy` | `deploy_staging` | high | same | — |
| `cloudflare_dns_upsert` | `deploy_production` | high | — | — |
| `cloudflare_verify_token` | `read` | low | — | — |

`cloudflare_deploy` carries `env` in its input; its hook class is the weaker `deploy_staging`
and the deployer enforces production and money in code (ADR 0035). Script and directory paths
are checked against `allowedPaths` here as well as by the hooks (`path_not_allowed`). Every
call writes an audit row named after the tool with the scope in `input_summary` (so a deploy
produces the tool row plus the deployer's per-action rows). Errors come back as
`refused (<code>): <message>` with `isError: true`; a pending approval is not an error.

No tool declares `domainFields` (ADR 0035, point 6). The hooks' domain allowlist and the
extension gate name the network destinations a run may reach, and this capability reaches only
`api.cloudflare.com`; Worker route hosts and DNS record names are what a deploy configures,
not where it connects, they are per project (so a fixed catalog entry could never list them)
and the hooks' hostname rule would reject `_acme-challenge` labels. They are checked in code
instead: the deployer maps every host and record name to a configured zone (`zoneForHost`,
`domain_not_allowed` otherwise) before any request, and zone ids go through the client's
path builders. `cloudflare-hooks.test.ts` runs the tools through the real `EnforcementHooks`
with a token whose allowlist is only `api.cloudflare.com`: a route deploy and an
`_acme-challenge` TXT upsert pass, a host outside the zones is refused by the deployer with
nothing sent, and a script path outside the run's roots is still refused by the hooks.

`cloudflareToolDeps({ projects, vault, approvals, audit, clock })` builds the production deps:
a deployer per call from `project.settings.cloudflare` and the project's `autonomy_level`.
`registerCloudflareTools(registry, deps)` registers the four tools.

### `routes.ts`: the panel

`cloudflareRoutes(deps)` / `createCloudflareRoutes(deps, app)` (structural app, no hono
dependency, like the email routes): `GET /cloudflare/projects/:projectId/settings` (settings
and scope; the secret by reference) and `GET /cloudflare/projects/:projectId/token`
(`verifyToken()`: status, expiry, scope lines, warnings). Nothing here writes to Cloudflare.

## How to wire it

```ts
const approvals = new HumanRequestCloudflareApprovals(store.humanRequest, clock);
registerCloudflareTools(registry, cloudflareToolDeps({
  projects: store.project, vault, approvals, audit: store.auditLog, clock,
}));
createCloudflareRoutes({ projects: store.project, vault, clock }, app);
```

The capability token of a run must list the tools, the domain `api.cloudflare.com` and the
secret `cloudflare_api_token` (the catalog entry declares them; the extension gate enforces
them). That is the whole domain allowlist a deploy needs: zone hostnames are never added to
it, because route hosts and DNS names are not domain fields (see "ToolSpecs"); the zones a run
may touch come from `project.settings.cloudflare.zone_ids` and the deployer enforces them. The orchestrator also adds `export * as cloudflare from "./cloudflare/index.ts"` to
`packages/capabilities/src/index.ts` and aligns the catalog's `permissions.tools` with the
four tool names above (the catalog still lists the placeholder names `cloudflare.deploy`,
`cloudflare.list_zones`, `cloudflare.purge_cache`).

## How to change it

- A new endpoint: add it to `CloudflareClient` through `zonePath`/`accountPath` (never a raw
  `/zones/...` string) so the scope check cannot be bypassed; if it can cost money, add its
  path to `MONEY_PATH_PATTERNS` and a test that it is refused without `moneyApproved`.
- A new deploy kind: add a request type, a `resolveX` (reads only) and a method that calls
  `gate()` before the first write and `record()` after each write; add the kind to
  `PlanRequest` and `plan()`.
- A new paid feature: extend `paidWorkerFeatures` and its test; never make a paid feature free
  at any level.
- Changing the staging/production rule or the approval keying is an ADR (supersede 0035).
- The fake API (`test/helpers/fake-cloudflare.ts`) mirrors the real shapes; extend it with the
  endpoint before using it in a test. When the real token arrives, run the client tests against
  `https://api.cloudflare.com/client/v4` with a named test zone and compare.

## Tests

`pnpm vitest run --project unit packages/capabilities/test/cloudflare-*.test.ts` (47 tests,
fake API on 127.0.0.1, `sqlite::memory:` store, `SimulatedClock`, memory vault):

- `cloudflare-client.test.ts`: settings parsing and the secret-reference rule; token verify
  with scope lines and coverage warnings; "API Tokens Read" missing; token resolved by
  reference on every call; `provider_auth` without the token in the message; a token echoed by
  the server is scrubbed from errors and logs; zone outside the list refused before any
  request; only configured zones listed; only the configured account; money paths refused
  without approval; 429 wait on the clock and the bound; 404 and 5xx mapping.
- `cloudflare-deploy.test.ts`: Worker staging multipart body, suffixed name, route creation and
  audit rows with the scope; route update and unchanged; host outside the zones refused before
  any write; production at level 3 waits, approved deploys, level 4 never asks; staging below 3
  asks and a denial throws; paid resources refused without a one-shot answer even at 4, and
  the autonomy answer precedes the money answer; Pages direct upload with missing-file
  negotiation, only missing files uploaded, staging on the preview branch; production branch
  and approval; unknown project, empty directory, staging branch equal to production;
  a direct call without a tool asks with a script length and digest, never the source;
  symlinks skipped (`it.skipIf` with a reason where symlinks cannot be created); DNS create,
  update, unchanged, zone from the name; DNS is production and names outside the zones are
  refused before any request; `plan()` sends no writes and asks nobody; `changeZonePlan`
  one-shot at every level.
- `cloudflare-tools.test.ts`: tool shapes and registration; verify token output without the
  value and audit rows with the scope; deploy from the worktree; production pending through
  the tool with a denied audit row; script outside the worktree refused; DNS and plan tools;
  project without settings refused; no token value in logs, output or audit rows during a
  failing deploy; `HumanRequestCloudflareApprovals` filing, per-key answers, one-shot
  consumption, denial and reuse of the hooks' answer; the panel routes.
- `cloudflare-hooks.test.ts`: the tools behind the real `EnforcementHooks` with a token whose
  domain allowlist is only `api.cloudflare.com`: a Worker route deploy on two configured zones
  passes; an `_acme-challenge` TXT upsert and a Pages plan pass; a host outside the zones
  passes the hooks and is refused in code before any request with denied audit rows; a script
  path outside the run's roots is still refused by the hooks.

## Known issues

- No real token yet: the Pages asset key is sha256-based; wrangler uses blake3 of the base64
  content plus extension. If the real `/pages/assets/upload` endpoint verifies keys, pass a
  blake3 `hashAsset` when the token arrives (the hash function is injectable for this reason).
- Pages custom domains and Worker custom domains are not attached; `hosts` on a Pages deploy is
  only checked against the zones. Pages projects are never created by an agent.
- The runtime hooks' approval card for a production deploy below level 3 says
  `deploy_staging` (the tool's class); the deployer then files its own `deploy_production`
  request, so such a deploy is approved twice. Splitting the tool would avoid this at the cost
  of the single `cloudflare_deploy` tool the spec asks for.
- The fake API lives in `packages/capabilities/test/helpers/`; BLOCKERS.md says `testenv`.
  Moving it there is a copy once `testenv` has a slot for it.

## Requirement IDs covered

J.9 (staging deploys free at Trusted), J.10 (production free at Autopilot, money never),
L.5 (capability with declared permissions in the catalog), S.1 (limits in code), S.3 (tools,
domains, secrets from the token; the deploy reaches only the catalog's API host), S.4 (secret by reference, never in logs or
errors), S.5 (token scoped to named zones and Workers; scopes shown for the panel), S.6
(spending real money always needs a human; one-shot), S.9 (audit row per outward action).
