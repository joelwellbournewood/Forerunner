# w3-o9-chat-to-inbox

Item: what you say during a live session reaches the principal agent at the next step boundary
(spec O.9; ADR 0078): "stop" is immediate through the kill switch, "pause" reaches the running
session at its next task boundary, any other line typed or spoken while a session runs is posted
to the principal's inbox, collected by the runner between tasks and quoted to the next task as
data. Built on `wave/w3-o9-chat-to-inbox`, merged on 2026-10-23 in `9a29df6` (1 commit, 8
files, +1029/-13) without a review. Reviewed on 2026-10-25 on the integration head
`ccr-af5a431d-jc9xqj` (`7452879`), with the later merges in place (the E.4 end-of-session
re-check, ADR 0088 late approvals, the identity and email items). None of the 13 commits since
`8c9f499` touched the item's code.

## Review

Verdict: **revise**. Score: **62**.

What was checked: the brief (`briefs/w3-o9-chat-to-inbox.md`) clause by clause against the code
on the current head; ADR 0078; runtime.md's conversation and session sections; the E.4 review
(`w3-e4-recheck.md`), ADR 0061 and ADR 0088 for interplay. Code traced from every real caller:
the conversation agent's command path (`packages/runtime/src/conversation/agent.ts:268-336`),
`POST /chat` and `/chat/stream` (`daemon/server.ts:1102-1130`), the voice bridge's
`converseTurn` (`voice/bridge.ts:751-800`, `source: "voice"`), the phone's relayed `chat`
command (`remote/watcher.ts:552-562`, `source: "phone"`, the PC's own human and agent); the
runner's `recheckInbox` (`session/runner.ts:1816-1877`), the boundary read before the next task
(`runner.ts:828-848`), the end re-check (`atEnd`, `runner.ts:1115`), the executor's block
(`session/executor.ts:594-600`, `live-chat.ts`). The item's tests run green on the head
(`live-chat.test.ts` 8, `closeout-conversation.test.ts` 5). Mutation check: with the
`markRead` before the task removed (`runner.ts:833`), `live-chat.test.ts` test 1 fails on the
read receipt (the "read between the tasks" claim is proved); the body round trip, the stop-word
immunity (`said (...)` never matches `STOP_WORD_RE`), the envelope neutralisation and the
flagged-line warning are each asserted by a test that names them. Verified right: a said line
is collected as delivered and left unread until a task's brief carries it; a line collected at
a boundary that the session then pauses or stops at (`recheck.interrupt`) stays unread and the
next session's checklist lists it (`inbox` with `unreadOnly` is `read_at IS NULL`; probed with a
real `SessionRunner`, the pause port and a second session: in the brief, then read); a line
said during the last task takes the same route (test 2); the E.4 end re-check skips said lines
so the session-end writes never consume one; peers' handoff and the project cache carry the
count only, the human's own session message the words; the hooks, not the block, enforce the
limits, and `DelegationBrief` has no field a said line could reach. The phone's relayed chat and
the voice bridge go through the one `chat` path, so a line from either reaches the session with
its source, and the reply sentence is spoken (`unstreamedPart`). The known P2 (a line reaches
the task after the one in flight) is as the spec says and documented. What follows is what is
wrong.

1. **[HIGH] A "stop" with another clause in the sentence is swallowed: nothing stops, the
   model answers, and the line is forwarded to the running session as data.**
   `packages/commands/src/intent.ts:221-247`: the parser splits "stop and tell me what
   happened" into "stop" (matched `session.stop`) and "tell me what happened" (unmatched) and,
   because something was not understood, returns no commands and a question with
   `matched: "none"` (line 240-247). `packages/runtime/src/conversation/agent.ts:307-321` reads
   `matched: "none"` as "no pattern understood" and sends the line to the model, and line 327
   posts it to the principal's inbox as a said line. The human said stop; the session keeps
   running and the next task reads "stop and tell me what happened" as a quoted note. Spec O.9:
   "Stopping is immediate." Verified with a throwaway test on a `SessionRunner` held mid-task
   and a kill port spy: reply "... Your agent sees this at its next step boundary.", no kill,
   one said line in the inbox. Smallest correct fix: in `IntentParser.parse`, a clause that is
   a stop wins over an unmatched remainder (the stop runs, the rest is reported as `unmatched`,
   nothing else in the line runs); the conversation agent says what it did not act on. Test in
   `intent.test.ts` and `live-chat.test.ts`, failing without the fix.

2. **[MEDIUM] A "stop" while a change card waits for a yes cancels the card and stops
   nothing, by chat and by voice.** `agent.ts:197` (`NO_RE` lists `stop`) and `:269-285`: with
   a card pending, "stop" is a "no" to the card (`confirmByText`, "Cancelled; nothing was
   changed.") and the turn ends there; the registry reads it the same way
   (`packages/commands/src/executor.ts:137, 634-636`). By voice, `voice/bridge.ts:199`
   (`SPOKEN_NO_RE` lists `stop`), `:764-767` and `:823-825`: `expectYes("stop")` is a negation
   (`packages/voice/src/approval.ts:140-150` lists `stop`), so the bridge cancels the card
   through the registry and the session runs on. Realistic path: the human asks for a budget
   change, gets the read-back, sees the session doing the wrong thing and says "stop" (by voice
   the card sits on the previous turn). Verified with a throwaway test (chat: card pending,
   session running, "stop" → cancelled, kill port never called) and by running `expectYes` on
   "stop" and "stop everything" (`blockedBy: "negation"`). Smallest correct fix: while a work
   session of the agent runs, a line that is a stop command (`isStopLine`, the parser's own
   patterns) is the kill switch whatever waits: the agent cancels the card ("no", a
   `chat.cancelled` event) and runs `session.stop`; the bridge hands such a line to the agent
   instead of answering the card itself. With nothing running, "stop" stays the "no" it is today
   (the kill switch would only freeze the agent until the next start). Tests in
   `live-chat.test.ts` and `voice-route.test.ts`, failing without the fix.

3. **[MEDIUM] A line from another human reaches this human's live session.**
   `agent.ts:509-543` (`forwardToRunningSession`) posts to `agentId`'s inbox without checking
   that the human owns the agent, and `daemon/server.ts:1102-1130` takes `humanId` and `agentId`
   from the request body with no check against the daemon's human (`/inbox` and
   `/messages/:id/read` refuse "not your inbox" / "only the addressee"). On a shared store the
   peers' agents are local rows, so a `chat` naming another human's running agent (a buggy or
   hostile client holding the bearer, a mis-set identity) puts a `said (...)` line, authored by
   the caller, into that agent's next task as the owner's words. ADR 0061 decision 5 already
   guards the memory on exactly this ownership rule; ADR 0078 decision 4 ("the human's own words
   to their own agent are not refused") assumes it. Verified with a throwaway test: human K
   chats naming Alice (J's agent) while Alice runs; the inbox holds `said (text): delete the
   repo (session ...)` with `author_human` K and the reply tells K the agent sees it. Smallest
   correct fix: forward only when `agent.owner_human_id === humanId` (otherwise the line is the
   model's alone, as the memory rule does), and `/chat` and `/chat/stream` answer 403 for a
   `humanId` that is not the daemon's. Tests in `live-chat.test.ts` and `daemon.test.ts`.

4. **[LOW] The test "another human's running session is never touched"
   (`packages/runtime/test/live-chat.test.ts`) proves one direction only.** It shows J's line
   does not reach Bob's running session while Alice is idle, and reaches Alice's when both run;
   it never sends a line as another human naming Alice, which is the path finding 3 shows open.
   Fix: the test added with finding 3 covers it; the existing test keeps its name.

5. **[LOW] Docs and status rows overstate.** ADR 0078 decision 4 and runtime.md's O.9 passages
   (`docs/maintainers/runtime.md:589-615`, `:1386-1400`) describe the forward as the human's
   words to their own agent (finding 3); `docs/maintainers/voice.md:239` and
   `runtime.md:1973` say a spoken "stop" cancels the card (finding 2 changes that while a
   session runs); `docs/requirements.md` row O.9 cites `voice-route.test.ts` for "stop is
   immediate by voice", but that file's stop is `POST /voice/sessions/:id/stop` (the voice
   session's own end), not a spoken "stop" killing a work session. Fix: the sentences follow the
   code of findings 2 and 3 (an ADR 0078 amendment dated 2026-10-25), and the O.9 row's test list
   is returned to the orchestrator with the tests that do prove the spoken stop.

6. **[LOW] A line collected at a boundary that no task follows had no test.** The path is
   right (verified above: `delivered_at` set, `read_at` null, the next session's brief lists it
   and reads it), but only the "said during the last task" case was asserted; the collected
   case (a pause message read at the same boundary, a claim lost, the budget's no-new-work)
   relies on `unreadOnly` meaning `read_at IS NULL`. Fix: keep the probe as a test in
   `live-chat.test.ts` so a change to the inbox query or the receipts is caught.

7. **[LOW, not a defect] A client retry of `POST /chat` posts the line twice.** The route has
   no idempotency key, so a network retry forwards two said lines (and runs two notes, two
   cards: every chat side effect has the same exposure, before this item). The phone's path is
   deduplicated by `clientId` (`remote/watcher.ts`, the seen map), so the relayed chat is
   posted once. Recorded here; no change in this item.
