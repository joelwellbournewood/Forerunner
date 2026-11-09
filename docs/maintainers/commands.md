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
This package is that one command registry: nineteen commands with zod parameters, a risk level,
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
lesson memory, the specialist approval gate, the docs hook `projectCreated` that
`project.create` awaits after its insert so the daemon scaffolds the standard doc set, spec
G.5; a hook that throws is logged and never fails the creation),
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
read out: "Needs confirmation. The person is asked: <the card's one-line read-back>", with no
pending id (phase E: the model repeated ids to the person, live walk 2 #10). The conversation
agent's own tools are replaced by these in the daemon wiring step.

| Command | Scope | Risk | Reversible | Writes |
| --- | --- | --- | --- | --- |
| `project.switch` | global | low | yes | `human.notify_prefs.active_project`, `project_history` (last 10; "go back": the latest project left that is still there, never a removed one; the project left is moved to the end of the history, `historyAfterSwitch`, so "go back" returns to it also when it was in the history before; its Undo is refused when the project it would make active again was removed, `undoBlocked`: "the project X was removed", W15-36) |
| `project.create` | global | low | yes (archive) | `project` row, active project; `ports.projectCreated` (the daemon's G.5 scaffold of the standard doc set, in the background; runtime.md "Project docs"); W15-36: with `ports.createProject` (given for one call by `POST /projects` with `switch: true`, the New project dialog) the row is the route's own creation (brief, plan from the brief or doc set) and `projectCreated` is not called; a name another project has is refused as the dashboard says it, 'There is already a project called "X". Pick another name.'; with `switch` the project left goes on `project_history` as with `project.switch`, so "go back" returns to it (before and after carry the history). Its Undo (W15-36): archives the project and frees its name, renaming it "X (removed)" ("X (removed 2)", … when taken; the name it had in `settings.removed_name`, `removedProjectName`), withdraws its open cards, takes it out of the history and, when it is the active project, makes the previous one active again (another project made active since stays active); the removed project's other rows are not undoable (`undoBlockedReason`: "the project X was removed"). W15B-02: the Undo is refused while a session of the project runs (running, paused or planned; the intake's planning call and the chat's own row do not count), `undoBlocked`: "a session of X is running. Stop it first" (Changes: "Cannot be undone now: a session of X is running. Stop it first."); for a session told "Stop after this task" (status paused) "a session of X is stopping after its task. Stop it now, or wait for it to end", for one about to start "a session of X is starting. Stop it first" (the review of fix/w15-tail: each state in true words). `removedProjectRefusal(project)` (exported) is the one sentence anything that would start work on a removed project is refused with: 'The project "X" was removed, so nothing of it runs.' (X the name it had); the runtime's starts, the intake and the chat's `session.start` (through `ports.startBlocked`) use it |
| `task.create` | project | low | yes (cancel) | `task` row, **ready** unless `status: draft` is asked for (design §3.9: a draft is planned by no session, so a task made by chat or the app waited silently); `risk_tier` left out takes the project's default through the runtime's `defaultRiskTier` (0 in small-project mode, else 1; spec B.6, ADR 0051), then `riskTierFor(specialist, tier)`: a deploy or a migration (`SIGNOFF_SPECIALISTS`, ADR 0104 decision 4) is stored at the full review at least, a light review asked for included (phase C leftover C-2: before, such a task was stored at the light review, its row read "Light review" and its run used the process sandbox); `priority` is `low`, `medium` (default) or `high` (`TaskPrioritySchema` from `@forerunner/runtime/priority`; an old number is read as its level), stored as the level's number; `depends_on` (ids or titles, checked by `TaskRepo.checkDependencies`), `budget_usd_micro`, `specialist` (a specialist, or `person` for a task only the person can answer) and `milestone_id`. The daemon's `POST /projects/:id/tasks` runs it, so New task is in Changes with its Undo. Sentence: "Added "X" to Atlas, high priority." (U-041) |
| `task.transition` | project | low; `done`/`cancelled` medium | yes (the status before) | `task.status` through `TaskRepo.transition`; the API route and agents use it, the Tasks tab sends the actions below; a move the status no longer allows (the task finished between the read-back and the yes) is refused in words, `assertMove`: '"X" is already done; nothing changed.', never "task: illegal transition done -> cancelled"; the chat's read-back of a cancel says what Yes does to a task whose run is going: 'Cancel "X"? Drops it. Its run stops and its changes are removed; Undo restores them unless the files changed.' (a task with a pull request: 'Its run stops now; its pull request stays open.'; a paused task: its work so far is set aside; a project linked to the person's own folder: what it wrote stays; a task left in review with no review running is only dropped; phase C leftover C-38, L-7, W6-7, C-37, `moveAsk` below) |
| `task.pause` | project | low | yes (ready again) | ready → `needs_human` recorded as the person's own (`author_human`), the reason "Paused by you"; on a running task it is Stop: the run is stopped (`ports.stopTask`, and the daemon's route) and the task paused, "Stopped by you". The project does not count it as "needs you" (design §2) |
| `task.resume` | project | low | yes (paused again) | `needs_human` → ready, "Resumed by you"; `without_answers: true` is the Tasks tab's Go ahead without: the task's open Inbox cards are withdrawn and a note tells the specialist the person went ahead without answering; refused for a task only the person can do; its undo opens the cards again |
| `task.reopen` | project | low | yes (cancelled or done again) | Reopen (cancelled → ready) and Redo (done → ready, the person's note says what to fix) through `TaskRepo.reopen`, which takes `cancelled` and `done` (U-080); Redo is refused in words while the task's take-out pull request is open (R-pin, `redoWhileTakingOutSentence` in `daemon/take-out-words.ts`); W15-04: Redo of a done task answers its open merge card (a conflict notice, a rebuild card; `MERGE_CARD_KEY`) as the card's own Redo does, in the same transaction: the card is withdrawn with `redoneMergeCard`'s mark (`outcome: "redone"`, `redo_from_base`), so the next run starts the branch from main and no rebase-conflict card follows (live check 2, F3: a second card beside the notice); it starts no session (the Tasks-row owner question). The cards are withdrawn inside `personMove` (`redoMergeCards`), so they are in the change's `after.withdrawn_requests` with what each held where the mark goes (`after.redone_cards`, `redoMarkOf`), and the line says it ("Reopened "X" to redo it from main: … Its card in the Inbox was withdrawn.", `moveSentence`'s `fromMain`); its Undo opens them again without the mark (`notRedoneMergeCard`) and says "…; its card is back in the Inbox." (fix-up of the review: the Undo left the notice withdrawn for good, and the conflict notice is said once) |
| `task.update` | project | low | yes (the fields as they were, while nothing changed them since) | Edit: title, outcome, criteria, priority, review level (`risk_tier`, in words by `reviewLevelWords`: a stored 0 reads "Light review", ADR 0104), budget, specialist, through `TaskRepo.edit` (an edit that hands a task to a deploy or a migration, or lowers one of theirs, stores the full review at least, `riskTierFor`, C-2), refused while the task runs or is being reviewed and once it is done or cancelled ("Redo it first") |
| `task.dependencies` | project | low | yes (what it waited for, while unchanged since) | what a task waits for (ids or titles), through `TaskRepo.setDependencies` (a cancelled task, the task itself or a cycle is refused with the titles); the daemon's `POST /tasks/:id/dependencies` runs it, so the change is in Changes (it bypassed the change log before). `depends_on` is the whole list; `add` (chat's "make X wait for Y") adds to what it waits for now and never drops one |
| `budget.set` | session / project / global (month) | medium within the ceiling, high above it or raising the ceiling | yes | see below; 0 on a project is no budget ("Set the project budget for X from CHF 3 to no budget: only the monthly cap limits its spending.", ask "Remove the project budget for X? ..."), 0 on the month or a session is refused with why (`ZERO_REFUSED`, the parameters' issue; later #43, polish-screens; the monthly cap's 0 is an open owner question, built as recommended: refused) |
| `autonomy.set` | project | one step medium, more high, same level low | yes | `project.autonomy_level` |
| `session.start` | session | medium above the costly threshold (USD 2), else low | yes (stop that start's session; `after.start_id` names the start) | ports or a `remote_command` row; refused with `ports.startBlocked`'s sentence when a start would do nothing (design §3.6: Stop all is on, Claude is not connected, nothing can run, the plan from the brief waits for approval), in `plan` (so the chat says why at once, with no Yes/No card for a start that cannot happen) and again in `run` (the state may change while a card waits); the sentence says what happened: "Started a session on X (up to CHF 5).", "... starts after the one running now ...", "... starts when your quiet hours end ...", "Sent a start for X to your PC ..." |
| `session.stop` | session / global | low | no | ports.kill or a `remote_command` row. Scope `agent` (a chat "stop", the default) is Stop now of the agent's running work sessions, one `kill({ sessionId })` each, which freezes nothing (design §3.7, §4.9: before, it stopped the agent's scope and froze it until Allow sessions again); `session` one named session; `all` is Stop all ("No session starts until you say "resume" or press Allow sessions again."). No run or process counts in the sentence |
| `session.pause` | session | low | yes (resume) | Stop after this task: ports or `session.status`; "The session on X stops after the task it is on." |
| `session.resume` | global | low | no | Allow sessions again (design §3.1): `ports.allowSessions` lifts Stop all and answers whether it was on; starts nothing ("Say "start a session" to continue where it stopped.") |
| `capability.grant` | global | high | yes | `extension.permissions`, `enabled` |
| `settings.set` | by key | by key (`SETTING_SPECS`) | yes | project settings/columns or human prefs/columns; a key with an `effect` (`small_project_mode`, spec B.6; `fast_mode`, spec D.20; the monthly jobs' `calibration`, global in `human.notify_prefs`, and `handover`, per project, ADR 0060; `speed_quality_offset`, spec D.16; `model_watch`, global in `human.notify_prefs`, `{ run_evals?, allow_process_sandbox? }`, strict, both default off, ADR 0089: whether the weekly model watch runs its paid eval sets without asking and whether eval commands may use the process stand-in; medium risk, but high with `allow_process_sandbox: true` through `SettingSpec.riskFor` / `settingRisk`, so the device confirms) says what changes in the card's new value and the sentence, both ways; `voice_alerts` (global, low, boolean) is the voice notification channel's switch in `human.notify_prefs` (ADR 0063); `critic_ceiling` (per project, medium) takes a rung of the ladder (`haiku`, `sonnet`, `opus`, `fable`; anything else is refused, U-060) and is the Settings control "Highest model"; `quiet_hours` takes `null` to turn quiet hours off; `billing_order` (global in `human.notify_prefs`, low, U-078, ADR 0100) is the person's order of their Claude credentials, a list of distinct kinds (`subscription`, `api_key`, `plan_credits`) or `null` for the defaults, which the billing router reads at every pick; `SettingSpec.display` words it in the card and the change log ("the API key, then the Claude subscription"), never as JSON; `status_pull_request` (per project, low, C-57, ADR 0106) sends a repository project's `docs/status.md` to GitHub as one status pull request when true (off by default: the status stays in the app), its effect worded both ways; `merge_mode` (per project, medium, merge-in-app, the owner's decision of 2026-11-02, ADR 0111 amended) is "Who merges accepted work": `you` (the default, "You press Merge": each accepted task's pull request waits for the person's Merge in the app) or `after_review` ("Merge automatically after review"); `narrows` lets `you` apply at once and asks a yes for `after_review`, whose effect says that merges show under the person's GitHub name, a comment on a merged pull request starts nothing, and on a repository whose main goes online by itself every accepted task goes live (`mergeModeEffect` in `@forerunner/runtime/loop/merge-mode`); `mid_session_limit` (global in `human.notify_prefs`, medium, U-078, ADR 0100 amended 2026-11-03) is "When my first choice runs out mid-session": `wait` (the default: a task whose first credential reached its usage limit waits for the reset and starts by itself) or `use_other` (it goes on at once on the next credential, which may cost money; `narrows` lets `wait` apply at once and asks a yes for `use_other`), task runs only; `code_commands` (global in `human.notify_prefs`, medium, U-078, the credential chooser) is "Code tasks that need commands": `first_choice` (the default: such a task runs on the first credential in the person's order; on a Claude subscription it cannot run commands, so its own tests do not run) or `api_key` (running commands becomes a hard need, so it goes to the API key, which costs money; `narrows` lets `first_choice` apply at once and asks a yes for `api_key`); `push_unfinished_work` (per project, low, budget-resume, ADR 0112 amended, `@forerunner/runtime/session/push-unfinished`) pushes a paused task's work in progress to its branch on GitHub too when true (off by default: it stays on this computer), its effect worded both ways; `web_access` (per project, medium, 'sites', ADR 0107 amended) is "Web pages research may read", `{ mode: "any" | "only", only, never }`: every entry goes through `cleanSiteList` (`@forerunner/runtime/wiring/web-access`) and is stored cleaned, an entry it refuses is a refusal naming it and why (`SettingSpec.plainRefusals`: the words without the key), "only" with no site is refused; `SettingSpec.narrowingActsAtOnce` makes `settings.set`'s risk low when `narrows(value, current)` holds at the time of the change (a block added, any to only, a shorter only list) and the key's risk otherwise (a yes), `currentOf` reads the rule in force (`webAccessOf`, the older `browser.blockedDomains` included) and `writeAlso` takes those blocks out of `browser` in the same write |
| `note.add` | project | low | yes (dismiss) | `queue_item` |
| `summary.speak` | project | low | no (stop the playback in the app) | nothing; `ports.speak` reads the one-screen summary aloud (spec A.6, L.6; ADR 0063) when it is asked to be heard: from the app (source `ui`) or in words that say so ("read", "speak", "aloud", "vorlesen"). Typed "summary", "summarise the last session" (design §3.9) answer in text with `chatProjectSummary`: "X: 4 of 7 tasks done.", the engine's last-session result (its one spend figure), "Next: ...", and no attempt to speak (before: the voice provider's install error with module and secret names, then a second, disagreeing spend total). Read aloud the sentence is "Reading the summary of X aloud. <text>"; in a voice session the sentence is the text itself (the loop speaks it, no second voice); when it cannot be heard (no port, no usable provider, no app window that plays speech) "I cannot read it aloud: <plain reason>. Here it is:" and the text summary, never the provider's reason. `after` says whether it was spoken and by which path. Another human's project (the named one or the active one) is refused as `not_found` "the project "X" is not yours" before anything is read, by `ownsProject` (`src/ownership.ts`: members, `shared_with`, author, or no owner facts at all), the one rule the daemon's speak route uses too. `spokenProjectSummary(project, spendUsdMicro, chfPerUsd)` is the one builder of the text, used by the daemon's `GET /projects/:id/summary` too |
| `request.answer` | project | the request's own risk | no | `human_request.answer`; a card that needs a device confirmation (high risk) is refused with "Answer it on its card in the Inbox: \"X\" failed 4 times. Nothing else was filed." (the card's title from `ports.cardWords`; `details.reason: answer_on_card`) and no second card is filed (design §3.8; before, a second approval card "approve on device / reject" appeared beside the first); the retry card after the ladder's last rung is high when the critic found a high or critical problem. A medium-risk card (the plan, the runner's failed-task card, the review-failed card, findings with no high one) answered in chat or voice is read back once in the card's own words (`ports.cardWords`: "Approve and start (Plan for \"X\": 3 tasks)? Writes these 3 tasks and starts working on them now.") and its pending row carries `chat_only: true`, which the Inbox, its counts, the project's status sentence and health, notifications and the chat's open-card list leave out, so the card stays the one card about it (phase E; before, a second yes/no card "the request …" sat beside it); the done sentence is the card's Done line once applied ("Plan approved: 3 tasks written; working on them."). A reference (an id prefix) never matches a pending change row: ids are time-ordered, so the read-back filed a moment after the card shares its first characters and the yes was refused with "several open requests start with …" |
| `email.mode.set` | global | high | yes (undo also turns email commands back on when the change turned them off) | `extension` kind `capability`, name `email:<agentId>`, `config.settings.mode`; a change to `off` also turns email commands off (ADR 0081), see below. The agent must be the human's own (S.15): an `agent` id that names another human's agent is refused `tool_not_allowed` ("not yours") on plan, run and undo before any card is formed, and a name is looked up among the human's agents only (`not_found` otherwise); the Settings -> Capabilities -> Email page runs this command for its mode picker (ADR 0066, amended 2026-10-25) |
| `device.revoke` | global | high | no | `device.revoked` |
| `memory.record` | project | low | yes (retire the lesson; a merged one restores the lesson it superseded) | `ports.memory.recordLesson`: a lesson in the private memory of the human's own principal, for the named or active project (none: every project), source `human:<id>;<chat|voice|...>:<conversation session>` |
| `specialist.propose` | global | medium | yes (withdraw the proposal while it waits for the human) | nothing itself: `ports.specialists.propose` (the runtime's approval gate, ADR 0071) writes `proposed/<name>/specialist.md` with `status: proposed` and `proposal.json`, and files the human's blocking `approval` request keyed `specialist:<name>`; spec C.5, see below |
| `repo.create` | project | medium for a private repository, for every actor at every level (the agent at Autopilot too: the owner's decision of 2026-11-02); high for a public one | no (deleting a repository always needs a person) | `ports.repos` (the runtime's `RepoCreator`, U-037, ADR 0097): a GitHub repository named after the project (or `name`), under the token's account (or the `owner` organization), created empty with the person's token; the project's workspace pushed as the first commit; the project's `repos` set to it. The card says the name, where and private or public; Chat: "create a repository [for X]", "make a private GitHub repo", "erstelle ein Repository für X" (`matchRepoCreate`). While the agent's offer for the project is open (its card key is `ANSWER_CARD_KEYS.repoCreatePrefix` plus the project's id, read from `@forerunner/runtime/wiring/request-answers`, not a copy of it: TM-10, leftovers7-tailmerge), a request from Chat files no second card (`assertNoOpenOffer`) |
| `model.settings.set` | global | medium for a non-null `tier` or `effort` and for `speed_mode: fast`, else low | yes | one field of the principal agent's `model_config` (`modes.<planning\|text_chat>.<field>` or `specialists.<name>.<field>`; spec D.4, ADR 0072) |

`memory.record` (spec O.2, ADR 0061) is how a lesson the human states in chat or voice reaches
the principal's memory: "remember that ...", "lesson: ..." by pattern, or the model's
`memory_record` tool for the same thing in other words. It is low risk (no limit, no spend,
nothing outside the human's own memory), so it acts at once and the sentence reads the stored
text back: `Recorded a lesson in Alice's memory for PharmaWatch: "...". It changes no setting.
Undo.` (up to 300 characters; W15-29: the sentence and the tool's description say a lesson
changes no setting, since live the chat recorded "only read developer.mozilla.org for research"
as a lesson and told the person the rule had changed). The command refuses a context without a principal agent or an agent the human
does not own; the port (`MemoryCommandPort`: `recordLesson`, `forgetLesson`) is the runtime's
`memoryCommandPort(MemoryLoop)`, which also runs the lesson injection screen and the memory
lint (a text under 20 characters is refused with the lint's reason). Without the port the
command is refused with `unavailable`. A lesson an agent records (the conversation model's
`memory_record` tool, whose context carries repository docs) must be grounded in the human's
words of that turn: at least `LESSON_GROUNDING_MIN` (half) of its content words appear in
`ctx.wordsUsed`, else it is refused as `injection_suspected`, so a doc section cannot write
itself into the principal's memory through the model; a human actor's command is the human's
words and is not checked.

`model.settings.set { agent?, mode? | specialist?, field, value }` (`src/commands/model-settings.ts`)
changes one D.4 setting: `field` is `tier`, `effort`, `max_tokens`, `speed_mode`,
`timeout_minutes` or `temperature`, validated by the runtime's `RunSettingsOverrideSchema`
(1 to 128000 tokens, 1 to 1440 minutes, temperature 0 to 1); `value: null` removes the override
so the registry file or the effort table applies again (an emptied group is removed too, and the
whole document is checked against `AgentModelConfigSchema` before the write). Exactly one of
`mode` and `specialist`; `agent` defaults to `ctx.agentId` and must be the human's own principal
(another human's agent is `not_found`, the critic is refused: spec H sets its model). The ports
`ctx.ports.modelSettings` give the runnable specialists (an unknown name is `not_found`) and the
provider's capability flags: a temperature is refused unless `acceptsTemperature` is true (with
no port, always); and, through `maxEffort(name)`, a specialist's registry `max_effort`: an
`effort` above it is refused (`validation`, "runs at most at high (its max_effort)"), because the
executor would cap the run there anyway (the agent's own modes have no such cap). The sentence reads "Set the max tokens per call of the coder specialist for
Alice from the default to 8000. Undo." The schemas are imported by deep path
(`@forerunner/runtime/models/run-settings`), because the runtime package imports this one and
the index would be half-initialised at that point.

`budget.set` stores money in USD micro-units with the CHF figure beside it (ADR 0008; the rate
comes from `ports.chfPerUsd`): a temporary session budget is `project.settings.
session_budget_override = {cap_usd_micro, cap_chf_micro, rate_chf_per_usd, expires_at}`; a
permanent session cap is `settings.session_cap_usd_micro` and `session_cap_chf_micro`; the
project budget is `project.budget_usd_micro` plus `settings.budget_chf_micro`; the monthly
ceiling is `human.monthly_cap_usd_micro` plus `notify_prefs.monthly_cap_chf_micro`. Unset
values fall back to the billing defaults (CHF 5 per session, CHF 150 per month).
`sessionBudgetOf(project, ctx)` and `monthlyCeilingOf(human, ctx)` are exported for the runtime.

`email.mode.set` keeps ADR 0081 (email commands need a sending mode other than off): a change
to `off` while commands are on turns them off in the same write, and the card and the sentence
say so ("...from Read only to Off; email commands are turned off with it, because at Off the
agent could not answer them. Undo."). With `ports.emailMode` wired (the daemon, runtime.md) the
command hands the change to the capability's `EmailSettingsStore`, which writes the
`email.settings` `commands_switched_off` audit row and tells the owner (`email_commands_off`
notification); without the port (tests, a hand-built executor) the command writes the row
itself under the same rule, drops the `email-commands` permission and appends the same audit
row, without a notification. The run records `before.commands_enabled` and
`after.commands_switched_off`; the undo restores the mode and, when the change turned commands
off and the restored mode is not `off`, turns them back on (`restoreCommands`).

`specialist.propose` (`src/commands/specialist.ts`; spec C.5 "PM can propose a new specialist;
it goes live only after human approval and passing its eval set", [ADR 0071](../decisions/0071-specialist-approval-gate.md))
is how the principal agent reaches the specialist approval gate from a session: on the
conversation agent's model path it is the `specialist_propose` tool (`CommandLoop.tools`,
`packages/runtime`), and the palette, the API and the phone run it by name. Its parameters are
the registry file's frontmatter fields under their file names (`adding-a-specialist.md`):
`name`, `description`, `default_tier`, `allowed_tools`, `output_contract` are required, with
`rationale` (why the agent wants it) and `prompt` (the role prompt, markdown); `version`
(`0.1.0`), `default_effort` (`medium`), `max_effort` (`high`), `allowed_domains` (`[]`),
`max_budget_usd` (1), `max_turns` (20), `timeout_minutes` (15), `risk_tier_floor` (1) and
`requires_sandbox` (true) default to a cautious new specialist, and `max_tokens`, `speed_mode`
and `temperature` travel only when named. `status` and `eval_set` are never parameters: the
gate forces `proposed` and derives `evals/<name>`. The command writes nothing itself. `plan`
asks `ports.specialists.check(name)` and refuses a name an active specialist or a pending
proposal holds (`claim_conflict`), then builds the card ("the specialist registry", from `no
specialist "x"` to `a proposed specialist "x" (tier; tools; USD n per run; risk tier floor r)
waiting for your approval in the inbox`; the card never carries the prompt, which the human
reads in the file). Medium risk: a yes is needed, so a model cannot flood the inbox, and an
agent's own yes is refused like any other. On the yes `run` hands the proposal to
`ports.specialists.propose` (the runtime's `SpecialistApprovals.propose`, which runs the
loader's own checks on the exact bytes, writes `proposed/<name>/` with `runnable: false` and
files the one blocking approval request), recording `prompt_version`, `request_id`, `file`,
`eval_set` and `eval_task_count` in `after`; the proposer is the agent on the model path
(`actor.kind === "agent"`), else the human's principal, with the active project when there is
one. The sentence says what is still missing: "Proposed the specialist "x" (tier): approve it
in your inbox; it goes live only after your approve and a passing eval set (n tasks at evals/x
today; at least 10 are needed and 90% must pass). Undo." Whatever the gate refuses (an unknown
tool, a prompt over 120 lines, a name taken meanwhile) comes back as its `ForerunnerError`
code and message in the refusal (`validation`, `claim_conflict`), never a stack; without the
port the command is `unavailable`. The undo calls `ports.specialists.withdraw`, which takes the
proposal back while it still waits (the runtime's `SpecialistApprovals.withdraw`: a request the
human already answered, or a running evaluation, refuses the undo with `claim_conflict`). The
command has no parser phrase on purpose: a proposal is a structured object the model builds,
so "propose a specialist" reaches the model path with the tool, never a regex.

### The change card (`src/change-card.ts`)

A `settings.set` card's `newValue` is the value in words (the key's `display`), never with its
effect (P7-10: "Who merges accepted work" showed the label plus the whole effect); the effect is
the change log sentence ("Set X from a to b: <effect>.") and the read-back's second sentence
(`askOf`: "Set X to b? <Effect>."), which the Inbox shows as the card's body. A value without
words of its own is never JSON (`show`: an object as "field: value" pairs); the calibration, the
handover test and the model watch have their own (`calibrationWords`, `handoverWords`,
`modelWatchWords`, later #30/#99). `web_access`'s display is `webAccessWords` ("only example.com",
one colon in the sentence, P7-31).

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

Values are words, never JSON (design §5): a `SettingSpec.display` says them ("quiet hours":
`quietHoursWords`, "12:00–18:00" or "off"; "default autonomy": `autonomyLevelWords`, "Trusted
(level 3)"). A card may name its scope itself (`buildCard({ scopeLabel })`): a project's
per-session cap (`budget.set` with `scope: "session"` and no `until`) holds for "every session of
PharmaWatch", not "this session"; `renderChangeCard` names the project once. A change to the
value already set is refused before anything is written, in words: `settings.set` ("The default
autonomy for new projects is already Trusted (level 3).", `refuseNoChange`) and `budget.set`
("The session budget for PharmaWatch is already CHF 5."); the walks found "from 3 to 3" accepted
and logged in Changes. `settings.set` and `budget.set` read back in one line (`ask`: "Set quiet
hours to 12:00–18:00?", "Raise tonight's session budget for PharmaWatch to CHF 20 until
06:00?"), not the rendered card with its "Risk:" line.

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
the principal agent to the human (an Update in the Inbox) only when the change is not the
person's own (an agent's command, or a temporary change reverting by itself: design §3.8
Updates, §5.11 "do not echo the person"; before 2026-11-01 every Tasks tab click, chat command
and project switch landed in the Inbox as "from Alice"; the person's own changes are in Changes
and in the chat's reply), and for a shared project a message to every other human
(`ports.sharedWith(projectId, humanId)`, default `project.settings.shared_with`) prefixed with
the asking human's name. A failed post never undoes the change.
`request.answer` also calls `ports.requestAnswered(requestId)` once the answer is recorded: the
daemon applies it at once (its `syncApprovals`), as its answer route does, so an approved plan
said in chat or voice starts its follow-up without waiting for a poll (ADR 0053 amendment).
Before that, in `plan` (so before any confirmation is asked for) and again in `run`, it calls
`ports.checkAnswer(request, answer)` (U-034): the daemon wires the runtime's
`assertAnswerAccepted` (`runtime.md`, "Answers as the person gives them"), so a word a
structured card cannot act on ("maybe later" on a sign-off) is refused with a `validation`
error whose reason lists the card's options, and the request stays open, as on the daemon's
and the state service's answer routes. Without the port any answer is taken.

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
`approval_required`. `undoable(humanId, projectId?)` lists the candidates.

An undo is confirmed like the change it makes (U-057, ADR 0099). `undoRiskOf(row)` takes the
highest `undoRisk(params, before, after, ctx)` of the row's commands, the risk of putting
`before` back on today's state; the undo then goes through the same gate as a forward change
(`act`, a pending card answered with a yes or tap, or the paired device), with an undo card
("undo: the monthly cap", old and new value swapped) and the Inbox request. `budget.set`:
putting back a higher cap is the raise's risk (the monthly ceiling, or a cap above it: high;
a cap within it: medium), a lower one acts at once; `email.mode.set`: a wider mode (or email
commands back on) is high, a narrower one acts at once; `autonomy.set`: a higher level asks as
raising it would; `settings.set`: the restored value's `settingRisk`, except the safe side a
spec names with `narrows` (a lower default autonomy, fast mode off, fewer people, a lower
highest model, less the model watch may do, a monthly job off); `model.settings.set`: the
value's risk. A command without `undoRisk` undoes at once. The confirmed undo re-reads the row
(`performUndo`), so an undo answered after the row changed is refused.

An undo that cannot work says so (U-061): `undoBlockedReason(row)` is the row state (undone,
reverted), a project whose creation was undone ("the project X was removed", W15-36) and each command's `undoBlocked` in plain words, checked before the gate and again
before the run, and `CommandLoop.undoBlocked` gives it to `GET /changes`, which offers no Undo
then. `task.create` cannot be undone once the task cannot be cancelled; a task move
(`task.transition`, `task.pause`, `task.resume`, `task.reopen`) once the task moved on;
`task.update` and `task.dependencies` once the fields changed again; `note.add` once a session
read the note; `session.pause` once the session ended; `capability.grant` once the extension is
gone. State-based undos that used to return without a change now throw. `undoSentence` gives
the sentence when "<what> is back to <old value>" would not be true (`task.create`: "Undone:
cancelled the task ..."; a move: "Undone: the task "X" is ready again.", a cancel: "Undone:
reopened the task ..."). A command's `undo` may return a sentence that is added to the undo's
own (the closure kept from the run returns those of its steps too): the undo of the cancel of a
task that ran or was reviewed calls the `bringBackWork` port (the session took what the run
changed out of the folder, ADR 0105) and adds "What it changed is back in the folder." or
(`UNDO_CONFLICT_WORDS`) "What it changed could not be put back: the same files changed since.
Its next run does the work again." The cancel's own sentence says what happens to the work, in
the words of `@forerunner/runtime/daemon/cancel-words` (budget-resume; one place for the
command, the Tasks tab's dialog and the fake daemon): 'Cancelled "X": its run stopped and its
changes are removed; Undo restores them unless the files changed.' (L-6: the session's next task
may rewrite the same file within seconds), "its pull request stays open" for a task with a pull
request, "what it wrote stays in your folder" for a project linked to the person's own folder
(C-37, `ownFolderOf`: its `repos[0]` is an absolute path), and for a task that does not run (a
paused one) the `setAsideWork` port's answer: "its work so far is set aside; Undo brings it
back." (`after.set_aside`, which the undo reads to call `bringBackWork`: "Its work so far is
back.") or "its files stay in the folder: "Y" built on it.". Undo of a cancel says 'Undone:
reopened the task "X"; it is ready again.' and promises no session (C-30). `task.reopen` of a
cancelled task calls `bringBackWork` too ("Its work so far is back."): the Inbox card's Cancel
task has no Undo. A person's move out of `in_review` stops the review through `stopTask` as
a move out of `claimed` or `in_progress` stops the run. The sentence says so only when
`stopTask` answers `true` (a live run or review was stopped; the session sets aside exactly
those): a task in review that no session reviews (its card waits, or Forerunner closed during
its review) reads 'Cancelled "X".', and its files stay (phase C review). The chat's read-back
of a cancel (`moveAsk`) says 'Cancel "X"? Drops it. Its run stops and its changes are removed;
Undo restores them unless the files changed.' (at most 100 characters after "Drops it.", W6-7;
`cancelWorkFor` adds a paused task's set-aside line and the own folder's) for a running
task, and "Its review stops ..." for a task in review only when the `liveWork` port answers
that its review goes on here (the daemon: `KillSwitch.hasTask`; without the port a task in
review is taken to have no review going on; a running task's read-back always says its run stops;
L-7). A task with a pull request (`pr_url`: a GitHub project's task carries one from the end
of its run, before its review) reads "its run (or review) stops now; its pull request stays
open" instead, as the line after Yes and the Tasks tab's Cancel dialog (`cancelWorkLine`) say:
the cancel keeps its pull request and takes nothing out of the folder. Every person's move of a task can be undone (design §3.5: "every
action has one Undo right after it"): the undo puts the task back as it was. The move's
`before` records the row's `status`, `reason`, `author_human`, `author_agent` and `attempt`;
the undo restores them through `TaskRepo.restoreStatus` (a status only an agent sets comes
back as ready; back to failed the retry count a Try again raised is taken back), so an agent's
pause reads "Needs your answer" or "Paused" again and never "Paused by you", and a failed task
reads "Failed: tried 4 times", not "Failed: undo". The cards the move withdrew
(`after.withdrawn_requests`) are opened again (`HumanRequestRepo.reopenWithdrawn`), and the note
the move queued is taken back while no session read it. The sentence says what is true again:
"Undone: the task "X" needs your answer again; its card is back in the Inbox.", "Undone:
reopened the task "X"; it needs your answer again and its card is back in the Inbox.",
"Undone: the task "X" is marked failed again; its card is back in the Inbox.". Before these
fields were recorded (an older change), the undo writes "undo" and its own author. The undo of
a Redo is refused in words while the critic still asks for changes ("the critic still asks
for changes to "X", so it cannot be done again"), not with the store's `findings_open` text.
`task.resume` with `without_answers` is refused for a task only the person can do
(`specialist: person`): nobody would go ahead, the next session would ask again.

**Task sentences and notes** (design §5). A task command's sentence is one plain line with
the task's title, no raw state and no "Undo." (the Undo is a button beside it):
"Paused "X": no session runs it until you press Resume.", "Cancelled "X". "Y" waits on it
and is stuck now.", "Reopened "X" to redo it: …". A move out of waiting for the person
(`needs_human`, `failed`, `in_review`) or a cancel withdraws the task's open Inbox cards and
says so ("Its card in the Inbox was withdrawn."); the card never lingers as blocking. The
person's note (`note` on every task command: "Note for the agent (optional): goes into the
task's next brief") is queued as a `note` queue item that names the task (`taskNoteText`:
"About "X": …"), which `notesForTask` routes to that task's brief only. On a cancel the
sentence says "Your note goes into its brief if you reopen it.": a cancelled task has no next
brief until it is reopened. `task.update` and `task.dependencies` on a paused or failed task
leave the row's reason and author as they were (`TaskRepo.edit`, `setDependencies`), so the
row still says why it waits.

Temporary changes (`expires_at`) get a Clock timer; at the time the executor
reverts them (same undo), marks the row `expired`, logs a revert row (`undo_state`
`irreversible`, commands carry `revert_of`) with "Reverted tonight's session budget for
PharmaWatch to CHF 5; the window until 06:00 ended." and posts it. `resumeScheduled(ctxFor)`
after a start reverts the windows that closed meanwhile and re-arms the open ones;
`stop()` cancels timers at shutdown.

`ExecuteResult` is `done | partial | pending | cancelled | refused` with the card, the change
log id and `undoToken` (the change log id while undoable), or the pending id, decision, expiry,
email token and readback, or the reason and error code.

### Read back in one line (design §3.9, §5)

A command may give its card an `ask` (`buildCard({ ask })`): the change as one question with the
button's consequence ('Pause "Create notes/todo.md"? No session runs it until you press
Resume.', 'Make "Write the FAQ" wait for "Write the README"?', "Start a session on Quote page
(up to CHF 5)?"). A pending card with one reads back as that question alone (voice adds "Say
yes or no."; the paired device's card says to confirm there), in place of the rendered card and
"Say yes to confirm, or reply yes to the email." (shown even with email off); a composed card
asks every part's question. In chat and voice a card without an `ask` is asked in one line too
(`questionOf`: every part's question, else "Change <what> from <old> to <new>?", a plan-less
card its description), never as the rendered card with "Risk: low" and "reply yes to the
email" (review of d1109-chat-guard: after a record, a project switch read back as "Change: the
active project. From ... Risk: low. Undo: ..."); the API, email and the settings screen keep
the rendered card. `project.switch` ("Switch to Shop page?"), `project.create` ('Create the
project "X"?'), `session.resume` ("Allow sessions to start again?") and `specialist.propose`
('Propose the specialist "X" for your approval? It cannot run until you approve it in the
Inbox and its test tasks pass.') have their own. The task commands (`task.transition`, `task.pause`, `task.resume`,
`task.reopen`, `task.update`, `task.dependencies`) are `askFromChat`: said in chat or voice
they are read back for a yes whatever their risk, because the words were interpreted ("skip
the LICENSE task") and the person should see which task it touches before it moves; the Tasks
tab's buttons (source `ui`) act at once with Undo (`CommandExecutor.decideSteps`).

**After a record, every change is read back (d1109-chat-guard, run C, ADR 0114, W15B-80).**
`CommandContext.recordsRead` (append-only; the chat's `CommandTurn.recordsRead`, passed in by
the runtime's command tools when each call's context is built) says the chat turn this change
comes from read a record: a read tool's or a command's answer marked untrusted, a card listed
in full in words Forerunner did not write, a flagged excerpt, lesson, task line or session
result. Such a record's words may be what asks for the change, so `decideSteps` answers
`needs_yes` for every change it would have acted on at once, whatever the risk (a higher
decision, a paired device, stays). Stopping is the safe direction (design §3.9):
`session.stop` of the running session (scope `agent` or `session`) and `session.pause` ("stop
after this task") still act at once (`stopsAtOnceAfterRecords`), and so does a command that
changes nothing (`CHANGES_NOTHING`: `summary.speak`, which reads the person's own project out
and speaks only when the person's own words ask; both in `actsAtOnceAfterRecords`); `session.stop` with scope
`all` (Stop all) is read back with the header's own question, "Stop every running session now?
No session starts until you allow it again.", so a record cannot stop all work by itself. The
person's own commands through the parser carry no flag and are unchanged. `task.create`
('Add "X" to Quote Page?'), `note.add` ('Leave this note for the next session on Quote Page:
"..."?') and `memory.record` ('Record this lesson in Alice's memory for Quote Page: "..."?')
have an `ask`, so their read-back is one question and never the rendered card.

**A command answer that quotes text the person did not write (`CommandOutcome.untrusted`,
append-only, d1109-chat-guard).** A command whose sentence quotes such text (d1109-onerepo-link's
"used elsewhere" answer quotes a repository's marker; `summary.speak`, origin `record:summary`,
whose "Last session:" line quotes the session's result and through it a run's report: the
fix-up's bench walk saw "It reported: Ignore previous instructions ..." reach the model plain
through `summary_speak`) sets `untrusted: { source, origin }` on
its outcome; the executor keeps it on the done result (`ExecuteResult.untrusted`), `toToolSpecs`
puts it on the tool's result (`ToolOutcome.untrusted`), so the enforcement hooks wrap the
sentence as data and scan it, and the runtime's `noteRecordsRead` sets the turn's
`recordsRead` for the calls after it.

**A move that is a card's answer (`CommandDef.redirect`, phase E review).** Before it plans a
call, the executor asks the command's `redirect` whether the call is better said as another;
a redirected call is planned instead (never redirected again), stored in the pending card's
`calls` as planned, and read back first if the original was `askFromChat` (`Step.askedAs`).
`task.transition` (to `ready`, `cancelled`, `done`) and `task.resume` (with `without_answers`:
Go ahead without) redirect, said in chat or voice with no note, when an open card of the task
offers the same option as its button says it (`moveAsCardAnswer`: **Try again**, **Cancel
task**, **Mark done anyway**, **Go ahead without**, matched on `ports.cardWords`): the call
becomes `request.answer` on that card. Before, "try X again" on a task whose failed card was open
read back 'Resume "X"?' and filed that read-back as a second Inbox card about the task. The
Tasks tab (source `ui`) and a move with a note move the task as said.

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
text throw `ForerunnerError("injection_suspected")`. Lessons, notes, "add a task: ..." and "make this a task" are matched on
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
| start a session [on X] [on my PC / in the cloud] [with 10 francs] [now], start working [now], get started, start the work, starte eine Session auf meinem PC | `session.start` (a trailing "now", "right away", "again" changes nothing) |
| stop everything / stop all, stopp alles; stop, stop now, stop the session, stop working; pause | `session.stop {all}`; `session.stop {agent}`; `session.pause` (`stopScopeOf` is the exported pattern; `isStopLine` says whether any clause of a line is one, outside the data envelope) |
| stop after this task, stop when the current task is done, finish this task and then stop | `session.pause` (matched on the whole line, before "and" splits it) |
| resume, continue, allow sessions again, resume work | `session.resume` |
| make the FAQ task depend on the README task, make X wait for Y, X should wait for Y, run X after Y | `task.dependencies {task: X, add: [Y]}` (whole line; never a question) |
| skip X for now, postpone X, pause the X task, stop the X task; skip X, cancel X, drop X (L-10: "skip X" is the row's Cancel, its read-back says a run or review going on stops and its changes are removed); resume X; reopen X, redo X; try X again, retry X; make X ready | `task.pause`; `task.transition {cancelled}`; `task.resume`; `task.reopen`; `task.transition {ready}` (X by title within the project; "the" and "task" dropped, before or after the name: 'skip the task "Write the FAQ"' finds "Write the FAQ", phase C leftover C-38; the session or work itself is never a task's name) |
| summarise the last session, summarize it, recap | `summary.speak` |
| remember that ..., lesson: ..., lesson learned: ..., merk dir, dass ..., Lektion: ..., Lehre: ... | `memory.record` |
| note: ..., idea: ..., correction: ..., Notiz:, Idee:, Korrektur:, remember ..., merk dir ... | `note.add` |
| read me the summary [of X] [aloud], speak the project summary for X, summary, lies mir die Zusammenfassung [von X] vor | `summary.speak` (the active project unless one is named; "Which project?" when neither) |
| add a task: ..., create a [new] task: ..., new task: ..., neue Aufgabe: ... | `task.create` with status `ready` (U-015: the app told people to say it, and nothing matched it); a level said at the end ("…, priority high", "… (low priority)", "… with medium priority", "…, Priorität hoch", "… mit niedriger Priorität"; `priorityPhrase`) is the `priority` parameter and is cut from the title (U-041); the title is `taskTitleOf` the words (phase E, live walk 2 C2): the first line without a leading "to", "please", "can you" or "could you", capitalised, cut at a word to at most 80 characters with "…" (never on "of", "and", "with" and the like), while the words as said stay the outcome; "add a task to write the README" matches too |
| make this a task, mach daraus eine Aufgabe | `task.create` from `ctx.lastMessage`, status `ready` (U-016, ADR 0093), titled by `taskTitleOf` |

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
port the result is one question with options and nothing runs, with one exception (spec O.9,
"stopping is immediate"; review of w3-o9-chat-to-inbox, 2026-10-25): a clause that is a stop
("stop and tell me what happened", "stop everything, give it 20 francs and paint the fence")
runs alone and at once, and every other clause of the line, understood or not, is returned as
`unmatched` for the conversation agent to name ("I did not act on ..."), never asked about,
since a question in the stop's way would leave the session running (and the agent would hand
the line to it as a said line). A line understood in full still runs every command, the stop
among them.

### Wave 15 (w15-chat): what the chat model is told and refused

- **`settings_set`'s definition (W15-29).** Live check 2 (2026-11-09) gave the real chat model
  `settings_set` as "Change a setting by key. Keys: …" with `"value": {}`; it sent "public",
  then `{allowed: "public_websites"}`, then "any" for `web_access`, and recorded a lesson
  instead. The description is now `settingsSetDescription()`: what a setting is (a rule the app
  enforces, never a lesson), then one line per key from `settingDefinitionLine(spec)`: its
  scope, its `description`, its value's shape (`settingValueShape`, rendered from
  `z.toJSONSchema(spec.schema, { io: "input" })`, the input side, since `WebAccessSetting`'s
  transform cannot be written on the output side) and `SettingSpec.examples` where the shape
  alone does not say how words map to it (`web_access`, `quiet_hours`). `value` carries a
  `.describe()` so the tool schema no longer reads `{}`. A refused value (`refusalOf`): a key
  without `plainRefusals` keeps `<key>: <issues>` with each field's path; a `plainRefusals` key
  keeps its whole sentences (a site it cannot take, an empty "only" list), and a value of the
  wrong shape is "That is not a value for web pages research may read (<field>: <issue>). It
  takes {"mode": "any" | "only", "only"?: [string], "never"?: [string]}, for example …".
  `packages/commands/test/w15-chat.test.ts` asserts the definition's lines and these refusals.
- **An undo waiting for a yes asks one question (W15-34).** `undoCardOf` gives the undo's card
  an `ask` and the change's own `what` (before: `what: "undo: <what>"` and no question, so the
  Inbox and Home titled the card "undo", with raw "yes"/"no"). The question is the command's
  own, `CommandDef.undoAsk(params, before, after, ctx)`, read from the change log row so it is
  the same after a restart: `settings.set`'s is "Put <label> for <project> back to <old value
  in words>? <What that value means>." ("Put web pages research may read for Reading rules back
  to any public website? Research reads any public website …"). Without one: "Put <what> back
  to <old value>?" from the card kept in memory, else 'Take back "<the change, without its
  effect>"?' from the row's sentence. The read-back is that question, and Changes shows it
  alone with Yes and No (no card rows).
- **A refusal says why in the schema's words (W15-35).** `CommandRegistry.validate` refuses
  with the parameters' own sentence when an issue carries one (`isSentence`: a capital first, a
  full stop last; `ZERO_REFUSED` for budget.set's 0 for a session or the month), else
  "<command>: invalid parameters (<field>: <issue>; …)"; the issues stay in `details.issues`.
  Before, every client but chat read "budget.set: invalid parameters". The parser's question
  (`invalidQuestion`) asks with the same sentence and no command name ("The monthly cap must be
  more than … Which value did you mean?").
- **Tasks of one title (W15-37).** `findTask` (task.ts) told two tasks titled "Write the guide"
  apart by nothing: "Say more of the title", which no words could do. Now tasks with the same
  title are named by what tells them apart (`sameTitleTags`): their pull requests ("#17 and
  #18") when each has its own, else their states ("the done one and the cancelled one"), else
  their age ("the older one and the newer one", then "the first one", "the second one" …):
  'Two tasks are called "Write the guide": #17 and #18. Say which, for example "Write the guide
  #17".' That word after the title picks one ("Write the guide #17", "Write the notes (the done
  one)", "… older"), in the UI's commands and in chat ("redo Write the guide #18"). The example
  puts a state or an age in brackets, never after a comma: chat splits a line at its commas
  into separate requests, so "Write the guide, the older one" never reached the command (review
  of W15-37; chat case in `conversation-memory.test.ts`).
- **Money with two decimals (W15-44).** budget.set's sentences, read-backs, card values and its
  "already" refusal write amounts with `chfExact` (shared.ts), "from CHF 3.00 to CHF 12.00"
  (design §5 rule 7; before, `chf`'s whole francs, "from CHF 3 to CHF 12"). A session start's
  read-back keeps `chf` ("up to CHF 5"), as the design writes it.
- **The monthly cap's 0 says what to do (W15-45).** `ZERO_REFUSED.month` (and Settings'
  `MONTHLY_CAP_ZERO`, the fake daemon's refusal) reads "The monthly cap must be more than CHF
  0.00: it is the limit that stops all spending, so it cannot be turned off. Enter the most you
  want to spend in a month." 0 stays refused for the month (owner question W15-109 open).
- **A monthly job's schedule, once (W15-46).** The handover test's and the calibration's change
  sentence named the schedule in the value and again in the effect ("… to on, day 2 at 08:00: a
  fresh agent runs the seeded change on day 2 at 08:00 each month …"); the effect now says "each
  month a fresh agent runs the seeded change …" and "each month the critic grades the eval
  sets".

### Wave 15 (w15-words): on, off and CHF 0.00

- **A yes/no setting reads "on" or "off" (W15B-16).** `showFor` says a `z.boolean()` key
  without a `display` of its own as "on" or "off" (every one is off until set), in the card's
  values, the sentence, the read-back and the undo question: "Set Opus fast mode for Game from
  off to on: …", "Put Opus fast mode for Game back to on? …", "Set voice alerts from off to on."
  (before: "from unset to true", "back to true"). `test/w15-words.test.ts`.
- **The session budget's 0 says CHF 0.00 and what to do (W15B-16).** `ZERO_REFUSED.session`
  reads "The budget per session must be more than CHF 0.00: a session plans its work within it.
  Enter the most a session may spend." (before: "... more than CHF 0: ..."), as Settings'
  session cap field (`SettingsFields.tsx`) and the fake daemon say it. 0 stays refused for a
  session and for the month (owner question W15-109 open).

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
`SMALL_PROJECT_MODE_EFFECT`; `test/small-project.test.ts`, and `speed_quality_offset` with
`SPEED_QUALITY_EFFECT` / `speedQualityEffect`; `test/speed-quality.test.ts`). `fast_mode` (spec D.20, ADR 0057:
Opus fast mode per project; project scope, boolean, medium risk because it raises what every
Opus call of the project costs) takes its effect from the runtime's `fastModeEffect` (imported
from `@forerunner/runtime/models/fast-mode`, not the package index, which imports this package
back): on, the fast-mode rate against the standard one and "a subscription ignores it (API
only)"; off, back to the standard rate and the surcharge stopping (`test/fast-mode.test.ts`).
With the built-in table that is USD 8 / 40 against 4 / 20, a 2x surcharge; the description
says "(API only, priced separately)" and not "research preview", because Opus 5.5 fast mode is
generally available (ADR 0057 amendment, 2026-10-25). The person reads it in CHF at the day's
rate, "at about CHF 6.40 / 32.00 per million input / output tokens instead of CHF 3.20 / 16.00"
at 0.8 (W15-47, ADR 0057 amendment 2026-11-09; never USD, design §5 rule 7).
`SettingSpec.effect(value, ctx)` receives `{ pricing, chfPerUsd }`: the table from the optional
`CommandPorts.pricingTable()`, and the day's rate from `CommandPorts.chfPerUsd` at the clock's
time (`effectContext`, read only for a key with an effect; a rate that cannot be read leaves
the default rate). The undo's question (`undoAsk`) reads the same. The daemon passes the table in force: the built-ins plus
`<config>/pricing.json` and adopted rows. So the card the human confirms, and the change-log
sentence, quote the surcharge that runs are charged. The daemon's Settings row uses the same
table. Without the port, the effect uses the built-in table.
The runtime reads the flag per run (`runtime.md`, "Opus fast mode per project"). `settings.set` refuses unknown keys
(`settingSpec` looks at own keys only, so `constructor` or `__proto__` are unknown settings,
not prototype lookups), so the UI and the parser can only reach what is listed.

**The speed-versus-quality slider (spec D.16).** `speed_quality_offset` is a low-risk project
setting with three positions, -1 speed, 0 balanced, +1 quality (the schema refuses anything
else, -2 and +2 included: the runtime only ever shifts one step). Its `effect` names the
position and what it does, so a move reads "Set the speed-versus-quality slider for Game from
1 to -1: speed, every mode's default effort one step lower (faster and cheaper) from the next
run, turn or planning session. Undo." on the card, in the change log and in chat or voice; the
other directions say "balanced, every mode at its default effort ..." and "quality, every mode's
default effort one step higher (slower, more thorough) ...". The runtime reads the value from
the project row per run, turn and planning session (`runtime.md`, "The speed-versus-quality
slider"); the Settings screen renders the key as a slider (`apps.md`). `test/speed-quality.test.ts`
covers the three positions, the card and the sentence in both directions, the change log rows,
undo, and a refused +2 and -2 with the validation reason each way (the UI's fake daemon repeats
those words).

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
settings-screen path, a risen risk refused when the yes arrives; d1109-chat-guard: with
`recordsRead` a low-risk task, note and lesson wait for a yes in one line, the stop of the
running session acts and Stop all is read back), `undo.test.ts` (U-057, U-061: the undo of a lowered monthly cap waits for the device and a chat yes is refused, also after a restart; an undo that narrows acts at once; the email mode and the model watch; an undo that cannot work refused in words with nothing changed; a cancelled task reopened, a moved-on task not moved back; a read note not taken back), `security-commands.test.ts`
(the security review: the always-human commands carry the spec's risk, a pending card is not
confirmed by the wrong kind of answer, a guessed email token or another actor, a web or runner
device does not confirm a high-risk change without a second factor), `commands.test.ts` (the
PharmaWatch sentence exactly, every command's risk, writes and undo, prototype keys as unknown
settings; `email.mode.set` refusing another human's agent by id (`tool_not_allowed`, "not
yours") and by name (`not_found`) on plan and on run with no settings row written and the
`emailMode` port never asked, while the human's own agent by name is served (review of
w2-email-page, 2026-10-25); `memory.record` acting at once at low risk with the read-back sentence, the source
naming the human and the conversation session, another project or no project, undo through the
port, refused without an agent or without the port, an agent actor's lesson refused unless
grounded in the human's words; `summary.speak` through the port, in a voice session and without
voice, another human's project refused by id, by name and as the active project and allowed once
shared, the `voice_alerts` setting; ADR 0081: `email.mode.set` to off turns email commands off
with the audit row and the card saying so, the undo turns them back on, and with
`ports.emailMode` wired the command hands the change to the port and writes nothing itself),
`intent.test.ts` (the two spec sentences,
forty-four English and German phrases including the lesson phrases, "remember to" staying a note and the summary phrases, seven questions and ordinary sentences that are not lessons,
ambiguity questions, budget tails that are not a time, invalid values as a question, the
envelope refusal, the model port, time parsing with `rest`, a stop clause winning over an
unmatched remainder with every other clause returned as `unmatched` while a fully understood
line runs every command and a stop word inside a clause, a note or pasted data is no stop,
and `isStopLine` on the same lines), and `scenario.test.ts` (the
Android scenario end to end and the phase 5 gate: ui, chat and voice produce the same change
log entry), `fast-mode.test.ts` (spec D.20: the `fast_mode` spec, its card and the change
log sentences with the effect and the surcharge both ways, the yes a medium-risk change needs,
the flag written on one project only; a corrected fast row from `ports.pricingTable` quoted in
the card and the sentence), and `model-settings.test.ts` (5, spec D.4: a specialist field set,
a second one undone, `null` back to the default with the group removed; planning and chat
modes with a medium card for a rung and for fast; bad values, an unknown specialist, both or
neither targets, another human's agent and the critic refused; a temperature refused without
the port or the flag and stored with it; an effort above a specialist's `max_effort` refused),
and `specialist.test.ts` (4, spec C.5, ADR 0071, over a fake `ports.specialists`: the card and
the exact sentence, medium risk needing a yes, the yes handing the proposal with its defaults
and the agent, human and active project to the port, the change log row and the undo
withdrawing; the optional settings travelling as given and the card's eval-set size from the
gate; from an agent actor the human's yes needed and the agent's own refused with the row
naming the agent; refusals with a stable code: a bad tier and a bad name `validation`, a taken
name or a pending one `claim_conflict` at the card, the gate's own `validation` with its
message and no stack, no port `unavailable`, no principal agent `validation`).

Run: `pnpm exec vitest run --project unit packages/commands/test` (13 files, 177 tests).

## Known issues

- A pending confirmation keeps its commands (`change_card.calls`, the validated params) and
  its context (`change_card.context`: actor, human, agent, project, source, words, device,
  conversation session) on its `human_request` row; after a restart `restorePending` plans the
  commands again on the state as it is and the card waits as before (design §3.9). One that no
  longer plans (or was written before) is expired by the runtime and the human told to ask again
  (`expireOrphanedCards`, runtime.md, U-029). Reverts and undo survive a restart through the
  change log.
- "and" inside a project name splits the sentence; name the project without it or use the
  model port.
- Which human shares a project is read from `project.settings.shared_with` until the state
  service exposes project membership; `ports.sharedWith` overrides it.
- Session commands from a phone reach the PC through `remote_command`; the runner's pick-up
  loop is wired in the state service and daemon, not here.
- A posted sentence needs a principal agent (`ctx.agentId`) because messages have a sender;
  without one only the change log and the activity event are written.

## Requirements covered

D.4 (`model.settings.set`, the write path of the settings per agent and specialist; ADR 0072).
Q.1 to Q.12 (`registry.ts`, `executor.ts`, `change-card.ts`, `confirmation.ts`, `intent.ts`,
tests above); J.5 to J.10 partially (`autonomy.set` enforces the per-project level and its
confirmation; the runtime hooks enforce the levels at tool time); I.1 partially (`budget.set`
is the only way caps change, with the ceiling check); R.4, R.5 and R.7 partially (remote
session commands from a paired phone, the Android scenario, biometric for high-risk
confirmations); data model `command` and `change_log`; phase 5 gate "same change log entry
by voice, chat or UI" (`scenario.test.ts`); O.2 and J.1 with the runtime (`memory.record`, a
lesson stated in chat recorded in the principal's memory, `packages/runtime/test/conversation.test.ts`);
C.5 with the runtime (`specialist.propose`, the PM's proposal reaching the approval gate from a
chat turn, `packages/runtime/test/specialist-propose-tool.test.ts`).
