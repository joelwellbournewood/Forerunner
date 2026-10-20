# Runtime

`packages/runtime`: the orchestrator. Agent drivers, enforcement hooks, budget accounting,
capability tokens, kill switch, model ladder, delegation briefs, injection scanning, sessions.

## Purpose

Every model call and tool call Forerunner makes passes through this package. "A prompt can ask;
only code can allow" lives here. ADR 0004 explains the two drivers; ADR 0007 the sandboxes.

## How it works

### Authority: capability tokens (`src/enforcement/token.ts`)

A run gets a `SignedToken`: HMAC-signed claims (allowed tools, allowed path roots, allowed
domains, granted secret names, run budget, depth and max depth, autonomy level, expiry). The
model only ever sees the token id. `TokenIssuer.derive` builds a sub-agent token that can only
narrow the parent (intersection of lists, min of budgets, depth + 1, depth cap enforced).
`revoke`/`revokeWhere` are used by the kill switch.

### Enforcement hooks (`src/enforcement/hooks.ts`)

| Hook | Checks, in order |
| --- | --- |
| `beforeModelCall(ctx, estimate)` | token valid and not revoked, kill state, session wall clock, run deadline, step cap, run cap, session cap with 80% finish-current and review reserve, outer caps (task, project, month, plan share) via `CapsPort` |
| `afterModelCall(ctx, usage, usd)` | records spend in `SessionBudget` and the ledger |
| `beforeToolCall(ctx, tool, input)` | token/kill, step, tool allowlist, zod schema, path containment for `pathFields`, domain allowlist for `domainFields`, autonomy decision (may ask `ApprovalPort`; pending pauses the run), secret-ref resolution for granted names only; denials are audited |
| `afterToolCall(ctx, tool, input, result)` | redacts resolved secrets, wraps untrusted output in the data envelope and scans it for injection, audits |

The per-session accounting is `SessionBudget` (`src/enforcement/budget.ts`): run and session
caps, step cap, wall clock, the 80% rule and the review reserve (default 20%). The estimate
before a call is conservative: full input at input price plus `max_tokens` at output price.

### Autonomy (`src/enforcement/autonomy.ts`)

Action classes map to decisions per level 0–4. `destructive`, `financial`, `credential`,
`permission_change` and `capability_grant` need a human at every level. Level 0 proposes only,
level 1 runs routine work after plan approval, level 2 frees routine reversible work, level 3
also merges reviewed PRs and deploys to staging, level 4 everything else.

### Kill switch (`src/enforcement/killswitch.ts`)

Registered runs (abort controllers) and child processes are stopped, tokens revoked and claims
frozen through a callback; the test proves 40 runs and 3 processes stop in under 2 s. A stopped
scope stays frozen (new registrations abort at once) until `resume()`.

### Drivers

`LoopAgentDriver` (`src/agent/loop.ts`) runs the tool loop over any `ModelProvider`
(`src/provider/types.ts`): estimate → `beforeModelCall` → stream → cost → `afterModelCall` →
for each tool use: `beforeToolCall` → execute with per-tool timeout → `afterToolCall`. Outcomes:
`completed`, `timeout` (partial text kept), `budget_exceeded`, `step_cap_exceeded`, `killed`,
`needs_human` (approval pending), `max_turns`, `error`. Events stream to the live session view.
`SdkAgentDriver` (`src/agent/sdk.ts`) wraps the Claude Agent SDK with the same hooks.

### Models (`src/models/ladder.ts`)

Ladder haiku → sonnet → opus → fable, ceiling opus by default; mode defaults and response
targets from spec table D; effort offset from the project slider; retry ladder
(improve brief → split/change specialist → escalate under ceiling → human).

### Briefs (`src/brief.ts`)

`validateBrief` rejects any delegation missing goal, context links, constraints, acceptance
criteria, budget, risk tier or specialist with `brief_incomplete` and the list of issues.

### Injection (`src/injection/scan.ts`)

`wrapUntrusted` puts external content in a data envelope and lists instruction-like passages;
`scanForInjection` scores rules (ignore-previous, identity change, exfiltration asks, approval
bypass, hidden text, markdown image exfil, ...). Flagged content raises an event and a note to
the human; it is never acted on.

## How to change it

- New limit: add the check to the hook, a `ForerunnerError` code in platform, and a test in
  `test/hooks.test.ts` that proves the block happens before the call.
- New tool: implement `ToolSpec` (schema, action class, risk, `pathFields`/`domainFields`,
  `untrusted` output flag) and register it; the allowlist in tokens decides who may call it.
- New autonomy rule: edit the `FREE_AT` table and `test/autonomy.test.ts`.
- New driver or provider: implement `ModelProvider` (see `adding-a-provider.md`).

## Tests

`packages/runtime/test/*.test.ts` (unit, fake provider, no network): tokens, autonomy, kill
switch timing, budget rules, hooks (overspend, steps, wall clock, kill, allowlist, schema,
paths, domains, secrets, autonomy, injection), ladder, brief, loop driver (completion, overspend
blocked, step cap, kill mid-run, timeout with partial output, inline denials, needs-human pause,
injection flagged).

## Known issues

- The SDK driver's live behaviour is only verified when a credential is present (see
  `gates.md`); without one the integration test skips with a visible reason.
- Path containment resolves symlinks only when the target exists; the sandbox adapter mounts
  only the worktree so escapes cannot reach the host anyway.
