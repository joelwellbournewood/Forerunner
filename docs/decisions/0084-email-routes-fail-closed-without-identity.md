# 0084 — Email routes: a mount that identifies humans without an identity port fails closed per request, and an owner-check refusal is an audited 403 that stands without its row

Date: 2026-10-23
Status: accepted

## Context

`emailRouteTable` (`packages/capabilities/src/email/routes.ts`) serves the seven routes of
Settings -> Capabilities -> Email under `/agents/:agentId`. A mount passes `humanFor` (the
signed-in human of a request; in the daemon its one human, the convention of ADR 0039 point 9)
and `identity` (who owns an agent), and the owner check refuses a human who is not the agent's
owner, so on a shared state one human cannot point another human's agent at their own address
or enable its commands (S.15; the cross-human settings write of the 2026-10-20/21 security
review). The check was applied only when both were set: with `humanFor` alone the table
warned and served every request, so a daemon that identifies humans but forgets the port
reopened the write. Open points: what such a mount does (refuse per request, or throw at
construction so the daemon does not start), how a refusal is recorded, and what a refusal
answers when its audit row cannot be written.

## Decision

1. **A mount with `humanFor` and no `identity` fails closed per request.** Every route under
   `/agents/:agentId` answers 403 `tool_not_allowed` with `details.reason:
   "identity_port_missing"`, the human's own agent and an anonymous request included, and the
   table logs the misconfiguration once at construction at `error` level, naming the fix. Only
   a mount that identifies nobody (no `humanFor`: a single-user daemon) applies no check. The
   owner mismatch keeps its 403 with `reason: "not_owner"`.
2. **Every refusal is an audit row like a blocked send.** An `email.settings` row with
   `allowed = false`, `denied_reason` the stable code (`EmailOwnerRefusal`; the key to filter
   on), `input_summary` `{ action, refused }`, `result_summary` `{ status: "refused", reason }`
   (JSON, the shape of the blocked-send rows' `{ status: "blocked", reason }`, so a reader that
   parses the column never throws), `human_id` and `author_human` the signed-in human and
   `agent_id` the agent aimed at, so the agent's owner sees the attempt, by whom and for which
   action.
3. **The refusal stands without its row.** When the audit store fails, the request still
   answers 403 with its code and reason; the gap is one `warn` line (`owner-check refusal not
   audited`) naming the agent, the action, the reason and the store's message, never a 500
   carrying that message to the UI.

## Consequences

- A daemon that forgets the port fails visibly: every Settings -> Email and tray pause/resume
  call answers 403 `identity_port_missing` with the reason in the body, and the log says so at
  startup. The daemon's mount must pass `identity` beside `humanFor`
  (`new StoreIdentityLookup(store.agent, store.human)`; the snippet in `email.md`).
- The owner of an agent sees every attempt on it in their audit; the sent log and the command
  audit filter on their own tool names and skip these rows.
- An attempt made while the audit store is down leaves only a log line, not a row.

## Alternatives considered

- **Throw at construction** when `humanFor` is set without `identity`, so a misconfigured
  daemon refuses to start. Stricter and a one-line change; not taken because the mount is a
  code path, not configuration (the mistake is caught by the unit tests that mount the table
  the daemon's way), and a daemon that starts and refuses every call with a reason in every
  response is diagnosed from the UI, where a daemon that does not start is diagnosed from a
  log nobody has open. Revisit if a mount is ever built from configuration.
- **Let an audit failure surface as 500** (the behaviour before this ADR), so a missing row is
  never silent. Rejected: nothing is written either way, the refusal's code and reason are
  what the UI and the tray act on, and the warn line keeps the gap visible.
- **`denied_reason` as `code: message`** like the runtime's gate rows. Rejected: the code
  alone is the key to filter on; the message is in the response and the log.
