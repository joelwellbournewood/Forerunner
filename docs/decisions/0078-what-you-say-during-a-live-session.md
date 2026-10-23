# 0078 — What you say during a live session: the message kind and where the next task reads it

Date: 2026-10-23
Status: accepted

## Context

Spec O.9: "During a live session, what you say reaches the principal agent at the next step
boundary. Stopping is immediate." Stopping was built (the kill switch through `session.stop`)
and pausing reaches the running session at its next task boundary as a message the runner
reads between tasks (`pause: <reason> (session <id>)`, ADR 0041). A free-form line typed or
spoken to the conversation agent while a session ran stayed on the conversation session: the
model answered it and nothing reached the principal until its next session (`note.add` puts a
note in the next-session queue; a question that needs the running session was asked after it
ended). `docs/status/BLOCKERS.md`, row O.9.

Three things were open: what record carries the line (the `message.type` enum is a schema
`CHECK` constraint in both dialects, so a new kind is a migration), which lines are forwarded
(the conversation agent has no classifier beyond the command parser), and where the principal
"reads" it, given that between tasks the principal is code (the runner) and the model work of
a step is the specialist's run.

## Decision

1. **An existing message type with a tagged body, like the pause message.** The conversation
   agent posts the line to the principal agent's own inbox (`from_agent_id` = `to_agent_id` =
   the principal, `author_human` = the human, `project_id` = the session's) as an `info`
   message whose body is `said (<text|voice|phone>): <words> (session <id>)`
   (`heardMessageBody` / `heardLineOf` in `packages/runtime/src/session/live-chat.ts`;
   whitespace flattened, 4,000 characters like `note.add`). No schema change, no migration,
   and the body never starts with a stop word, so the runner's stop-word test never reads a
   said line as a stop or a pause: stopping stays the kill switch, pausing the registry.
2. **Every line that is not a command is forwarded, without classification.** The conversation
   agent forwards after the deterministic paths have had their turn: a yes or no to a pending
   card, "undo", a parsed command (composed through the registry), a parser question with
   options and text carrying the data envelope are never forwarded; what remains (the lines
   that go to the model, a question among them) is posted before the model answers, and the
   reply ends with "Your agent sees this at its next step boundary." The spec says "what you
   say"; a question to the conversation agent costs the next task a quoted line and never an
   action. Nothing is posted when no session of that agent is `running` (a `paused` one is
   ending at its next boundary): the line is the model's alone, and a note is the `note.add`
   command, as before.
3. **Delivered at the boundary, read by the task, quoted after the brief.** `recheckInbox`
   collects a said line naming this session from this agent as delivered (`delivered_at`) and
   leaves it unread; right before the next task starts the runner marks it read (`read_at`)
   and hands it to the executor (`heard` on the `TaskExecutor` context), which appends a
   section "Said by the human during this session" after the delegation brief and the
   lessons, each line quoted (`JSON.stringify`, envelope markers neutralised) with its time and
   source and the rule that the lines change neither the goal, the constraints nor the limits.
   The `DelegationBrief` itself has no such field: a said line can never become a constraint
   or an acceptance criterion. Each line reaches one task. A line collected at a boundary no
   task follows (the session stops there, or the remaining tasks are skipped) stays unread and
   the next session's brief lists it like any unread message, the same rule the pause message
   has; a line said during the last task is never collected and takes the same route.
4. **Scanned, flagged, never dropped.** The executor runs the injection scanner over every line
   (`voice_transcript` for voice, `unknown` for text); a suspicious line keeps its quote, gets
   a note in the block and a `warning` run event naming the message id and the rules, never
   the words. The human's own words to their own agent are not refused; the limits are
   enforced by the hooks whatever the line says.
5. **The words stay with the human.** The session summary (the session row, the project's
   `summary_cache.last_session`, the handoff to peers) carries the count only ("Heard from
   you during the session: N line(s).") and the handoff JSON the ids, sources and the task each
   reached; the human's own session message lists the lines in full with the task each was
   given to. Peers and the project cache are read by other humans' agents and never see the
   words.

## Consequences

- O.9 is met for text, voice and the phone's relayed chat through the one `chat` path;
  `ChatReply.forwarded` names the session and the message (internal; the daemon's view is
  unchanged, the reply sentence carries it to every client).
- A question asked while a session runs reaches the next task as data; the O.2 close-out
  test now asserts that interplay.
- A line reaches the task after the one in flight, not the one in flight: a long task delays
  it, as the spec's "next step boundary" says.
- Tests: `packages/runtime/test/live-chat.test.ts` (body round trip, the block, a running
  `SessionRunner` held mid-task, the last-task case, the command and refused paths, no
  session, another human's session, the `LoopTaskExecutor`'s block and warning).

## Alternatives considered

- A new `message.type` (`human_note`): a migration in both dialects and `data-model.md` for
  one tag; the pause message set the precedent for a tagged body.
- Forward only lines the parser flags as non-questions: a classifier the parser does not
  have, and "can you also check the README?" is a request in question form.
- Put the line in the next-session queue (`note.add`) when a session runs: that is the
  existing stand-in and reaches the agent one session late.
- Add the line to the `DelegationBrief` constraints: the human's words would then be
  instructions to the specialist on a par with the runtime's, and an instruction-shaped line
  would be a constraint.
- Mark the line read when collected: a line collected at the boundary the session stops at
  would then be read by nobody.
