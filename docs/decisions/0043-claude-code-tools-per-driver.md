# 0043 — Claude Code tool names in the registry, mapped per driver

Date: 2026-10-20
Status: accepted

## Context

Registry specialists name their tools as Claude Code tools (`allowed_tools: cc:Read, cc:Edit,
cc:Bash, ...`; `CLAUDE_CODE_PREFIX` and `KNOWN_CLAUDE_CODE_TOOLS` in
`packages/runtime/src/registry/types.ts`) because ADR 0004 puts coding specialists on the Agent
SDK driver, which offers that tool set as is. The daemon's one session path, however, runs every
specialist through `LoopTaskExecutor` on `LoopAgentDriver`, whose `ToolRegistry` holds
Forerunner's own tools (`read_file`, `write_file`, `list_dir`, `run_command`, the bridged
extension tools, the Cloudflare, desktop and data tools). The executor derived the run token
with the entry's `allowed_tools` as written and the driver offered the intersection of the
token with its registry: a registry coder on the loop driver had no tools and every task
produced nothing. The first live run (ADR 0040, item 5) worked around it by rewriting a registry
copy. The model watch's eval runner carried a private `cc:` to built-in table that the daemon
path did not use. The spec leaves open where the mapping lives, what each driver does with the
names, what `cc:Bash` may yield, and what happens to a name with no equivalent.

## Decision

1. **The registry keeps naming Claude Code tools.** The file format and the loader's validation
   are unchanged: a specialist names `cc:<Tool>` for Claude Code tools and Forerunner names for
   everything else; `*` stays rejected. The prompt version hash does not depend on the driver.
2. **Each driver maps the names; the choice is made next to the driver.** `composeRuntime`
   builds the driver and sets `specialistDriver` ("loop" today: the Agent SDK driver, the
   subscription path, has no session path yet). `specialistSpecFrom(registry, { driver, tools,
   commands, onDropped })` follows it: on "sdk" the `cc:` names stay as written (the SDK driver
   strips the prefix itself); on "loop" `loopToolsFor` (`src/registry/tools.ts`) replaces
   them. Without options the names stay as written (the SDK form).
3. **The loop driver's table** (`CLAUDE_CODE_TOOL_EQUIVALENTS`): `Read`, `NotebookRead` →
   `read_file`; `Write`, `Edit`, `MultiEdit`, `NotebookEdit` → `write_file`; `Glob`, `Grep`,
   `LS` → `list_dir`; `Bash` → `run_command`. `WebFetch`, `WebSearch`, `Task` and `TodoWrite`
   have no equivalent and are dropped. Order follows the entry; duplicates collapse; nothing is
   added that the entry did not name (`cc:Read` cannot yield `write_file`; `cc:Bash` yields
   `run_command` and nothing else). Forerunner names pass through while the tool is registered
   at the moment of the lookup (bridged extension tools come and go), so the mapping is resolved
   at every run start against `toolsForRun()`.
4. **`run_command` only under a sandbox promise.** `cc:Bash`, or `run_command` by name, is
   granted only when the entry has `requires_sandbox: true` or the composition sandboxes every
   command: the daemon always wires a `RunSandboxPort` (a container or the process stand-in,
   ADR 0007) and the executor pins `run_command` to the run's lease, so in the daemon the policy
   allows it; the eval runner passes whether it holds a sandbox port, so an eval without one is
   never offered a command runner. Otherwise the name is dropped with reason
   `commands_not_allowed`.
5. **A dropped name is never silent.** Every name the loop driver will not offer is an audit row
   `registry.tool_unmapped` (`allowed: false`, `input_summary: "<specialist>: <tool>"`,
   `denied_reason: "tool_not_allowed: <why>"`, the agent and human of the install), once per
   specialist and tool for the life of the composition: at compose for every runnable entry
   (awaited before the first run) and at a later run start for a bridged tool that has gone.
   The eval runner logs the same drops.
6. **The token carries the mapped names.** `LoopTaskExecutor` derives the run token from the
   spec's `allowedTools` (now the built-in names), intersected with the session grant that lists
   every registered tool, so the hooks' allowlist check sees the names the driver calls; a call
   to a tool the entry did not grant is refused by the hooks with its own audit row
   (`tool_not_allowed`).

## Consequences

- A registry coder runs on the loop driver with `read_file`, `write_file`, `list_dir` and, in
  the daemon, `run_command` inside the sandbox lease. The live harness's registry rewrite (ADR
  0040, item 5) is no longer needed for the tools; its budget, turn and timeout overrides may
  stay.
- The SDK branch is a seam: when the subscription path lands, compose sets `specialistDriver`
  to "sdk" for it and nothing else changes.
- The cloud runner composes its own executor with `specialistSpecFrom(rt.registry)` (no
  options) and keeps the registry's names; it should take `rt.specialists` from the composed
  runtime instead. That is a follow-up outside this change.
- A researcher on the loop driver loses `cc:WebFetch` and `cc:WebSearch`; the audit log says
  so. Web research on the loop path needs a fetch tool bridged by an extension and named in the
  registry by its Forerunner name.
- `loopToolNamesFor` and the eval runner's private table are gone; the one table and function
  live in the registry module and `RuntimeApp` exposes `specialistDriver` and `specialists`.

## Alternatives considered

- **Rewrite `allowed_tools` in the loader.** Rejected: the registry is driver-neutral, the SDK
  driver needs the original names, and the prompt version hash must not depend on the driver.
- **Map in the executor when deriving the token.** Rejected: the executor knows neither which
  driver the composition chose nor the registry entry (`requires_sandbox`); the composition
  root knows both and the spec is the executor's input.
- **Alias `cc:` names inside the loop driver at call time.** Rejected: the token would carry
  names the hooks never see called; the allowlist check must match the called name.
- **Grant every file tool to a specialist that names any `cc:` tool.** Rejected: it widens
  (`cc:Read` would give `write_file`); the cap is per name.
- **Drop silently, as the eval runner did.** Rejected: a specialist that lost a tool must show in
  the audit log, not only in a model's confused report.
- **Grant `run_command` whenever `cc:Bash` is named.** Rejected: commands run on the host when
  no lease exists; the grant follows the sandbox promise.
