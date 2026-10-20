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
kill switch, pause/resume, the CHF rate, the "costly session" threshold, who shares a project),
the source (`ui | chat | voice | email | api | palette`), the words used, the time zone, the
requesting device and the conversation session that receives the activity event.

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
| `task.create` | project | low | yes (cancel) | `task` row, draft or ready |
| `task.transition` | project | low; `done`/`cancelled` medium | when the graph allows the way back | `task.status` through `TaskRepo.transition` |
| `budget.set` | session / project / global (month) | medium within the ceiling, high above it or raising the ceiling | yes | see below |
| `autonomy.set` | project | one step medium, more high, same level low | yes | `project.autonomy_level` |
| `session.start` | session | medium above the costly threshold (USD 2), else low | yes (stop) | ports or a `remote_command` row |
| `session.stop` | session / global | low | no | ports.kill or a `remote_command` row |
| `session.pause` | session | low | yes (resume) | ports or `session.status` |
| `capability.grant` | global | high | yes | `extension.permissions`, `enabled` |
| `settings.set` | by key | by key (`SETTING_SPECS`) | yes | project settings/columns or human prefs/columns |
| `note.add` | project | low | yes (dismiss) | `queue_item` |
| `request.answer` | project | the request's own risk | no | `human_request.answer` |
| `email.mode.set` | global | high | yes | `extension` kind `capability`, name `email:<agentId>`, `config.settings.mode` |
| `device.revoke` | global | high | no | `device.revoked` |

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
| high | `needs_device` | `confirmFromDevice(id, {deviceId, biometric})` on a device of the same human that is not revoked; a phone needs `biometric: true`, a desktop does not |

An agent actor whose command has `limit: true` (`budget.set`, `autonomy.set`,
`capability.grant`, `email.mode.set`) gets at least `needs_yes` whatever the risk, and only a
human's answer counts; an agent's own yes is refused. `policy.check(decision, answer, ...)`
returns `confirmed`/`declined` or throws `ForerunnerError("approval_required")` with the reason
(a chat or email yes for high risk: "not enough ... confirm in the app on a paired device").

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
pending and otherwise stops the session through the kill switch.

The other direction is the PC daemon running a plan the phone sent as one remote command
(ADR 0032, `packages/runtime/src/daemon/remote-watcher.ts`): the context then carries
`remoteDeviceId` (the phone) and no `deviceId`, so `session.start` calls the port and records
the phone as the session's device with trigger `remote`. The `startSession` port answers
`{ sessionId?, result? }`: the id once the runner recorded the session, the scheduler's verdict
(`started`, `queued`, `deferred`) when the port goes through one.

### Understanding (`src/intent.ts`)

`IntentParser.parse(text, ctx) -> {commands, question?, matched, unmatched}`. The guard runs
first: `ctx.source === "content"` or the runtime's `DATA_ENVELOPE_OPEN`/`CLOSE` markers in the
text throw `ForerunnerError("injection_suspected")`. Notes and "make this a task" are matched on
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
| note: ..., idea: ..., correction: ..., Notiz:, Idee:, Korrektur: | `note.add` |
| make this a task, mach daraus eine Aufgabe | `task.create` from `ctx.lastMessage` |

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
label, scope, risk, zod schema, optional column). `settings.set` refuses unknown keys
(`settingSpec` looks at own keys only, so `constructor` or `__proto__` are unknown settings,
not prototype lookups), so the UI and the parser can only reach what is listed.

**Change the risk table.** `ConfirmationPolicy.decide` and the risk functions of the commands;
`confirmation.test.ts` holds the matrix.

**Wire it in.** The daemon does this in `packages/runtime/src/daemon/compose.ts`:
`registry = defaultRegistry(); await registry.persist(store); executor = new
CommandExecutor({registry, store, clock}); await executor.resumeScheduled(ctxFor)`, exposed as
`RuntimeApp.commands`, `commandPorts` (scheduler start, kill switch, CHF rate) and
`commandContext()` (`activeProjectOf(store, humanId)` for the active project, the human's
`timezone`, the device from the device token, the conversation session id for the activity
log). The remote command watcher runs the phone's plans through it (runtime.md). Still to do:
replace the conversation agent's tools with `toToolSpecs(registry, {execute: executor.execute,
ctxFor})`; the settings screen calls `executor.execute` with `confirmation: {kind: "tap"}`
after showing `renderChangeCard(await executor.plan(...))`; email replies carry the token into
`confirmByToken`. The phone answers high-risk requests through the state service, which
records the device on the request; the watcher turns that into `executor.confirmFromDevice`.

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
settings-screen path, a risen risk refused when the yes arrives), `commands.test.ts` (the
PharmaWatch sentence exactly, every command's risk, writes and undo, prototype keys as unknown
settings), `intent.test.ts` (the two spec sentences, thirty English and German phrases,
ambiguity questions, budget tails that are not a time, invalid values as a question, the
envelope refusal, the model port, time parsing with `rest`), and `scenario.test.ts` (the
Android scenario end to end and the phase 5 gate: ui, chat and voice produce the same change
log entry).

Run: `pnpm vitest run --project unit packages/commands/test` (122 tests).

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
- The temporary session budget (`project.settings.session_budget_override`, "give it 20 francs
  tonight") is honoured by `session.start` through this package (`sessionBudgetOf`), but the
  runtime's own `startSession` in `packages/runtime/src/daemon/compose.ts` still reads
  `session_cap_usd_micro` only, so a session the scheduler starts tonight ignores the override.
  The daemon wiring step must derive the cap from `sessionBudgetOf(project, ctx)` (or read the
  override with its expiry); until then the spec's "same enforcement as the settings screen"
  holds for sessions started through this package, not for scheduler-started ones.
- The rows Q.1 to Q.12, R.4, R.5, R.7 and I.1 in `docs/requirements.md` do not yet cite this
  package's tests (the file was outside this task's paths); the wiring PR updates them.

## Requirements covered

Q.1 to Q.12 (`registry.ts`, `executor.ts`, `change-card.ts`, `confirmation.ts`, `intent.ts`,
tests above); J.5 to J.10 partially (`autonomy.set` enforces the per-project level and its
confirmation; the runtime hooks enforce the levels at tool time); I.1 partially (`budget.set`
is the only way caps change, with the ceiling check); R.4, R.5 and R.7 partially (remote
session commands from a paired phone, the Android scenario, biometric for high-risk
confirmations); data model `command` and `change_log`; phase 5 gate "same change log entry
by voice, chat or UI" (`scenario.test.ts`).
