# 0016 — How MCP tools map to ToolSpecs and action classes

Date: 2026-10-20
Status: accepted (revised after review: discovery policy, annotation precedence, ownership)

## Context

Connectors (spec L) are MCP servers installed from a catalog or a URL. The runtime enforces
every limit through `ToolSpec`s: a tool has an action class (the autonomy table decides who
may run it), a risk, and the input fields that hold paths or URLs (checked against the run
token). An MCP server only describes its tools with a name, a description, a JSON schema and
optional annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
The annotations are hints the server chooses; a malicious or sloppy server can set them
wrongly, and most servers set none. Something has to decide the class before the human sees
the review, and the decision must never widen what the human approved.

Two more things follow from "granting a new capability and sharing secrets always need a
human" (spec, Rules that apply everywhere): the review needs the server's tool list, but
listing it means starting the server, and a server described by a URL or a remote catalog is
an arbitrary command with an arbitrary env; and the names a manifest grants itself must not
let it stand in for tools it does not own.

## Decision

`packages/runtime/src/extensions/mcp.ts` bridges every MCP tool into a `BridgedToolSpec`
(`ToolSpec` plus `extensionId`, `extensionName`, `mcpTool`):

- **Name**: `<extension>.<tool>` with both parts sanitised to `[A-Za-z][A-Za-z0-9_.-]*`
  (`bridgedToolName`). Tokens, specialist allowlists and the audit log use this name; the MCP
  name is kept on the spec for the call. Two server tools whose sanitised names collide
  (`read file`, `read/file`) get `_2`, `_3` suffixes in code-point order of the server names
  (`assignBridgedNames`), so one approved name never stands for two server tools; the review
  says which server tool a renamed entry is.
- **Ownership**: every tool a connector grants carries its own prefix `<extension>.`; so does
  every tool a manifest from a URL or a remote catalog declares, of any kind, and every tool
  added later through `updatePermissions`. Built-in catalog entries (authored in this
  repository) may declare their module's names without the prefix. In every case a name that
  another extension row already grants (or has pending) or that the daemon lists as a built-in
  tool (`reservedTools`) is refused with `validation` before the row is written. Hence a
  manifest cannot shadow `browser.open`, and disabling one extension can never refuse another
  extension's tool or apply its ceilings to it.
- **Action class** (`inferActionClass`): the verbs in the tool name decide first, from the
  most severe class down: `financial` (pay, purchase, charge, transfer, …), `credential`
  (password, login, authenticate, …), `destructive` (delete, remove, drop, purge, wipe,
  revoke, …), `deploy_production` (deploy, release, rollout), `merge_pr` (merge),
  `external_send` (send, post, publish, email, notify, message, upload, share, …),
  `non_routine` (execute, run, shell, command, …), `routine_reversible` (create, write,
  update, edit, add, set, commit, push, …), `read` (get, list, read, search, fetch, query,
  describe, find, show, …). Server annotations may only tighten that result:
  `destructiveHint: true` raises the class to `destructive` when the name's class ranks
  below it (`CLASS_RANK`), never lowers one (`purchase_credits` stays `financial`);
  `readOnlyHint: true` gives `read` only when the name says read or nothing, and when it
  contradicts a severe verb (`delete_repository`, `create_issue`, `pay_invoice`) the name's
  class is kept and the review records `inferredFrom: "conflict:readOnlyHint,name:<verb>"`
  plus a summary line flagging the contradiction. No verb and no annotation → `non_routine`
  (runs freely only at autonomy 3+, asks below). Unknown verbs are never treated as reads.
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
- **Grant = what the panel shows**: the gate enforces `permissions.tools` (names) and
  `permissions.actionClasses` (a non-empty list is a ceiling: a bridged tool of another class
  is refused with `tool_not_allowed`); `grantedToolNames()` applies the same rule to decide
  what is bridged and which tokens a narrowing revokes. Nothing a server reports after
  approval can widen the grant: tools not in the approved list are not bridged, and a changed
  tool list shows up only through re-permissioning, which asks again.
- **Process**: a stdio server is spawned by `StdioMcpTransport` through
  `@forerunner/platform` `spawnProcess` (argv arrays, no shell string, `cmd.exe /c` shim
  handling on Windows) and speaks newline-delimited JSON-RPC with the SDK's `ReadBuffer`.
  Its `ChildProcess` is exposed, and the registry registers every connection with the kill
  switch (`agentId: "extensions"`, `sessionId: "extension:<id>"`, the child and an abort
  controller): `stop("all")` kills the process tree (`killTree`) and closes the client;
  a scoped stop for one agent or session leaves the shared connector alone (that agent's
  tokens are revoked by the kill switch itself); while the switch is frozen a new connection
  is cut off at once. `close()` ends stdin, sends SIGTERM, and kills the tree after 2 s.
- **Discovery before the yes** (who may start what, with which secrets):
  1. Nothing is ever started with a resolved secret before the human has said yes. Secret
     references are resolved only in `McpConnector.connect` for the granted names.
  2. A built-in catalog entry (authored in this repository) is started once for discovery at
     "add" time with every `secret:` reference stripped from its env or headers
     (`withoutSecretRefs`, granted set empty). Most servers list their tools without a
     credential; the review then carries the tools and the secret *names*, and one approval
     (`stage: "grant"`) installs it.
  3. A manifest from a URL, a remote catalog entry, a bare MCP endpoint URL, and a built-in
     entry whose secret-free discovery fails, are inserted pending at `stage: "discovery"`
     without starting anything: the review is built from the declared permissions plus
     "runs <command> <args>" / "connects to <url>" and "uses secret:<name>" lines. The human
     first allows that single start (the question names the command and the secrets); only
     then is the server started with those secrets resolved, its tools listed, and the real
     grant asked for (`stage: "grant"`). Each step is its own HumanRequest, audit row
     (`extensions.approve_discovery`, `extensions.discovered`) and event.
- **Cost**: MCP calls carry no price; `ExtensionRegistry.recordCost` adds what a capability
  module or a priced tool reports to the extension's counter.
- **Human override**: the review is what the human approves; `updatePermissions` can drop
  tools, classes, domains, paths, secrets or scopes at once (tokens listing a tool that is no
  longer granted are revoked); widening anything asks again.

## Consequences

- A connector works with the same hooks, tokens, audit and kill switch as built-in tools; no
  second enforcement path, and no connector process outlives a global stop.
- Inference errs on the safe side: an unannotated `frobnicate` asks for approval below level
  3; a tool the name and the server both call read-only runs at level 0; a tool the server
  calls read-only but the name says `delete` stays `destructive` and the human sees the
  contradiction. A stdio server runs on the host (no sandbox), so the class and the token's
  ceilings are the only bounds; this is why a server can never loosen a class.
- Installing anything that is not a built-in catalog entry costs two yeses. The first one is
  cheap to read (one command, the secrets it gets) and is the one that matters for safety;
  the second shows the tools. A built-in entry whose server needs its credential to boot also
  takes two yeses instead of being started with the secret early.
- Two concurrent adds of the same entry: the unique index on `(kind, name)` keeps one row and
  the second caller gets `validation: already installed` (HTTP 400), not a driver error.

## Alternatives considered

- Treat every MCP tool as `non_routine` and let the human classify each one by hand: safe but
  unusable for servers with dozens of tools; the review would be ignored.
- Trust the annotations only, defaulting absent `destructiveHint` to true as the MCP spec
  suggests: every unannotated tool would need a human at every level, which is the same as
  "unusable"; and the spec's default makes `readOnlyHint` the only reliable signal anyway.
- Annotations first, name second (the first version of this ADR): a server could label
  `delete_repository` read-only, run it at autonomy 0 and show it as low risk. Rejected.
- Full JSON-schema-to-zod translation: more code for little gain; the server validates its
  own inputs and the hooks only need the top-level fields.
- Discovery with resolved secrets before the yes (the first version): the daemon spawned any
  command a URL or remote catalog named, with the human's secrets in its env, at "add" time.
  Rejected: that is both "granting a new capability" and "sharing secrets" without a human.
- No discovery at all before the yes, for built-in entries too: one more question per
  install for entries this repository authored, for no gain in safety as long as the start is
  secret-free. Kept as the fallback when the secret-free start fails.
- Refusing a server whose tool names collide after sanitising instead of renaming: a server
  the human wants would be uninstallable for a cosmetic reason; the rename is deterministic
  and shown in the review.
