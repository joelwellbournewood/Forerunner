# Review: w4-metered-aborted

Branch `wave/w4-metered-aborted`, reviewed at 2b96212 against `origin/ccr-4d8a843c-1k9syk`
(c713755; the branch's merge base is e1e820b, `git merge-tree --write-tree HEAD
origin/ccr-4d8a843c-1k9syk` is clean).

## Review

Verdict: **revise**. Score: 78/100 (as built at 2b96212).

The core of the brief is built and proven: `MeteredProvider` (`tests/live/src/metered.ts`)
classifies a call as `aborted` whenever the request's signal had fired when the call settled,
whatever the last event, and records the input-side usage that the Anthropic adapter now
reports on `message_start`. Three of the new `metered.test.ts` cases fail on the base's
`metered.ts` (checked by swapping the base file in: 3 failed, 7 passed) and three of the new
`anthropic-provider.test.ts` cases fail on the base's `anthropic.ts` (3 failed, 6 passed). The
in-flight accounting settles to zero in every new case. What is wrong: the adapter's new abort
path drops a killed call's billed input tokens from the runtime's own run cost, one test (and
the doc that cites it) does not build the shape its name claims, one edge case contradicts the
documented status rule, and ADR 0040 still states the blind spot that the branch closes.

Requirements checked:

- Brief: "classify a call as `aborted` whenever the run's abort signal fired before the call
  settled, whatever the stream's last event": met (`metered.ts` `abortedAtEnd ?? signalAborted()`),
  except for a thrown abort after a complete message (finding 3).
- Brief: "record the usage from `message_start` when the stream reported it before the abort":
  met. The adapter yields `usage` on `message_start` (`anthropic.ts:146`, `types.ts:96`), and
  the metered provider settles `usage ?? startUsage` with a note.
- Brief: "unit test with a fake inner provider whose stream ends cleanly after the abort, and
  one whose stream throws AbortError": met (`cutOffProvider("message_end")`,
  `cutOffProvider("throw")`); the "probe's shape" case is mislabelled (finding 2).
- budget.ts in-flight accounting settles to zero either way: met; every new case asserts
  `inFlightUsd === 0`.
- Ledger row shape kept: met (`SpendRow` unchanged, only `note` text added).
- The kill path: `LoopAgentDriver` passes `controller.signal` (registered with the kill switch)
  to `provider.stream`, so the metered wrapper sees the kill's abort on a real caller. Traced in
  `packages/runtime/src/agent/loop.ts:178-186, 253-266`.
- Phase 1 gate kill-switch row (tests/live): the assertion `calls.some(c => c.status ===
  'aborted')` in `live-1-phase1.live.test.ts:390` is now satisfiable for the probe's shape. It
  can only be proven by a live run, which needs a key that this environment does not have
  (open point).
- V.6 row: unaffected in substance (timing table); the brief lists it because the live harness
  carries it.
- Docs: testing.md "Live runs", Tests and Known issues (2) updated; runtime.md and
  adding-a-provider.md describe the adapter change. ADR 0040 is stale (finding 4) and testing.md
  misdescribes one test (finding 2).
- Test counts in testing.md ("46 unit tests over 5 files"): match `cd tests/live && pnpm exec
  vitest run` (5 files passed, 4 skipped; 46 passed, 14 skipped).
- Semantic conflict with the base: none. The base moved e1e820b..c713755 (desktop confirm,
  voice prefs, B.5 reasons, stale docs) and touches neither `tests/live`, the provider nor the
  loop driver. The merge is textually clean.
- Security and privacy: error texts still go through `redact` before the reason, the note and
  the audit row; the new reason strings are fixed text. No regression.

Findings:

1. **medium**, `packages/runtime/src/agent/loop.ts:271` (with `packages/runtime/src/provider/types.ts:165`
   `collectStream`). The adapter now ends a killed stream with `error: aborted` instead of the
   SDK's silent `message_end`. That is right, but the loop driver throws on `stop_reason:
   "error"` without counting the reported usage, and `collectStream` ignores the new
   `message_start.usage`. A session killed mid-call through the real Anthropic adapter now
   reports run cost 0 for that call. Before the branch, the cost included the billed input
   tokens (the silent `message_end` carried them). Verified with a throwaway loop test (a
   provider yielding `message_start` with 5000 input tokens, then waiting for the abort): the
   `message_end` shape (base behaviour) gave `outcome killed, costUsdMicro 5000, usage.input_tokens
   5000`, and the `error: aborted` shape (branch behaviour) gave `killed, 0, 0`. The Run row and
   the session budget therefore under-count a killed call: a cost regression on the kill path
   that the branch introduced. Needs: `collectStream` keeps the `message_start` usage, the loop
   adds a cut-off call's reported usage and cost to the run before it rethrows the abort, and a
   loop test proves it.
2. **low**, `tests/live/test/metered.test.ts:217` and `docs/maintainers/testing.md:1692`. The
   case "the probe's shape: aborted before the message opened" uses `cutOffProvider`, which
   always yields `message_start` and a `text_delta` before it waits. The message *had* opened,
   and testing.md says the case has "no `message_start`". The test proves the clean end with
   zero usage, not the shape that its name and the doc claim. Verified by reading
   `cutOffProvider` (lines 70-90). Needs: the fake can open with no events, and the case uses
   that option.
3. **low**, `tests/live/src/metered.ts:151-154`. The documented status rule (metered.ts header,
   testing.md "The status of a call") says that a call whose `message_end` arrived before the
   signal fired "completed, and stays `ok`". If the inner stream then throws an `AbortError`
   (a provider whose iterator waits on the open body after the last event, as the SDK's does),
   the `catch` sets `status = "aborted"` and the `finally` keeps it: the call is recorded
   `aborted` with the reason of the throw. Verified by tracing: `abortedAtEnd` is `false`, so
   the `finally` takes the `else if` branch, and that branch only touches `status === "ok"`.
   Needs: the status rule holds on the throw path too, with a test.
4. **low**, `docs/decisions/0040-live-model-harness.md:37-39`. The ADR still says that "the
   Anthropic adapter yields usage only on `message_end`, so an aborted call's billed input
   tokens are not visible to the harness", which disagrees with the code after this branch.
   Verified with `git grep "usage only on"`. Needs: an amendment note in the ADR (the decision
   stands; the stated limitation narrowed).
