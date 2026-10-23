# Commands

Package: `packages/commands` (`@forerunner/commands`). Spec module Q (natural-language
control) entirely, module J autonomy levels as a command (J.6 to J.10, partially), module I caps
as `budget.set` ("raise a budget within the hard ceiling" is medium, "raise the monthly hard
ceiling" is high), module R remote control and biometric confirmation (R.4, R.5, R.7,
partially), the supporting tables `command` and `change_log` of the data model, and the phase 5
gate "every settings change can be made by voice, chat or the UI, and each produces the same
change log entry". ADR 0030 records the decisions the spec left open.

## Purpose

Anything you can do in the app you can also say, and both routes run the same typed command.
This package is that one command registry: fifteen commands with zod parameters, a risk level,
a scope and an undo; the change card shown (and spoken) before any change; the confirmation
policy by risk (low acts, medium needs a yes, high needs a paired device, biometric on a phone);
the executor that writes every change to `change_log`, posts the plain sentence to the activity
log and the project chat, reverts temporary changes on the clock and offers a one-click undo;
and the intent parser that turns English and German phrases into commands, asks one short
question when something is unclear, and refuses text that is data. Limits are enforced in code:
a conversation change goes through the same `budget.set` as the settings screen, an agent cannot
raise its own limits without a human, and text from pages, files or email is never a request.

## How it works

### The registry (`src/registry.ts`, `src/types.ts`)

`CommandDef<P>` is the unit:

```
{ name: "budget.set", description, params: z.ZodType<P>,
  risk: Risk | (params, ctx) => Risk,     maxRisk?: Risk (for a dynamic risk),
  scope: "session" | "project" | "global" | (params) => scope,
  reversible: boolean, undoStrategy: string, actionClass?: ActionClass, limit?: boolean,
  plan?(params, ctx) -> ChangeCard,  run(params, ctx) -> CommandOutcome,
  undo?(params, before, after, ctx) }
```

`CommandContext` carries the actor (`{kind: "human" | "agent", id}`), the human the change is
for, the principal agent, the active project, the store, the Clock, the ports (session start,
kill switch, pause/resume, the CHF rate, the "costly session" threshold, who shares a project,
lesson memory),
the source (`ui | chat | voice | email | api | palette`), the words used, the time zone, the
requesting device and the conversation session that receives the activity event. Who the
actor is depends on the caller: the runtime's routes, the palette, the phone and email
commands act as the human; the model path (`CommandLoop.tools()` in `packages/runtime`)
passes the principal agent as actor with the human as `humanId`, so a command the model
decides to call is recorded with `author_agent` and no `author_human` and the `limit` rule
below applies to it (`packages/runtime/test/security-command-actor.test.ts`).

`CommandRegistry.register/get/mustGet/list/names/validate/schemaJson/persist`. `persist(store)`
upserts every definition into the `command` table by name (`CommandRepo.register`), so a
restart is idempotent; the row carries the JSON schema (`z.toJSONSchema`), the static or
maximum risk and the undo strategy. `toToolSpecs(registry, binding)` makes one runtime
`ToolSpec` per command for the conversation agent: the tool name is the command name with
dots replaced by underscores (`budget_set`), the schema is the command's, the action class is
`actionClass` or derived from the risk (low `routine_reversible`, medium `non_routine`, high
`permission_change`), and `execute` calls `binding.execute` (the executor) with a context from
`binding.ctxFor(toolCtx, command)`. A pending confirmation comes back to the model as text to
read out. The conversation agent's own tools are replaced by these in the daemon wiring step.

| Command | Scope | Risk | Reversible | Writes |
| --- | --- | --- | --- | --- |
| `project.switch` | global | low | yes | `human.notify_prefs.active_project`, `project_history` (last 10; "go back") |
| `project.create` | global | low | yes (archive) | `project` row, active project |
| `task.create` | project | low | yes (cancel) | `task` row, draft or ready; `risk_tier` left out takes the project's default through the runtime's `defaultRiskTier` (0 in small-project mode, else 1; spec B.6, ADR 0051) |
| `task.transition` | project | low; `done`/`cancelled` medium | when the graph allows the way back | `task.status` through `TaskRepo.transition` |
| `budget.set` | session / project / global (month) | medium within the ceiling, high above it or raising the ceiling | yes | see below |
| `autonomy.set` | project | one step medium, more high, same level low | yes | `project.autonomy_level` |
| `session.start` | session | medium above the costly threshold (USD 2), else low | yes (stop that start's session; `after.start_id` names the start) | ports or a `remote_command` row |
| `session.stop` | session / global | low | no | ports.kill or a `remote_command` row |
| `session.pause` | session | low | yes (resume) | ports or `session.status` |
| `capability.grant` | global | high | yes | `extension.permissions`, `enabled` |
| `settings.set` | by key | by key (`SETTING_SPECS`) | yes | project settings/columns or human prefs/columns; a key with an `effect` (`small_project_mode`, spec B.6; `fast_mode`, spec D.20; the monthly jobs' `calibration`, global in `human.notify_prefs`, and `handover`, per project, ADR 0060) says what changes in the card's new value and the sentence, both ways; `voice_alerts` (global, low, boolean) is the voice notification channel's switch in `human.notify_prefs` (ADR 0063) |
| `note.add` | project | low | yes (dismiss) | `queue_item` |
| `summary.speak` | project | low | no (stop the playback in the app) | nothing; `ports.speak` reads the one-screen summary aloud (spec A.6, L.6; ADR 0063). By chat or from the UI the sentence is "Reading the summary of X aloud. <text>"; in a voice session the sentence is the text itself (the loop speaks it, no second voice); without a port, a usable provider or an app window that plays speech (the daemon's port answers "no app window open to play speech", so nothing claims "aloud" into silence) "Voice is unavailable (reason). Summary of X: <text>". `after` says whether it was spoken and by which path. Another human's project (the named one or the active one) is refused as `not_found` "the project "X" is not yours" before anything is read, by `ownsProject` (`src/ownership.ts`: members, `shared_with`, author, or no owner facts at all), the one rule the daemon's speak route uses too. `spokenProjectSummary(project, spendUsdMicro, chfPerUsd)` is the one builder of the text, used by the daemon's `GET /projects/:id/summary` too |
| `request.answer` | project | the request's own risk | no | `human_request.answer` |
| `email.mode.set` | global | high | yes | `extension` kind `capability`, name `email:<agentId>`, `config.settings.mode` |
| `device.revoke` | global | high | no | `device.revoked` |
| `memory.record` | project | low | yes (retire the lesson; a merged one restores the lesson it superseded) | `ports.memory.recordLesson`: a lesson in the private memory of the human's own principal, for the named or active project (none: every project), source `human:<id>;<chat|voice|...>:<conversation session>` |

`memory.record` (spec O.2, ADR 0061) is how a lesson the human states in chat or voice reaches
the principal's memory: "remember that ...", "lesson: ..." by pattern, or the model's
`memory_record` tool for the same thing in other words. It is low risk (no limit, no spend,
nothing outside the human's own memory), so it acts at once and the sentence reads the stored
text back: `Recorded a lesson in Alice's memory for PharmaWatch: "...". Undo.` (up to 300
characters). The command refuses a context without a principal agent or an agent the human
does not own; the port (`MemoryCommandPort`: `recordLesson`, `forgetLesson`) is the runtime's
`memoryCommandPort(MemoryLoop)`, which also runs the lesson injection screen and the memory
lint (a text under 20 characters is refused with the lint's reason). Without the port the
command is refused with `unavailable`. A lesson an agent records (the conversation model's
`memory_record` tool, whose context carries repository docs) must be grounded in the human's
words of that turn: at least `LESSON_GROUNDING_MIN` (half) of its content words appear in
`ctx.wordsUsed`, else it is refused as `injection_suspected`, so a doc section cannot write
itself into the principal's memory through the model; a human actor's command is the human's
words and is not checked.

`budget.set` stores money in USD micro-units with the CHF figure beside it (ADR 0008; the rate
comes from `ports.chfPerUsd`): a temporary session budget is `project.settings.
session_budget_override = {cap_usd_micro, cap_chf_micro, rate_chf_per_usd, expires_at}`; a
permanent session cap is `settings.session_cap_usd_micro` and `session_cap_chf_micro`; the
project budget is `project.budget_usd_micro` plus `settings.budget_chf_micro`; the monthly
ceiling is `human.monthly_cap_usd_micro` plus `notify_prefs.monthly_cap_chf_micro`. Unset
values fall back to the billing defaults (CHF 5 per session, CHF 150 per month).
`sessionBudgetOf(project, ctx)` and `monthlyCeilingOf(human, ctx)` are exported for the runtime.

### The change card (`src/change-card.ts`)

`ChangeCard { command, what, oldValue, newValue, scope, scopeLabel ("this session" | "this
project" | "everything"), duration ("until reverted" | "until <time>" | "permanent"), impact
{costUsdMicro?, costChfMicro?, risk}, undoHint, sentence, projectId, projectName,
usesActiveProject, expiresAt, reversible, parts? }`. `buildCard` fills the derived fields,
`mergeCards` makes one card for a plan of several commands (highest risk, widest scope, earliest
window, sentences joined), `renderChangeCard(card, {voice})` is the plain text shown before the
change and spoken in voice mode, `formatChfShort` renders CHF with the billing formatter and no
trailing `.00`. The card's `sentence` is the past-tense sentence posted afterwards, e.g.
"Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo.";
the test `commands.test.ts` asserts it exactly. When no project was named the card says
"(PharmaWatch, the active project)".

### Confirmation by risk (`src/confirmation.ts`)

`ConfirmationPolicy.decide(risk, actor, source, {limitChange})`:

| Risk | Decision | Who can answer |
| --- | --- | --- |
| low | `act` | nobody asked; the sentence states what happened, with Undo |
| medium | `needs_yes` | a human's typed or spoken yes (`isYes` from the runtime, so "ja"/"oui" work), a tap in the app, or an email reply carrying the pending entry's `FR-` token |
| high | `needs_device` | `confirmFromDevice(id, {deviceId, biometric})` on a device of the same human that is not revoked; only a `desktop` confirms without a second factor (it is the PC the human sits at; the daemon's watcher names its own desktop row after the state service checked the phone), a `phone` needs `biometric: true`, and a `web` or `runner` device is refused whatever flag it presents, since neither has a second factor to bring (ADR 0034: the web page always signs biometric=0 and its high-risk answers go through the state service's re-entered code); a device kind the policy does not know is refused the same way |

An agent actor whose command has `limit: true` (`budget.set`, `autonomy.set`,
`capability.grant`, `email.mode.set`) gets at least `needs_yes` whatever the risk, and only a
human's answer counts; an agent's own yes is refused. `policy.check(decision, answer, ...)`
returns `confirmed`/`declined` or throws `ForerunnerError("approval_required")` with the reason
(a chat or email yes for high risk: "not enough ... confirm in the app on a paired device").

The desktop's own row is the daemon's (`registerDesktopDevice` in `packages/runtime`, on
every store since the 2026-10-23 triage, whenever the daemon runs its services; `GET /me`
names it as `desktopDeviceId` and the settings screen sends that id), so the rule holds with
a real row on a solo install too: an id that is no device row (the shell's install id) is
refused as "unknown device; pair it first" and the card stays open. The policy itself is
unchanged: the daemon route only fills in its own row for an id-less or `desktop` answer, with
an audit row (`runtime.md`, "This PC as the paired device").

Every answer is tied to the human the change is for (`ctx.humanId`, the pending entry's
human): a yes, a tap or an email token from another human (a shared store, a shared project)
is refused, and a device answer that names another human is refused even on the owner's own
device. The settings-screen path (`execute` with a `confirmation`) never accepts an `email`
answer: a token exists only once a pending change was sent, so there is nothing an email
could match before the card.

### The executor (`src/executor.ts`)

`execute({name, params, ctx, confirmation?})` -> validate -> `plan` the card and resolve the
risk -> policy -> either run, or open a pending confirmation, or check the answer the caller
already has (the settings screen showed the card and got a tap). A pending confirmation is a
`human_request` row (kind `approval`, the risk, `change_card` with the card, the decision,
the email token and the expiry) plus an in-memory entry with the closure to run; it expires
after ten minutes on the Clock (the request becomes `expired`). `confirm(id, answer)`,
`confirmByText(id, text, by)`, `confirmByToken(token, by)`, `confirmFromDevice(id, device)`,
`cancel(id, by)`, `pending(humanId)`, `getPending(id)`.

One answer runs a change once: while an answer is being checked (the device lookup is the
only await) a second answer to the same id is refused (`version_conflict`), and the entry
leaves the map in the same tick the check passes, so a double tap on the phone starts one
session and writes one row. Before the run the request is planned again on the current state
and the policy decided again (`redecide`): when the decision is stricter than the one on the
card (the monthly ceiling dropped meanwhile, so a session budget that was medium is now high)
the answer is refused with `approval_required`, the request is answered with the reason and
the human asks again for a fresh card at the new risk. A decision that got milder runs.

A run writes one `change_log` row: who (`human_id`, `agent_id`, author columns), the words
used, the commands with their parameters, before and after, scope, project, `expires_at`,
`undo_state` (`undoable` or `irreversible`), source and the sentence. Then the sentence is
posted: an event of type `change` on `ctx.sessionId` (the conversation session), a message from
the principal agent to the human (the project chat), and for a shared project a message to every
other human (`ports.sharedWith(projectId, humanId)`, default `project.settings.shared_with`)
prefixed with the asking human's name. A failed post never undoes the change.
`request.answer` also calls `ports.requestAnswered(requestId)` once the answer is recorded: the
daemon applies it at once (its `syncApprovals`), as its answer route does, so an approved plan
said in chat or voice starts its follow-up without waiting for a poll (ADR 0053 amendment).

`compose(calls, ctx)` is the bespoke request: every call is validated and planned (a
`project.switch` earlier in the plan makes later steps apply to the new project), the cards
merge into one, the policy runs once on the merged risk, and the steps run in order. When a
step throws, the applied steps are undone in reverse; if that works the result is `refused` and
nothing is logged, otherwise the kept steps are logged with a note and the status is
`partial`. One `change_log` row holds all commands with `before`/`after` as arrays.

`undo(changeLogId, ctx)` runs while the row is `undoable` and its window has not closed: the
closure kept from the run, or after a restart the command's `undo(params, before, after)` from
the row; the row becomes `undone`, an `undo` row is logged ("Undone: the active project is
back to PharmaWatch.") and posted. Only the human the change was made for (`row.human_id`)
may undo it; an agent's undo and another human's undo or manual `revert` are refused with
`approval_required`. `undoable(humanId, projectId?)` lists the candidates. Temporary changes (`expires_at`) get a Clock timer; at the time the executor
reverts them (same undo), marks the row `expired`, logs a revert row (`undo_state`
`irreversible`, commands carry `revert_of`) with "Reverted tonight's session budget for
PharmaWatch to CHF 5; the window until 06:00 ended." and posts it. `resumeScheduled(ctxFor)`
after a start reverts the windows that closed meanwhile and re-arms the open ones;
`stop()` cancels timers at shutdown.

`ExecuteResult` is `done | partial | pending | cancelled | refused` with the card, the change
log id and `undoToken` (the change log id while undoable), or the pending id, decision, expiry,
email token and readback, or the reason and error code.

### Remote control from a phone (spec R)

When `ctx.deviceId` is a paired phone or web client, `session.start` and `session.stop` do not
call the ports: they enqueue a `remote_command` row (`target` pc or cloud, the agent, project,
budget and reason) that the PC or the cloud runner picks up through the state service. The
sentence says so ("the PC picks it up in seconds"); undo fails the row while it is still
pending and otherwise stops the session through the kill switch, naming the start the
runner recorded in the row's result (`result.startId`, written by the runtime's
`RemoteCommandWatcher` when it ran the start) so the runtime's port stops that start's
session and no later one; the row's `after.start_id` is `null`, the id not being known
here. A result without a `startId` (a runner that records none) names no start, and the
port stops nothing for it (ADR 0049; the runtime's `CommandLoop.undo` refuses such an undo
with its reason before it reaches this undo).

On the desktop `session.start` calls `ports.startSession`, which answers the session id when
it knows it and otherwise the start's identity (`startId`: in the runtime the scheduler
entry's id, one id from the queue to the run). The row's `after` keeps both (`session_id`,
`start_id`) and the undo passes them back: `kill({ sessionId })` when the session is known,
else `kill({ agentId, startId })` with the reason `undo of session.start`, so the runtime's
port (`sessionCommandPorts`, runtime.md) stops the session that start began and never the
agent's scope or a later start of the agent (`KillScope.startId`, ADR 0049). A row without
`start_id` (written before starts had one) matches nothing running there.

### Understanding (`src/intent.ts`)

`IntentParser.parse(text, ctx) -> {commands, question?, matched, unmatched}`. The guard runs
first: `ctx.source === "content"` or the runtime's `DATA_ENVELOPE_OPEN`/`CLOSE` markers in the
text throw `ForerunnerError("injection_suspected")`. Lessons, notes and "make this a task" are matched on
the whole text (they may contain "and"); everything else is split on `, ; and und then dann`
and each clause goes through the patterns, in English and German:

| Phrase | Command |
| --- | --- |
| switch to X, go to X, work on X now, wechsle zu X, arbeite jetzt an X | `project.switch` |
| go back, zurück | `project.switch {back}` |
| give it 20 francs tonight / until tomorrow / until 06:00, gib ihm 20 Franken heute Nacht / bis morgen / bis 6 Uhr, give the game 10 francs | `budget.set` session (temporary when a time is given) |
| set the session/project budget for X to 50 francs | `budget.set` session/project |
| raise the monthly cap to 200, erhöhe das Monatslimit auf 200 | `budget.set` month |
| set autonomy to 3, set the autonomy of X to 4, Autonomie auf 3 | `autonomy.set` |
| start a session [on X] [on my PC / in the cloud] [with 10 francs], starte eine Session auf meinem PC | `session.start` |
| stop everything / stop all, stopp alles; stop; pause | `session.stop {all}`; `session.stop {agent}`; `session.pause` |
| remember that ..., lesson: ..., lesson learned: ..., merk dir, dass ..., Lektion: ..., Lehre: ... | `memory.record` |
| note: ..., idea: ..., correction: ..., Notiz:, Idee:, Korrektur:, remember ..., merk dir ... | `note.add` |
| read me the summary [of X] [aloud], speak the project summary for X, summary, lies mir die Zusammenfassung [von X] vor | `summary.speak` (the active project unless one is named; "Which project?" when neither) |
| make this a task, mach daraus eine Aufgabe | `task.create` from `ctx.lastMessage` |

A lesson ("remember that", "lesson:") is matched before a note, so "remember that X" records X
in memory while "remember to X" and "note that X" stay next-session notes (ADR 0061). The nouns
(`lesson`, `lesson learned`, `Lektion`, `Lehre`) need a `:` or `-` after them, and a stated
lesson that ends in `?` is a question, not a lesson: "lessons from the last sprint?", "Lesson
plans are due Friday" and "Lehre mich, wie ..." never write memory (`intent.test.ts`).
"it" is the project switched to earlier in the same sentence, else the active project.
Project names resolve against `ctx.projects` (exact, containing, word overlap); several matches
or none give one question with the candidate names as options. Times are read in
`ctx.timezone` (`src/time.ts`, no date library): "tonight" and "until tomorrow" are 06:00 the
next morning (06:00 today while it is still night), "until HH:MM" is the next time that wall
clock comes round, "today" is midnight. `parseWhen` also returns `rest`, the words around the
time expression: a budget clause whose tail is not a time it can read ("for two hours", "next
week", "tonight at the latest") becomes one question ("Until when?" with Tonight / Until
tomorrow / Until reverted) and sets nothing, never a silent permanent cap; a project budget
given a window asks which budget was meant. Values a pattern produced that the registry refuses
("give it 0 francs") become the same question the model path asks
(`budget.set: amountChf: ...`). A plain question ("what was I doing on the game?")
yields no commands and no counter-question, for the conversation agent to answer. Any clause no
pattern understands goes to the `ModelIntentPort` when one is configured (a fast model with one
tool whose schema is `intentToolSchema(registry)`); its commands are validated against the
registry and an unknown command becomes the offer to create a Forerunner task. Without a model
port the result is one question with options and nothing runs.

## How to change it

**Add a command.** Write `src/commands/<area>.ts` exporting a `CommandDef`: a zod `params`
schema, a `risk` (a function when it depends on state; then set `maxRisk`), `scope`,
`reversible`, `undoStrategy`, `plan()` building a card with `buildCard` (old and new values as
the human sees them, the past-tense sentence ending in " Undo." when reversible), `run()`
returning `before`/`after` JSON that `undo()` can act on, and `undo()` so the change can be
undone after a restart. Set `limit: true` when it changes a limit. Register it in
`defaultRegistry()` (`src/commands/index.ts`), add it to the table above and to `COMMAND_NAMES`
in `src/types.ts`, and add tests: the card sentence, the risk, the write and the undo. A phrase
for it goes into `IntentParser.matchClause`.

**Add a setting.** Add a `SettingSpec` to `SETTING_SPECS` in `src/commands/settings.ts` (key,
label, scope, risk, zod schema, optional column, and an optional `effect(value)` when the key's
name alone does not say what changes: it is appended to the card's new value and to the
sentence as "Set X from a to b: <effect>. Undo.", as `small_project_mode` does with
`SMALL_PROJECT_MODE_EFFECT`; `test/small-project.test.ts`). `fast_mode` (spec D.20, ADR 0057:
Opus fast mode per project; project scope, boolean, medium risk because it raises what every
Opus call of the project costs) takes its effect from the runtime's `fastModeEffect` (imported
from `@forerunner/runtime/models/fast-mode`, not the package index, which imports this package
back): on, the fast-mode rate against the standard one and "a subscription ignores it (API
only)"; off, back to the standard rate and the surcharge stopping (`test/fast-mode.test.ts`).
`SettingSpec.effect(value, ctx)` receives `{ pricing }` from the optional
`CommandPorts.pricingTable()`. The daemon passes the table in force: the built-ins plus
`<config>/pricing.json` and adopted rows. So the card the human confirms, and the change-log
sentence, quote the surcharge that runs are charged. The daemon's Settings row uses the same
table. Without the port, the effect uses the built-in table.
The runtime reads the flag per run (`runtime.md`, "Opus fast mode per project"). `settings.set` refuses unknown keys
(`settingSpec` looks at own keys only, so `constructor` or `__proto__` are unknown settings,
not prototype lookups), so the UI and the parser can only reach what is listed.

**Change the risk table.** `ConfirmationPolicy.decide` and the risk functions of the commands;
`confirmation.test.ts` holds the matrix.

**Wire it in.** At daemon start: `registry = defaultRegistry(); await registry.persist(store);
executor = new CommandExecutor({registry, store, clock}); await executor.resumeScheduled(ctxFor)`.
Build a `CommandContext` per request (`activeProjectOf(store, humanId)` for the active project,
the human's `timezone`, the device from the device token, the conversation session id for the
activity log). Replace the conversation agent's tools with `toToolSpecs(registry, {execute:
executor.execute, ctxFor})`; the settings screen calls `executor.execute` with
`confirmation: {kind: "tap"}` after showing `renderChangeCard(await executor.plan(...))`; the
phone answers high-risk requests with `executor.confirmFromDevice`; email replies carry the
token into `confirmByToken`.

## Tests

`packages/commands/test` (Vitest, unit project, `sqlite::memory:` store, `SimulatedClock`,
no network): `registry.test.ts` (registration, validation, idempotent persistence, tool specs
and action classes), `change-card.test.ts` (CHF formatting, durations, merge, rendering),
`confirmation.test.ts` (the risk matrix, every refusal, answers from another human),
`executor.test.ts` (low acts and logs, medium needs yes/tap/email, ten-minute expiry, high
needs a device with biometric on a phone, agent self-limit, undo and undo after a restart, the
06:00 revert with the clock, undo cancels the revert, resume after a restart, compose as one
entry and its rollback, shared projects, the settings-screen path, another human's yes/tap/
token/device and undo/revert refused, a double tap runs once, no email answer on the
settings-screen path, a risen risk refused when the yes arrives), `security-commands.test.ts`
(the security review: the always-human commands carry the spec's risk, a pending card is not
confirmed by the wrong kind of answer, a guessed email token or another actor, a web or runner
device does not confirm a high-risk change without a second factor), `commands.test.ts` (the
PharmaWatch sentence exactly, every command's risk, writes and undo, prototype keys as unknown
settings; `memory.record` acting at once at low risk with the read-back sentence, the source
naming the human and the conversation session, another project or no project, undo through the
port, refused without an agent or without the port, an agent actor's lesson refused unless
grounded in the human's words; `summary.speak` through the port, in a voice session and without
voice, another human's project refused by id, by name and as the active project and allowed once
shared, the `voice_alerts` setting), `intent.test.ts` (the two spec sentences,
forty-four English and German phrases including the lesson phrases, "remember to" staying a note and the summary phrases, seven questions and ordinary sentences that are not lessons,
ambiguity questions, budget tails that are not a time, invalid values as a question, the
envelope refusal, the model port, time parsing with `rest`), and `scenario.test.ts` (the
Android scenario end to end and the phase 5 gate: ui, chat and voice produce the same change
log entry), and `fast-mode.test.ts` (spec D.20: the `fast_mode` spec, its card and the change
log sentences with the effect and the surcharge both ways, the yes a medium-risk change needs,
the flag written on one project only; a corrected fast row from `ports.pricingTable` quoted in
the card and the sentence).

Run: `pnpm exec vitest run --project unit packages/commands/test` (10 files, 162 tests).

## Known issues

- The closure of a pending confirmation lives in memory: a restart drops open confirmations
  (their `human_request` rows stay open until they expire, and the human asks again). Reverts
  and undo survive a restart through the change log.
- "and" inside a project name splits the sentence; name the project without it or use the
  model port.
- Which human shares a project is read from `project.settings.shared_with` until the state
  service exposes project membership; `ports.sharedWith` overrides it.
- Session commands from a phone reach the PC through `remote_command`; the runner's pick-up
  loop is wired in the state service and daemon, not here.
- A posted sentence needs a principal agent (`ctx.agentId`) because messages have a sender;
  without one only the change log and the activity event are written.
- The rows Q.1 to Q.12, R.4, R.5, R.7 and I.1 in `docs/requirements.md` do not yet cite this
  package's tests (the file was outside this task's paths); the wiring PR updates them.

## Requirements covered

Q.1 to Q.12 (`registry.ts`, `executor.ts`, `change-card.ts`, `confirmation.ts`, `intent.ts`,
tests above); J.5 to J.10 partially (`autonomy.set` enforces the per-project level and its
confirmation; the runtime hooks enforce the levels at tool time); I.1 partially (`budget.set`
is the only way caps change, with the ceiling check); R.4, R.5 and R.7 partially (remote
session commands from a paired phone, the Android scenario, biometric for high-risk
confirmations); data model `command` and `change_log`; phase 5 gate "same change log entry
by voice, chat or UI" (`scenario.test.ts`); O.2 and J.1 with the runtime (`memory.record`, a
lesson stated in chat recorded in the principal's memory, `packages/runtime/test/conversation.test.ts`).
