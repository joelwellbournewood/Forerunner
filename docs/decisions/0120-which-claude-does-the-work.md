# 0120 — Which Claude does the work

Date: 2026-11-16
Status: accepted

## Context

The owner's decision D5 of 2026-11-09 (`/tmp/frbench/owner-decisions-2026-11-09.md`, quoted as
written). 7a: "allow the task to be completed by the API, but in a transparent way. It should
also be possible to give a framework for what to use when ,and then the system just does it. e.g.
use subscription until runs out --> go to API automatically, or use use subscription until runs
out --> go to API after asking human, or go to API by default, etc..." 7b: "design it such that
it works together with my answer for a). It should definitely not automatically do something even
when told to wait or showing that it is waiting." 7c: "If a credential is refused, follow the
frameowrk for a) or b) as if it has run out, but also give the user some kind of notification or
information." Answer 4 (the order when none was chosen): "it should use the order that the user
specifies, I thought we talked about that already. There should be a nice clean options menu."
Answer 3 (the reach of a yes on "Use your API key until ...?"): "For all work."

Before this, two settings (`billing_order`, `mid_session_limit`) reached different calls: task
runs could wait, but chat, planning, the critic's reviews and the background jobs moved to the
next credential at a limit or a refusal (`CALL_FALLBACK_ORDER`, API key first when nothing was
chosen), and the subscription's share and a key's monthly cap were plain skips under any
setting. So a subscription at its limit sent work to the API key (money) while the app said the
work waits.

## Decision

1. **One policy for every call** (`human.notify_prefs.credential_policy`,
   `packages/billing/src/policy.ts`): `subscription_then_wait` (the default), `subscription_then_ask`,
   `subscription_then_key`, `key_then_subscription`, `key_only`. Task runs, the critic's reviews,
   planning, the task check, chat and the background jobs all read it at every pick. There is no
   per-call order any more (`CALL_FALLBACK_ORDER` and the routed provider's `fallbackOrder` are
   gone). Until the person picks, an earlier choice of the older settings is read as the policy
   (derived at every read, so nothing they chose changes; an API-key-first order with 'wait' is
   kept as that order with 'wait' and every kind); with nothing chosen, the default preset for
   every call.
2. **Every stop is held alike.** A usage limit, a refusal, the share of the subscription
   Forerunner may use and an API key's monthly cap are stops (`stopOf`, one key per stop). Under
   `wait` and `ask` the router holds a first choice that is stopped (`waitFor {reason, until,
   stopKey, ask}`); under `next` the next credential serves. A source a call just saw stop is held
   too (`heldNow`), and at a stop the chooser never drops a task to a credential that can do less
   of it (reason `needs`).
3. **Ask first** is one card per stop (`credential:ask`), filed only by the writer that set
   `limits.asking` on the stopped source. "Use API key" writes `limits.grant {to, stopKey}`: the API
   key serves every purpose but the background jobs until that stop ends; the waiting work goes on
   (a running session takes its waiting tasks back; the person's session that ended to wait, or a
   Start they pressed during the stop, goes on now as their start). "Wait" moves nothing; at the
   stop's end the person's waiting session goes on by itself (ADR 0118). A late answer grants
   nothing; the wake ends grants and closes cards whose stop is over, whose preset changed or whose
   other credential cannot serve any more. No card is filed when no other credential serves now or
   the month cap has no room. The words say "waits for your answer ... The card is in the Inbox."
   only while that card is open (`askShown`); otherwise the plain wait.
4. **A refusal informs once and is never retried.** One card per refusal, filed only by the writer
   that set the mark (and TR-10's filing again only by the writer that opens
   `limits.refusedCard`); the card says why by category (never the provider's words) and what the
   work does under the rule. No path asks a refused credential anything until a different one is
   saved, the model list and a model's output limit included. Under "then ask me" a refusal of the
   first choice is a stop like a limit (the owner's 7c, "as if it has run out"): one ask card
   ("Use your API key until a new sign-in is saved?"), whose grant lasts until a new credential is
   saved; the refused card stays the notification with its link and carries no options of its
   own.
5. **Chat holds too.** A held question makes no model call and books nothing; the reply says why,
   with a one-off "Use API key" for that one question when another credential serves now and the
   month cap has room. When another credential answers (a grant, or 'then the API key'), the
   answer's note says so once per stop per conversation.
6. **Changing it**: `settings.set credential_policy` is the person's alone; a change that moves
   less money without them acts at once, one that moves more asks their yes (`moneyRank`).
   `billing_order` and `mid_session_limit` stay for the legacy reader and answer that they were
   replaced once the policy is stored.

## Consequences

- A person who never chose now has chat, planning and reviews on the subscription first, like
  their tasks; at its limit chat holds with a one-off press (the owner question below).
- The run that continues a credential-stopped task is briefed "## Where the last run stopped"
  from its kept work, never "It failed".
- The task check is held like every call: a held check makes no call, writes no Run row, keeps
  its notes for the next boundary and, under 'ask', joins the stop's one card.
- Not built in this round (named in the report, for the session lead's decision against the cut
  line): the share reached mid-run is still the hooks' plan-level budget pause, and the allowance
  raise's change line (CE-6); the background jobs' "not marked done for the period" (CE-10); the
  switch's session log line, its data on the session result and the cost view (CE-11) and the
  switch notification (CE-12); d1109-cred-screens (C6) builds the screens on this.
- Open owner questions (built as their defaults, each in one place): the default preset is
  `subscription_then_wait` (`DEFAULT_CREDENTIAL_POLICY`); no monthly limit of Forerunner's own on
  the API key (a limit stored by an earlier version counts as a stop).

## Alternatives considered

- Keep two settings and widen 'wait' to every call: still two things to explain, and no way to
  ask first.
- Ask on every call: one card per call would flood the Inbox; one card per stop is enough.

## Amendment 2026-11-16: the policy where the person reads it (d1109-cred-screens)

The owner's words this builds on (2026-11-09, point 7): a) "allow the task to be completed by the
API, but in a transparent way. It should also be possible to give a framework for what to use when
,and then the system just does it."; b) "It should definitely not automatically do something even
when told to wait or showing that it is waiting."; c) "If a credential is refused, follow the
frameowrk for a) or b) as if it has run out, but also give the user some kind of notification or
information."

1. **One place**: Settings → "Which Claude does the work" lists the five presets with their lines;
   until the person picks, the default is shown as used ("Used until you choose: ..."). A pick that
   moves more money reads back and needs a tap; one that moves less acts at once. Each saved
   credential has its role under the preset and its state now. Advanced keeps only what each
   credential can do here; the older order and mid-session settings are gone from the screens.
2. **The Start dialog and the plan card** say what happens if the first choice runs out. While it
   is out under 'ask' or 'wait' the dialog offers "Use API key" (a grant for this stop, by the
   person's start; no budget is raised) and "Start at 15:40" (nothing moves before), the preset's
   lean first; when the project's own session waits to go on, its line replaces "Start at" and Use
   API key lets it go on now.
3. **Every wait in words** on the rows and the project's status line: the limit, the share (with
   Change the allowance), a key's monthly cap, and the open question (Answer).
4. **The switch as data** (CE-11): the Run row's `switchedFrom`, `billing.switch` once per stop and
   session ('"Style the page" goes on with your API key from where it stopped: ...', with ', and
   you said yes.' after a grant) and `billing.back`, `SessionResult.switched`, the session page's
   line, the drawer's run line and Costs by credential, all read from the log and the ledger.
5. **Chat's one-off** "Use API key" reaches the screen through POST /chat; a held reply offers no
   Think it through.

Open owner question built as its default (one constant): a one-off "Use API key" is offered under
"then wait" too (`ONE_OFF_UNDER_WAIT = true` in `credential-policy-view.ts`): 'wait' means the app
does nothing by itself, not that the person cannot choose.

Built later in the same round (C6, resumed): the switch notification (CE-12: once per stop when
the policy, not a yes, moved work onto the API key), the run indicator's credential forms (CS-7:
" on your API key", "1 task waits for your answer" with Answer, the share and key-month waits),
the Start dialog's review-may-wait line (C4b-left-5), the line above the two buttons that says
the stop alone ("Your subscription is at its limit until 15:40."), and the runs-on line of a task
under a preset that goes on with the next credential (it names that credential, never the first
one's wait). Not built: the "needs" row form ("Waits for your API key: only it can read web pages
here."), for want of the need in the wait entry.

## Amendment 2026-11-17: the review of the policy's screens (d1109-cred-screens fix-up)

The review of the screens found three places where a screen promised what the app did not do:

1. **"Start at 15:40" under 'ask' is the person's Wait for the stop.** The kept start's own wait
   filed "Use your API key until 15:40?" right after the person chose to wait. The person's Wait is
   now recorded before the wait is noted, and an ask card of the same stop that was already open
   (another project's work met the stop first) is answered Wait: one stop asks one question (point
   2 of the 2026-11-16 amendment: "under ask it also records the person's Wait for this stop, so no
   card follows"), also after a restart.
2. **A yes for the stop names the key on the plan card.** With the person's yes standing, each
   task's line said "Waits until 15:40" while the key ran the work at once. The runs-on line now
   follows the yes as the pick does, as it follows "then API key".
3. **"Use API key" only for a start that runs something.** With nothing ready or under Stop all
   the dialog offered it ("about CHF 0.00") and its yes was written before the start was refused,
   so every project's work and chat moved onto the key for a start that never ran (the owner's 7b:
   "It should definitely not automatically do something even when told to wait"). The offer now
   needs a start that runs, and the yes is written only after every refusal.

Settings' "Stop using it" also says what it does ("Stop using it: what already runs on your API
key finishes; new work waits for your subscription.").

## Amendment 2026-11-22: every stop read once, and what a failed or refused call says (l4-cred-engine, run L4)

Live check 4 (4cf11fd) found stops the policy did not see and words that promised what the app
did not do. The owner's D5 ("Running out includes a usage limit, a plan-share cap and a monthly
cap ... a refused credential follows the same policy as running out and also tells the person")
and 7b ("It should definitely not automatically do something even when told to wait") decide
each point.

1. **How a refusal is read (L4-creds-2).** Agent SDK 0.3.304 ends Claude Code's error result
   with a throw and starts the stream with Claude Code's own synthetic error message (model
   `<synthetic>`, zero usage). The driver and the provider read the stream's verdict (or the
   thrown text) once: a refused sign-in is the refusal (one card, the work waits, Settings reads
   Refused), a usage limit rests, a budget end is a budget stop. The synthetic message is no
   model call and is never booked or listed in Costs.
2. **The share reached mid-run is a stop (L4-creds-1).** A run's budget stop at the plan's share
   on the subscription is the credential stop `share`, under the person's policy as a usage limit
   is: next goes on with the key, ask files one card, wait ends the session to go on at the
   month's start. Raising the allowance in Settings ends the stop and says what goes on.
3. **A card's notification says what the card says, once, in the person's zone (L4-creds-3).**
   The person's time zone and monthly cap are read at each use, never the ones composed at start.
4. **A failed chat answer is no answer (L4-creds-4).** The switch note is said only under a
   completed answer (once per stop), Think it through is offered only under one, and every other
   failure is one sentence by its error code, never the error's own message.
5. **A cut-off call is booked on the credential that served it (L4-creds-5).**
6. **Chat follows the Start dialog under a refusal (L4-creds-8).** The hold reply says what to do
   and never promises a start; chat's start under a refused credential gets the dialog's sentence
   and no read-back. Chat's start kept for a reset is not built yet.
7. **A stored ask form reads as it is now (L4-creds-7)**, the configured API address covers the
   subscription's task runs (L4-creds-10), the ask card's yes is applied once across a restart
   (L4-creds-11), a continuation queued behind another project's session is named as next
   (L4-creds-9), and chat's room for a longer answer reads the plan's share (L4-creds-6).

## Amendment 2026-11-22: the money consent and the screens agree with what runs (l4-cred-screens, run L4)

Live check 4 asked "Use your API key until 08:26?" at about CHF 0.10 for work that then cost CHF
0.24 on the key, while the Start dialog said CHF 0.15 and the plan card CHF 0.37 for the same
work. The owner's D5 ("allow the task to be completed by the API, but in a transparent way"), his
answer 3 ("For all work.": the yes covers all work until the stop ends) and his answer of
2026-11-16 ("yes it should count critics reviews, and fixes") decide each point.

1. **One figure for the waiting work (L4-creds-15).** `waitingWorkUsdMicro` (start-check.ts) is
   the session's promise (`promiseOf`: the runnable tasks, the larger task's room and the later
   followers, each priced with its review part) plus what is left of a task a session holds
   (`inFlightWork`: its planned figure less all it spent), never more than the session's work
   budget. The ask card, the Start dialog's "Use API key" line and the plan card's foot line say
   it, the plan card over its own tasks. The dialog keeps its plan sentence beside the stop line,
   so the figure is for tasks the person can see.
2. **The yes lets in what waited (L4-creds-15, C5L-6).** On "Use API key", a running session
   takes back only the tasks that waited for a credential inside it (`waitedForCredential`, the
   ready tasks the runner gave back with `CREDENTIAL_WAIT_REASON`). Other ready work joins only if
   it fits (the owner's option C); before, every ready task was taken back, also one the session
   had left out for its budget. Work the agent adds later stays bounded by the session's budget.
