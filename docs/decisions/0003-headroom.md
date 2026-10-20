# 0003 — What to adopt from Headroom

Date: 2026-10-20
Status: accepted

## Context

Spec module N and Architecture item 6 ([forerunner-spec.md](../spec/forerunner-spec.md)) require a
context compression layer "Headroom (or similar)" as a local proxy in front of model calls, toggleable
per project, with savings measured and shown separately in the cost view (module I); prompt caching for
stable system prompts and project briefs; a state brief instead of raw history; and retrieval over memory
and docs under a token budget. Constraints: Forerunner is TypeScript on Windows and Linux ([ADR 0001](0001-stack.md)
rules out native dependencies on three platforms), live runs go through the Claude Agent SDK, which calls
the API itself and only accepts `ANTHROPIC_BASE_URL` to be redirected, and our own `ModelProvider` adapters
([types.ts](../../packages/runtime/src/provider/types.ts)) already carry `cache`, `Usage` with
`cache_read_input_tokens` / `cache_creation_input_tokens` and `countTokens()`.

Headroom was studied at commit `fbf7bc3` (2026-10-17, `headroom-ai` 0.41.0). What it is:

- A Python package (`pyproject.toml`: `requires-python >= 3.10`) whose compressors are a Rust extension
  loaded as a hard import with no Python fallback (`headroom/transforms/smart_crusher.py` docstring,
  `crates/headroom-core/`). On Windows the unsigned `_core.pyd` can be blocked by Smart App Control; the
  documented workaround is `HEADROOM_REQUIRE_RUST_CORE=false`, which keeps the proxy up but forwards
  traffic unoptimised (`wiki/troubleshooting.md` "Windows: DLL load failed").
- A proxy, `headroom proxy --port 8787` (`headroom/cli/proxy.py`), that speaks the native Anthropic
  Messages wire format (`headroom/proxy/anthropic_wire.py`), exposes `/health` (`status`, `ready`),
  `/stats` (lifetime and per-project `tokens_saved`, `headroom/proxy/savings_tracker.py` ~1540) and a
  loopback-only `POST /v1/compress`. Claude Code is pointed at it with `ANTHROPIC_BASE_URL`
  (`wiki/quickstart.md`; `headroom/cli/wrap.py` `_HEADROOM_ENV_KEYS`) and attributes traffic to a project
  with an `X-Headroom-Project` header (`headroom/proxy/project_context.py`, `project_policy.py`).
- Two modes (`headroom/proxy/modes.py`): `token` rewrites history for maximum savings; `cache` (the
  default, `server.py` `HEADROOM_MODE` fallback) freezes already-cached turns and compresses only the
  live zone, the newest tool result and user message, so the provider prefix cache keeps hitting
  (`wiki/ARCHITECTURE.md` "Live-Zone-Only Compression"; `headroom/cache/prefix_tracker.py`). It never
  drops messages (`wiki/transforms.md` "Context management").
- Transforms (`headroom/transforms/`): SmartCrusher for JSON arrays (keep first/last, errors, > 2σ
  outliers, BM25-relevant items, sample the rest), LogCompressor, SearchCompressor, TextCrusher,
  `cross_turn_dedup.py`, `dense_line_elider.py`, `lossless_compaction.py`, `read_lifecycle.py`,
  `tool_schema_compaction.py`, a detector-only CacheAligner (`cache_aligner.py`: it warns about UUIDs,
  ISO timestamps, JWTs and hashes in the system prompt and never rewrites it), and opt-in ML
  (Kompress/ModernBERT) and AST (tree-sitter) compressors.
- CCR (`headroom/ccr/`): originals are cached, a `headroom_retrieve` tool is injected and the proxy
  answers the model's retrieval calls itself, invisible to the client (`wiki/ccr.md`). `--no-ccr` and
  `--lossless` turn this off (`cli/proxy.py`).
- Measured results (`wiki/benchmarks.md`, `README.md` "Proof"): JSON arrays 83–91 %, build logs 94 %,
  grep output and source code 0 %, realistic agent sessions 21–57 %; blocks under ~300 tokens pass through.
  Savings are tokens before/after counted with the provider tokenizer; dollar figures are priced at write
  time into an append-only JSONL ledger that keeps compression and tool-schema savings apart and records
  the cache read/write mix (`headroom/savings_ledger.py`).
- The npm `headroom-ai` package is only an HTTP client for `/v1/compress` ("No compression logic runs in
  Node.js", `wiki/typescript-sdk.md`); its Anthropic adapter converts content blocks to OpenAI format.

## Decision

### 1. Headroom runs as an optional external process; Forerunner never depends on it

Forerunner does not bundle Python or Headroom. It ships a native TypeScript baseline (section 2) that is
always on, and treats a Headroom proxy as an accelerator that is used when present.

| Concern | Decision |
| --- | --- |
| Install | Listed in the Extensions panel (module L) as "Headroom proxy (optional)". `fr context install-headroom` runs `["uv","tool","install","--python","3.13","headroom-ai[proxy]"]` through `run()` from `@forerunner/platform` when `which("uv")` finds uv, otherwise it prints the per-OS steps from `wiki/quickstart.md` (`winget install astral-sh.uv` on Windows, the uv installer on Linux) and does nothing else. No shell strings, no pipe-to-shell. |
| Start | Two supported shapes. (a) User-managed: `headroom install apply --preset persistent-service` (on Windows Headroom maps this to a scheduled task, `headroom/install/planner.py` ~174) and Forerunner only probes. (b) Forerunner-managed, when `FORERUNNER_HEADROOM_MANAGED=1`: `spawnProcess(["headroom","proxy","--host","127.0.0.1","--port",port,"--mode","cache","--no-ccr","--lossless","--no-cache"])`, stdout/stderr to `appDirs().logs`, stopped with `killTree` on app exit and on the kill switch. `--no-ccr --lossless`: no injected tool and no hidden extra upstream calls outside our enforcement hooks. `--no-cache`: Headroom's semantic response cache would answer calls without the model, which would falsify the cost ledger and the critic's independence. `HEADROOM_TELEMETRY` stays at its off default; `--log-messages` is never passed. |
| Detect | `HeadroomAdapter.probe()` in `packages/runtime/src/context/headroom.ts`: `GET /health` on `FORERUNNER_HEADROOM_URL` if set, else `http://127.0.0.1:${FORERUNNER_HEADROOM_PORT ?? 8787}` (Headroom's own default, `headroom/cli/port_discovery.py`). Available only if `status === "healthy"` and `ready === true`, with a 500 ms timeout. Probed at app start, at every session start and every 60 s during a session via the session's `Clock`; `which("headroom")` separately yields "installed, not running" for the panel. Never a port scan. |
| Use | Only when the project's policy is `headroom` (section 4) and the probe passed. SDK driver: the subprocess env gets `ANTHROPIC_BASE_URL=<proxy>` and `ANTHROPIC_CUSTOM_HEADERS="X-Headroom-Project: <project_id>"`. Own Anthropic adapter: the client's `baseURL` is the proxy and the same header is sent. Our baseline still runs in front of it; the two layers compose because both only touch the live zone. |
| Absent or dead | Nothing fails. The baseline applies alone, the cost view shows "Headroom: not installed / not running / disabled for this project", a `context.headroom_unavailable` event is logged once per session. If the proxy dies mid-run, the call fails with `provider_error`, the retry policy (spec D) re-runs without the proxy, and the adapter stays unavailable until the next successful probe. |
| Security | Loopback bind only, never `--host 0.0.0.0`. The proxy sees the API key or OAuth header, so a non-loopback `FORERUNNER_HEADROOM_URL` is rejected with `validation`. Secrets never reach model context anyway (vault, by reference). |

### 2. Native baseline in `packages/runtime/src/context/`

Every transform is a pure, deterministic function `(text, ctx) => { text, changed, note }` that never
throws (parse failure or any error returns the input unchanged), is idempotent, and records its name and
tokens before/after. Transforms run only on the live zone: a tool result at the moment the in-process loop
appends it to the transcript, and the newest user text. `system`, `tools`, assistant blocks and earlier
turns are never rewritten, so the prefix stays byte-stable between calls (Headroom's `cache` mode
invariant, `prefix_tracker.py`). The original of every changed block is written, after `redact()`, to
`join(appDirs().cache, "context", sessionId, hash + ".txt")` so the log view can show it and a retry can
re-expand it; it is deleted with the session's retention. Order per block: `logs → dense → dedup → json →
truncate` (lossless first, lossy last).

| Transform | Algorithm sketch | Mirrors |
| --- | --- | --- |
| `logs.ts` whitespace and log collapsing (lossless) | Normalise CRLF to LF; strip ANSI SGR `ESC[...m`; drop trailing whitespace; keep only the last segment of a line that contains `\r` (progress bars); collapse 3+ consecutive identical lines to one line plus `... (repeated N times)`; collapse 3+ blank lines to one. | `lossless_compaction.py` `strip_ansi`, `collapse_runs` |
| `dense.ts` dense-line elision | A line is dense if length ≥ 300, spaces < 6 % of chars, no tab, and not JSON-shaped (`{`/`[` first and `}`/`]` last). Only if dense lines total ≥ 2,000 chars: keep 160 head and 80 tail chars, replace the middle with `...[N chars elided]...`. Catches minified JS, base64, bundles. | `dense_line_elider.py` (same constants) |
| `dedup.ts` repeated-block dedup | (a) Within a block: rolling hash of 3–64-line windows; a window seen earlier in the same block becomes `... (repeats N lines from M lines back)`. (b) Across tool results in a session: index `hash(line) → (turn, lineNo)` for emitted results; a contiguous span of ≥ 8 lines and ≥ 200 chars present verbatim in a strictly earlier result becomes `[same as tool result #k lines a–b]`. The earliest occurrence is never rewritten and matching looks only backwards, so appending a turn never changes an earlier one. Lines under 4 chars or in a trivial set (`}`, `return`, `pass`, …) cannot anchor a match. | `lossless_compaction.py` `fold_repeated_blocks`; `cross_turn_dedup.py` (prefix-monotonic, keep-earliest) |
| `json.ts` JSON array thinning | Parse; for every array of ≥ 30 objects (recursing to depth 5): keep the first 3 and last 2, every item with an error signal (`status`/`level`/`severity`/`error` field in an error set, or any string field matching the error regex), numeric outliers (> 2σ on a numeric field present in ≥ 80 % of items), then an even sample up to 25 items total, in original order, plus a final `{"_omitted": N, "_of": total}` item. No relevance scoring in 1.0. Not applied to a block whose tool profile says `skip`. | SmartCrusher (`wiki/transforms.md`, `LIMITATIONS.md` "JSON Compression Constraints") without BM25 and without the `[N]{schema}` CSV densification |
| `truncate.ts` head/tail truncation with error retention | If tokens > the cap (`maxToolResultTokens`, default 4,000; `read_file`-class tools 16,000): collect up to 20 lines matching `/\b(error|fatal|exception|traceback|failed|panic|assert|denied|timeout)\b/i` with 2 lines of context each, plus pytest/npm/cargo/vitest summary lines; emit head (60 % of the char budget), then `[... N lines, ~M tokens omitted; original <hash>]`, then the error block, then tail (40 %). A `FATAL` at line 67 of 100 survives. | `log_compressor.py` config (`max_errors`, `error_context_lines`, `keep_summary_lines`), `error_detection.py` keyword set |
| `summarise.ts` old-turn summarisation | When the in-process transcript exceeds `compactAtTokens` (default 60 % of the model's context window) or at session end: turns older than the last `keepRecentTurns` (8) are replaced by one `[state brief]` user block written by the cheap tier at low effort under its own budget line from a fixed template (goal, done, files touched with hashes, open questions, decisions, next steps; ≤ 1,500 tokens) plus a deterministic list of the tool calls it replaces. Superseded file reads (same path read again, or edited after the read) are dropped from the summarised range outright. The brief is cached by hash of the range so a retry never pays twice. A deliberate, rare prefix change (once per tens of thousands of tokens) after which the new prefix is cached. SDK-driven sessions rely on the SDK's own compaction plus the startup state brief from the checklist (spec E). | Deliberately not Headroom (it never drops messages); Headroom's `read_lifecycle.py` for stale/superseded reads |
| `cache-layout.ts` cache-aligned prefix layout | Requests are assembled in a fixed order: `tools` (schema-compacted: drop `$schema $id $comment title examples example deprecated readOnly writeOnly markdownDescription`, collapse description whitespace, memoised by hash of the tool set), `system` = registry prompt → project brief → scope `instructions.md` and pinned lessons (static), then messages = state brief → budgeted retrieved lessons → history. `cache: { system: true, tools: true }` is set and the Anthropic adapter marks the last tool and the last static system block with `cache_control: {type: "ephemeral"}`. Anything volatile (date, time, session id, budget left, inbox count) goes into the first user message. `assertStablePrefix(system)` rejects ISO timestamps, UUIDs, JWTs and 32/40/64-hex hashes in `system` (a `validation` error in tests, a warning event in production). | `tool_schema_compaction.py` `TOOL_SCHEMA_DROP_KEYS`; `cache_aligner.py` detector classes |
| `budget.ts` retrieval under a token budget | `fitToBudget(items, maxTokens, countTokens)`: greedy by rank, whole items only, returns kept items and tokens used; the memory package ([ADR 0002](0002-operator-memory.md)) calls it for lessons and docs. | Spec G and N |

Tool profiles (per project, section 4) default to `read_file`-class tools: `maxTokens: 16000`, no `json`;
`git_diff`/`diff`: no `dedup`; everything else: all transforms. Not adopted for 1.0: ML text compression,
AST code compression (code and grep output pass through, as in Headroom's own benchmarks), CCR retrieval,
output shaping (`HEADROOM_OUTPUT_SHAPER`: we set effort ourselves, spec D), thinking compaction.

### 3. Savings are measured per call and summed per project

- Per model call the pipeline records `tokens_before` (the request as it would have been sent with no
  transforms, counted with the same `countTokens` used for budgeting) and `tokens_after` (what was sent),
  `context_transforms` (names applied) and `headroom_used`. The provider's `usage` is the billed truth:
  `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- Three savings are kept apart, as Headroom's ledger does: `compression_saved_tokens =
  tokens_before - tokens_after` (labelled *estimated*, it is counterfactual); `cache_saved_tokens =
  0.9 × cache_read_input_tokens` (labelled *measured*; Anthropic reads cost 10 % of input,
  `prefix_tracker.py` `_PROVIDER_READ_DISCOUNT`), with `cache_write_tokens` shown beside it because writes
  cost 1.25×; `headroom_saved_tokens` from the proxy's `/stats` `projects[<project_id>].tokens_saved`
  delta between session start and end (the SDK calls the proxy directly, so per-call attribution is not
  possible there; the proxy sets no per-response savings header).
- Storage: the Run gains `tokens_before`, `tokens_after`, `cache_read_tokens`, `cache_write_tokens`,
  `context_transforms`, `headroom_used`; the Session gains `headroom_saved_tokens`. Money follows
  ADR 0008: saved tokens × the model's input price → USD micro-units plus CHF at the day's rate, written as a `cost_ledger` row of kind `saving` so the allocation view can sum by project,
  specialist and model. The cost view shows "Saved by compression (estimated)", "Saved by caching
  (measured)" and "Saved by Headroom" as separate lines, never netted against spend.
- A `context.compressed` event per call carries the numbers into the live log; nothing in it contains
  block content.

### 4. Configuration surface

- Project setting `context` in the state store (defaults in code, editable through the command registry
  with a change card and undo, module Q): `{ compression: "off" | "native" | "headroom" (default
  "native"), maxToolResultTokens: 4000, compactAtTokens: 0.6, keepRecentTurns: 8, toolProfiles: {} }`.
  `headroom` means native plus the proxy when available and falls back to native with a visible notice;
  it is never silently off. `off` disables everything except `cache-layout`, which costs nothing.
- Per-call bypass: `ModelRequest.compression?: "default" | "off"`. The critic driver sets `"off"` on every
  critic call and spawns critic SDK sessions without `ANTHROPIC_BASE_URL`, so the critic reviews the
  evidence as produced (spec H: low confidence never becomes accept; a truncated log must not hide a
  failure). Evals and the model watch also run with `"off"` so quality deltas are not confounded.
  A bypassed request is byte-identical to the input (tested).
- Environment (`FORERUNNER_*` only, nothing hardcoded): `FORERUNNER_HEADROOM_URL`,
  `FORERUNNER_HEADROOM_PORT`, `FORERUNNER_HEADROOM_MANAGED`.
- Enforcement: compression never blocks a call and never raises into the loop; the budget hook counts
  the request after compression, so savings lower spend but cannot bypass a cap.

## Consequences

- Phase 1 ships `logs`, `dense`, `dedup`, `truncate`, `cache-layout`, `budget` and the measurement; `json`
  and `summarise` land with Phase 4 (memory and state brief); the Headroom adapter and the Extensions
  entry land with Phase 6 ("Context compression proxy, savings shown").
- Tests in `packages/runtime/test/context.test.ts`: golden fixtures per transform, determinism and
  idempotence, `tokens_after ≤ tokens_before`, no-op on malformed input, the FATAL-at-line-67 case, the
  stable-prefix lint, byte-identical bypass; `headroom.test.ts` drives the adapter against an in-process
  `node:http` fake serving `/health` and `/stats` (absent, unhealthy, healthy, dies mid-session);
  `headroom.integration.test.ts` runs against a real proxy only when `FORERUNNER_TEST_HEADROOM_URL` is set
  and skips visibly otherwise. The Phase 6 gate adds a replayed eval set: ≥ 30 % compression savings on
  tool-heavy transcripts with no golden task failing.
- Maintainer docs: [runtime.md](../maintainers/runtime.md) gets a "Context layer" section,
  [billing.md](../maintainers/billing.md) the savings lines, the data model regenerates with the new Run
  and Session fields.
- Known trade-offs: `summarise` is a deliberate cache miss; `json` without relevance scoring can drop the
  one item the agent needed (the original is one click away and a re-read tool call away);
  `tokens_before` is an estimate, so the cost view says so.

## Alternatives considered

- Bundle Headroom (uv-managed Python or PyInstaller): hundreds of MB, a Python toolchain in our
  installers, an unsigned native extension on Windows. Rejected for 1.0; revisit if a signed Windows
  wheel ships and the Extensions panel shows real demand.
- Use the npm `headroom-ai` SDK: it needs the same running proxy and converts Anthropic blocks to OpenAI
  format on the way (`wiki/typescript-sdk.md`), losing cache_control and thinking blocks. Rejected.
- Port `crates/headroom-core` to Node via napi or wasm: feasible later; a native dependency on three
  platforms today (ADR 0001). The baseline keeps Headroom's invariants so a later swap is an adapter change.
- Run the proxy in `token` mode or with CCR on: history rewrites bust the 90 % read discount, and CCR adds
  an injected tool and extra upstream calls outside our hooks. Rejected.
- Summarise every tool result with a model: cost and latency on every call and non-deterministic output
  that busts the prefix. Used only at compaction points.
- A rolling window that drops old turns silently: Headroom removed its own (`wiki/transforms.md`); we
  replace turns with a brief and keep the originals on disk.
