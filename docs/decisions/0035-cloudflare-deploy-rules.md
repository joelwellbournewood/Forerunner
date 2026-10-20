# 0035 — Cloudflare deploys: staging and production naming, DNS as production, money as a one-shot answer

Date: 2026-10-20
Status: accepted

## Context

The spec asks for a Cloudflare integration for deploys (phase 6), a token scoped to named zones
and Workers whose scopes the Extensions panel shows, staging deploys free at autonomy 3,
production deploys needing approval below 4, and a human for anything that spends real money at
every level. It does not say what "staging" is on Cloudflare, how DNS changes are classed, how a
single `cloudflare_deploy` tool with the environment in its input meets the hooks' one action
class per tool, or how a money approval is kept from approving a second action.

## Decision

1. **Staging on Cloudflare.** A Worker deploys to `<name><staging_suffix>` (default `-staging`,
   wrangler's environment naming) for staging and to `<name>` for production. A Pages site
   deploys as a preview deployment on `pages.staging_branch` (default `staging`) for staging and
   on the project's production branch for production; a staging branch equal to the production
   branch is refused. Both names come from `project.settings.cloudflare`; nothing is hardcoded.
2. **DNS is production.** A DNS record is live for the whole zone, so `dnsUpsert` is a
   `deploy_production` action at every level: free at 4, a human below.
3. **One tool, two classes.** `cloudflare_deploy` keeps the environment in its input. Its hook
   class is `deploy_staging` (the weaker one, so staging stays free at 3); the deployer decides
   production in code with `decideAutonomy("deploy_production", ...)` and asks the approval
   port itself. The port reuses the hooks' answer for the same tool call when the action class
   matches, so a staging deploy below 3 is approved once; a production deploy below 3 is
   approved twice (hook card `deploy_staging`, deployer card `deploy_production`), which is
   accepted as the price of a single tool.
4. **Money is a one-shot answer, last.** Durable Object migrations, Logpush, a usage model
   change and a zone plan change are `financial`: the port is asked with `oneShot: true` at
   every level including 4, the "yes" is marked consumed on the `human_request` row by the
   action that used it, and the money ask comes after the autonomy ask so a pending production
   approval never spends a money "yes". The client refuses billing and subscription paths
   without `moneyApproved`, which only the deployer sets after that answer.
6. **Hosts are not domain fields.** `cloudflare_deploy`, `cloudflare_dns_upsert` and
   `cloudflare_plan` declare no `domainFields`. The hooks' domain allowlist and the extension
   gate name the network destinations a run may reach; this capability reaches only the API
   host the catalog entry declares (`api.cloudflare.com`), while Worker route hosts and DNS
   record names are what a deploy configures, not where it connects. They are per project
   (the configured zones), so they could never satisfy a fixed catalog entry, and the hooks'
   hostname rule rejects underscore labels (`_acme-challenge`). They are validated in code,
   before any request, by `zoneForHost` against `settings.cloudflare.zone_ids`
   (`domain_not_allowed` otherwise), and zone ids by the client's path builders. Script and
   site paths stay `pathFields`. Proven by `cloudflare-hooks.test.ts` through the real hooks.

## Consequences

- A project needs `settings.cloudflare` (account, zones, secret reference) before any tool
  works; the Extensions panel shows the token's real scopes and warns about zones the token
  does not name.
- Staging on Workers costs one extra script per Worker; staging on Pages uses preview URLs.
- Durable Objects and plan changes always interrupt an autonomous session for a human; that is
  intended.
- A production deploy below level 3 asks twice. If that becomes a nuisance, split the tool
  (`cloudflare_deploy_production`) and supersede this ADR.
- A run token needs only `api.cloudflare.com` in its domain allowlist to deploy; the zones it
  may touch come from the project settings, not from the allowlist. A money "yes" is spent
  when it is handed out, so a write that fails after it needs a fresh answer.

## Alternatives considered

- Two tools (`cloudflare_deploy_staging`, `cloudflare_deploy_production`): exact hook classes,
  but the spec names one tool with the environment as input; rejected for now.
- Classing DNS by host prefix (e.g. `staging.`): a guess about naming the human never made;
  rejected, DNS stays production.
- Reusing a money "yes" for a session: contradicts "spending real money always needs a human";
  rejected.
- Treating Durable Objects as free (SQLite-backed classes are free on some plans): plan
  dependent and changes over time; the conservative class is kept.
