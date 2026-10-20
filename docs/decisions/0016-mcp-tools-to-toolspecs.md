# 0016 — How MCP tools map to ToolSpecs and action classes

Date: 2026-10-20
Status: accepted

## Context

Connectors (spec L) are MCP servers installed from a catalog or a URL. The runtime enforces
every limit through `ToolSpec`s: a tool has an action class (the autonomy table decides who
may run it), a risk, and the input fields that hold paths or URLs (checked against the run
token). An MCP server only describes its tools with a name, a description, a JSON schema and
optional annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
The annotations are hints the server chooses; a malicious or sloppy server can set them
wrongly, and most servers set none. Something has to decide the class before the human sees
the review, and the decision must never widen what the human approved.

## Decision

`packages/runtime/src/extensions/mcp.ts` bridges every MCP tool into a `BridgedToolSpec`
(`ToolSpec` plus `extensionId`, `extensionName`, `mcpTool`):

- **Name**: `<extension>.<tool>` with both parts sanitised to `[A-Za-z][A-Za-z0-9_.-]*`
  (`bridgedToolName`). Tokens, specialist allowlists and the audit log use this name; the MCP
  name is kept on the spec for the call.
- **Action class** (`inferActionClass`), in this order:
  1. `readOnlyHint: true` → `read`.
  2. `destructiveHint: true` → `destructive` (needs a human at every autonomy level).
  3. Otherwise the verbs in the tool name, from the most severe class down: `financial`
     (pay, purchase, charge, transfer, …), `credential` (password, login, authenticate, …),
     `destructive` (delete, remove, drop, purge, wipe, revoke, …), `deploy_production`
     (deploy, release, rollout), `merge_pr` (merge), `external_send` (send, post, publish,
     email, notify, message, upload, share, …), `non_routine` (execute, run, shell, command,
     …), `routine_reversible` (create, write, update, edit, add, set, commit, push, …), `read`
     (get, list, read, search, fetch, query, describe, find, show, …).
  4. No match → `non_routine`: it runs freely only at autonomy 3+, asks below. Unknown verbs
     are never treated as reads.
  The review records why (`inferredFrom`: `annotation:…`, `name:<verb>` or `default`).
- **Risk**: from the class (`riskOf`): read → low, routine/non-routine → medium, everything
  else → high. The review's overall risk is the maximum; a secret reference raises it to at
  least medium.
- **Path and domain fields** (`inferFields`): top-level string properties whose name looks
  like a path (`path`, `file`, `dir`, `cwd`, `*_path`, `*Dir`, …) become `pathFields`; names
  that look like a URL or host (`url`, `uri`, `href`, `endpoint`, `host`, `*_url`, …) become
  `domainFields`. The hooks then apply the run token's path and domain allowlists to them, and
  the extension gate applies the extension's own ceilings.
- **Schema**: `zodFromJsonSchema` builds a loose zod object from the top-level properties and
  `required` list, so malformed calls are refused by the hooks before they reach the server;
  the server validates the rest.
- **Output**: every result is text (non-text blocks are summarised), passed through the
  SecretsPort's redaction, and marked `untrusted: { source: "tool_output", origin: "mcp:<name>" }`
  so `afterToolCall` wraps it in the data envelope and scans it for injection.
- **Cost**: MCP calls carry no price; `ExtensionRegistry.recordCost` adds what a capability
  module or a priced tool reports to the extension's counter.
- **Human override**: the review is what the human approves; `updatePermissions` can drop
  tools, domains, paths, secrets or scopes at once. Nothing a server reports after approval
  can widen the grant: tools not in the approved list are not bridged, and a changed tool
  list shows up only through re-permissioning, which asks again.

## Consequences

- A connector works with the same hooks, tokens, audit and kill switch as built-in tools; no
  second enforcement path.
- Inference errs on the safe side: an unannotated `frobnicate` asks for approval below level
  3; an annotated read-only tool runs at level 0. A server that lies with `readOnlyHint` on a
  destructive tool is still bounded by the token (paths, domains, secrets, budget) and the
  sandbox; the human sees the tool list and description in the review.
- Discovery (listing tools and resources) runs the server once before the human has said
  yes, because the review needs the tool list. For stdio servers this spawns the catalog's
  command with the secrets its env references, resolved from the vault. No tool is called,
  the connection is closed right after discovery, and nothing is callable until the yes.

## Alternatives considered

- Treat every MCP tool as `non_routine` and let the human classify each one by hand: safe but
  unusable for servers with dozens of tools; the review would be ignored.
- Trust the annotations only, defaulting absent `destructiveHint` to true as the MCP spec
  suggests: every unannotated tool would need a human at every level, which is the same as
  "unusable"; and the spec's default makes `readOnlyHint` the only reliable signal anyway.
- Full JSON-schema-to-zod translation: more code for little gain; the server validates its
  own inputs and the hooks only need the top-level fields.
- Review before discovery (no spawn until yes): the human would approve a server without
  seeing what it exposes, which is the opposite of "reviewed and permissioned on install".
