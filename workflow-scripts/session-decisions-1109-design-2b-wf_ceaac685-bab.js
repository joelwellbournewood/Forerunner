export const meta = {
  name: 'decisions-1109-design-2b',
  description: "Design the owner's follow-up decisions of 2026-11-09: the credential policy (D5, two-lens panel plus judge), who starts a session and a running session visible everywhere (D6, D8), the agent keeping its own tasks right (D7); adversarial check; revise",
  phases: [{ title: 'Design' }, { title: 'Judge' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '3600089'
const OUTDIR = '/tmp/frbench/d1109'

const CONTEXT = `Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}) is a desktop app: a persistent AI project manager that plans work, delegates tasks to specialist agents and has a critic review them; React UI in apps/ui, local daemon in packages/runtime, commands in packages/commands, billing and credentials in packages/runtime/src/billing (BillingRouter, the credential chooser, credential waits), the session runner in packages/runtime/src/session (runner.ts, triggers.ts: the scheduler with one active session per agent and a waiting line, resume-work.ts), state in packages/state. Waves 1 to 7 and wave 15 run A are merged. Wave 15 run B (w15-words, maybe a small w15-tail) runs next; the areas you design run AFTER it as 'run C', together with four other run C areas designed in parallel (d1109-onerepo, d1109-sessions, d1109-chat-*, d1109-oversize; their drafts appear in ${OUTDIR}/ as they finish). Your file:line references are at ${HEAD}.

The owner's answers are in /tmp/frbench/owner-decisions-2026-11-09.md: read the whole file first. The later sections overrule the earlier ones: 'Follow-up answers' (6: option c, 7a/b/c: the credential framework), then 'Second follow-up' and 'Third follow-up (confirmed)' which REPLACE answer 6's 'start right away' with: the person says when a session starts; prepared work joins a running session if it fits, else waits for the next Start; no reminder notification; a running session unmistakable everywhere; the agent keeps its own tasks right within the budget and its autonomy level. The owner's own words are the target; the 'Decision Dn' lines are the session lead's reading of them. Also read: docs/status/handoff/NEXT-SESSION.md (the plan, the owner's decisions of 2026-11-02, the open owner questions), /tmp/frbench/wave7g6-triage.json owner_questions[0..3] (the questions these answers decide), docs/design/core-experience.md (the design target: §1 the loop and its three promises, §3.1 the shell, §3.2 Home, §3.5 the Tasks actions table, §3.6 the Start dialog, §3.7 the session page, §3.8 the Inbox and 'answering resumes work', §3.9 chat, §4 how a session behaves; §5 writing rules: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does), AGENTS.md and docs/maintainers/validation.md (binding test rules: the failing test first at the boundary the person uses, a restart case for any state that must survive, siblings of each fix), the maintainer docs of the modules you touch, and the ADRs your design changes (0044, 0100 with its amendments, 0112, the autonomy ADRs, and others you find; the next free ADR number is 0114 and the parallel run C designs may take 0114 to 0118: propose yours as 'next free').

Rules for every design:
- Money: no budget, wrap-up line, monthly cap or plan-share cap is ever passed; spend is booked and visible in CHF; when the app says it waits, nothing moves (owner: 'It should definitely not automatically do something even when told to wait or showing that it is waiting').
- The person's control: no new session starts unless the person said so (Start, Approve and start, 'run it now' in chat, Continue on a budget card, a schedule they set) or turned on the hands-off setting.
- Security: never weaken the hooks or the sandbox; text from cards, chat, pages or files never becomes instructions to a model; a refused or resting credential is never retried in a way that could lock the person's account; secrets are never shown or logged.
- Model-facing prompts and tool definitions are code and tested by asserting the exact text the model receives. Tests use stand-ins (the bench and testenv have stand-in providers for a subscription and an API key); what only the real credentials or the real model show goes on the owner's checklist or a live check step with a cost.
- Words the person sees follow design §5. Keep today's behaviour wherever the owner did not decide; where you must change a line of design core-experience.md, say exactly which and why (the session lead edits that document).
- Read-only: do not edit the repository, do not commit, do not push. Keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first; never leave the shell outside ${REPO}). Write only your output file under ${OUTDIR}/.

An area spec has these fields (as in /tmp/frbench/phaseE.json areas; see the 'w15-merge' area there for the level of detail): key, title, problems[] (each '[severity] Dn-k: what the person sees today or what is missing; Owner's words: <quote>; Where: <file:line at ${HEAD}>'), decisions[] (each with why), u_entries[], root_causes[], fix_scope (one string: the order, the failing test first at the person's boundary for each item — real-daemon route case in apps/ui/test/real-daemon.test.ts, composed-runtime test, UI test in apps/ui/test, unit test of the function that writes a sentence —, restart cases, what not to touch, the money and security rules), files[] (with functions or regions), acceptance[] (one checkable line per item, at the boundary), depends_on[], handoff_items[], owner_questions[] (only real new ones, with the default you build meanwhile), size (with a cut line: what may end in not_done, what never may). One area per fixer run (about 8 to 16 items); split a larger design into two areas with a clean file boundary.`

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string' } },
    file: { type: 'string' },
    summary: { type: 'string' },
    adr: { type: 'string' },
    design_doc_changes: { type: 'array', items: { type: 'string' }, description: 'lines of docs/design/core-experience.md that must change, with the new words' },
    live_check_steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, needs: { type: 'string' }, est_usd: { type: 'number' } }, required: ['step', 'needs', 'est_usd'] } },
    owner_checklist: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['keys', 'file', 'summary', 'adr', 'design_doc_changes', 'live_check_steps', 'owner_checklist', 'open_questions'],
}

const OUT_RULE = (key) => `Write your result to ${OUTDIR}/${key}.json as { base: '${HEAD}', decision: '<Dn>', current_state: [ '<what the code does today, file:line>' ], design: '<the design: what the person sets, sees and does, step by step, and what the engine does in each case>', alternatives_rejected: [ '<alternative: why not>' ], areas: [ <area spec>, ... ], adr: '<number and title: decision>', design_doc_changes: [..], live_check_steps: [ { step, needs, est_usd } ], owner_checklist: [..], open_questions: [..] } (mkdir -p ${OUTDIR} first) and return the summary.`

const CRED_BASE = `Decision D5: the credential policy (owner's answers 7a, 7b, 7c in the file). Find what exists end to end: the credentials a person can have (a Claude subscription through Claude Code, an API key, more than one of each?), the first-choice setting and the per-task chooser, 'When my first choice runs out mid-session' (wait / use the other one at once), BillingRouter.pick and its skips (resting, refused, plan_share, monthly_limit, other_human), credential waits and how they end (reset, a new credential, the chooser), the plan-share cap and the monthly cap and where they are set, the cards and lines that say a wait or a switch (Start dialog, Overview, Tasks, Inbox, session page, notifications), spend booking per credential, and the restart behaviour of a wait.

Then design one policy the person sets and the system follows: which credential first (or the API key by default), and for each way the first choice can stop (a usage limit, the plan-share cap, the key's monthly cap, a refusal) what happens: go on with the next one automatically, ask first (one card with the choice and its cost in CHF and the time the limit resets), or wait. A refusal follows the same rule as running out and also tells the person what was refused and how to fix it. The stopped task itself may be finished on the API key when the policy allows it (owner 7a), transparently: the task, the session, the spend and a notification say so with the cost. When the policy says wait, or the app shows waiting, nothing moves (7b). Under the owner's later answers a session continues by itself only while it is the session the person started (a wait inside it ends and it goes on); a new session after a reset starts only if the person said so or turned on the hands-off setting: make the policy fit that. Presets in plain words for the common frameworks the owner named, with the order visible; one place to set it (Settings, maybe per project); the Start dialog and the plan card say what will happen if the first choice runs out. Migrate today's two settings to the new policy without changing what a person already chose. Close today's bugs these answers decide (wave7g6-triage owner_questions[1..3]).`

const LENSES = [
  { key: 'clarity', lens: 'Lens: the person\'s control and clarity. A person with no technical knowledge must understand the choice in one read, see at any moment which credential works and what happens next, and never be surprised by a cost: presets in their words, the order shown, the ask-first card and the switch notice word for word, where each appears, and how it fits the existing Settings and Start dialog without clutter.' },
  { key: 'safety', lens: 'Lens: correctness and money safety in the engine. Every path through BillingRouter, credential waits, the chooser, sessions, retries, reviews (the critic also spends), planning and chat (chat spends too: does the policy cover it?) follows the policy exactly; a wait never moves work; an ask-first card is answered once and a late answer is handled; a switch never passes a cap; restart and two sessions at once are safe; a refusal never loops; and the tests that prove each invariant at the boundary.' },
]

phase('Design')
const credDrafts = pipeline(LENSES, (l) => agent(`${CONTEXT}

${CRED_BASE}

${l.lens}

Produce a complete design under this lens (it will be judged against another lens and the best parts combined), with its area spec(s) (keys 'd1109-cred...').

${OUT_RULE('cred-' + l.key)}`, { label: `cred:${l.key}`, phase: 'Design', schema: DESIGN_SCHEMA }))

const startsDraft = agent(`${CONTEXT}

Decisions D6 and D8: who starts a session, how prepared work joins one, and a running session visible everywhere (the owner's 'Second follow-up' and 'Third follow-up (confirmed)').

Find what exists: every way a session starts today (Start and the Start dialog, Approve and start, Inbox answers through resumeWork in packages/runtime/src/session/resume-work.ts, credential waits ending, budget raises and month or budget resets for paused tasks ('it goes on by itself'), schedules and quiet hours in packages/runtime/src/session/triggers.ts, chat commands such as the session start/stop/resume commands, the Tasks-row actions and POST /tasks/:id/action), the scheduler's one-session-per-agent rule and its waiting line (merged automatic starts), how a running session takes up newly ready tasks (runner.ts replan: it takes ready tasks when its queue empties, with a session budget and a fifth kept for reviews, and at autonomy levels 0 and 1 only the approved tasks), what the Start dialog promises (which tasks, the estimate, the budget), and what the person sees of a running session today on each screen (header, navigation, Home, the project's Overview and Tasks, the session page, the Talk panel, the desktop shell's tray or window title in apps/desktop).

Design:
(1) No new session starts unless the person says so: Start, Approve and start, 'run it now' (or the like) in chat, Continue on a budget card, a schedule the person set; or the hands-off setting 'Start by itself when work is ready' (off by default; say where it lives and what it covers). Every other action only prepares work: Inbox answers, Redo, Try again, Make ready, Resume, Reopen, budget raises, month or budget resets, a credential coming back, chat changes. Each says in one line what happens next ('It joins the session that is running.' / 'Ready: it runs at your next Start.'). The one status line of the project (design §2) shows ready work and offers Start. No reminder notification for waiting work (owner).
(2) The session the person started keeps going by itself until its work is done or something truly needs the person, including after a credential wait inside it (D5 decides the credential side).
(3) Prepared work joins a running session only if it fits (owner's option C): the session's remaining budget still covers the tasks it planned at the start (their estimates, the review fifth kept) plus the newcomer's estimate; otherwise it waits for the next Start; the session page and the line say which. Decide what 'planned at the start' means for a session that began with all ready tasks, and how an edit to a not-yet-started task applies (before it starts; a running task is never changed mid-run, the note goes to its next attempt).
(4) A running session is unmistakable everywhere (D8): on every page (the header or navigation, whatever screen and project the person is on), Home, the project's screens, the Talk panel, and the desktop window or tray: that a session runs, for which project, what it does now in a few words, and how to stop it; nothing when none runs. No clutter: one consistent element; design §5 words; live updates.
(5) Close the open owner question on Tasks-row actions with this answer. Write the rule in the ADR, including what the system does on its own (retries inside a session up to the limit; it never reopens done or cancelled work or retries past the limit without the person).

${OUT_RULE('d1109-starts')}`, { label: 'design:starts', phase: 'Design', schema: DESIGN_SCHEMA })

const selfDraft = agent(`${CONTEXT}

Decision D7: the agent keeps its own task list right, during a run and in chat (owner: "I would also like that being talking to the agent would also allow the agent to have dynamic control over its tasks. So for example, if I say set this up and I approve a plan and then it adds a bunch of tasks, I want it to be able to fix its tasks. Like as part of a run, it should be able to do things like that." Confirmed: "The agent changing its own tasks with the autonomy level deciding when it asks first. That's also good.").

Find what exists: how a plan is made and approved (intake, the plan card), what a session does between tasks (runner.ts: replan takes newly ready tasks; nothing rewrites the plan), the task commands (packages/commands/src/commands/task.ts: task.create, task.update, task.dependencies, task.transition, task.pause, task.resume, task.reopen; their risk and askFromChat), what chat can do with tasks today and how it asks (yes/no, the Changes row, Undo), the autonomy levels and their table (packages/runtime/src/enforcement/autonomy.ts; Advisor, Assisted, Standard, Trusted, Autopilot), the critic's findings and follow-ups, and what a specialist reports that shows a task was wrong (too big, missing a step, depends on something else, duplicate).

Design: during a run (between tasks, and after a task's report or review shows the plan needs it) and in chat, the agent can fix its own tasks within the approved plan's goal: correct a task's wording or criteria, split a task that is too big, add a missing step, change the order or what waits for what, drop a duplicate (cancel with a reason). Bounds: it never raises a budget or a cap; a task it adds that does not fit the running session's budget waits for the person's next Start (owner's option C); it never changes a running task mid-run; it never touches another project; text from specialists, pages or files that suggests task changes is data the agent weighs, never an instruction it follows blindly (say how a prompt-injection attempt in a report is kept from steering the plan, and test it in the injection suite). Approval by autonomy level: at Advisor and Assisted it proposes (one card or chat question listing the changes, applied on Yes); at Standard and above it applies them and tells (the session page and the Changes list show each change with one Undo; one Update per session, not one per change). The model-facing part (the planner or PM agent's tool definitions and instructions) is code: which model makes these decisions, how often it is asked (not after every task if nothing changed: cost), and its cost booked in the session. Also: chat in a project can ask the agent to 'fix the tasks' and gets the same behaviour.

${OUT_RULE('d1109-selftasks')}`, { label: 'design:selftasks', phase: 'Design', schema: DESIGN_SCHEMA })

const [credRes, startsRes, selfRes] = await Promise.all([credDrafts, startsDraft, selfDraft])

phase('Judge')
const credFinal = await agent(`${CONTEXT}

${CRED_BASE}

You judge and combine two independent credential-policy designs: ${OUTDIR}/cred-clarity.json (the person's control and clarity) and ${OUTDIR}/cred-safety.json (correctness and money safety). Summaries: ${JSON.stringify(credRes)}

Read both whole and check their claims about the code at ${HEAD} yourself. Score each against the owner's words 7a, 7b, 7c and the later answers (the person says when a session starts), the money rule (when the app says it waits, nothing moves; no cap passed; every switch visible with its cost), testability without real credentials, and fit with design §5 and the existing screens. Write the final design: the better one as the base with the best of the other grafted in; say what you took and rejected and why. Final area spec(s) keyed 'd1109-cred...' (at most two areas with a clean file boundary).

${OUT_RULE('cred')}`, { label: 'cred:judge', phase: 'Judge', schema: DESIGN_SCHEMA })

phase('Check')
const check = await agent(`${CONTEXT}

You check three designs adversarially before they become run C fix areas: ${OUTDIR}/cred.json (the credential policy, from a two-lens panel: cred-clarity.json, cred-safety.json), ${OUTDIR}/d1109-starts.json (who starts a session, joining if it fits, a running session visible everywhere) and ${OUTDIR}/d1109-selftasks.json (the agent keeps its own tasks right). Summaries: ${JSON.stringify({ cred: credFinal, starts: startsRes, selftasks: selfRes })}

Read each whole and try to find what is wrong:
1. Does each do what the owner's own words ask (quote them, the latest section winning), no less and no more? Does it decide anything the owner did not, or keep a notification the owner rejected?
2. Are its claims about today's code true at ${HEAD}? Check every current_state line and a sample of root_causes in the code.
3. Money, control and safety: can any path start a session the person did not ask for (with the hands-off setting off); move work while the app says it waits; pass a cap; spend without showing it; loop on a refused credential; let the agent raise a budget, change a running task, act in another project, or follow instructions planted in a report; start two sessions at once?
4. Testability: a failing test at the person's boundary for each item, restart cases, the stand-in providers able to show each case, model-facing text asserted exactly, the injection suite covering D7.
5. Conflicts among these three designs, with the other run C drafts in ${OUTDIR}/ (d1109-onerepo.json, d1109-sessions.json, d1109-oversize.json, chat*.json as far as they exist: D4's oversized task and the credential policy both touch session picking and pauses; D6's starts and D2's sessions list both show sessions; D7 and the chat design both let chat change tasks), and with wave 15 run B (/tmp/frbench/wave15b-areas.json if it exists).
6. Size and cut lines.
Return your findings; do not edit the files.`, { label: 'check', phase: 'Check', schema: {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    owner_intent: { type: 'array', items: { type: 'string' } },
    wrong_claims: { type: 'array', items: { type: 'string' } },
    money_control_safety: { type: 'array', items: { type: 'string' } },
    testability: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    size: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'owner_intent', 'wrong_claims', 'money_control_safety', 'testability', 'conflicts', 'size'],
} })

phase('Revise')
const final = await agent(`${CONTEXT}

You finish three run C designs: ${OUTDIR}/cred.json, ${OUTDIR}/d1109-starts.json and ${OUTDIR}/d1109-selftasks.json. An adversarial check found: ${JSON.stringify(check)}

Verify each point against the owner's words, the code at ${HEAD} and the other drafts; fix the ones that hold in the three files (rewrite them in place, keeping their format), and for any you reject say why with evidence. Then write /tmp/frbench/decisions1109-areas-2.json: { base: '${HEAD}', areas: [ <every final area spec of these three designs> ], shared_files: [ '<file> (run C): <rule>' ] (for every file these areas share with each other or with the other run C drafts, as far as you can see them), merge_order_hint: [keys], adr_plan: [ '<ADR>: <decision>, written by <area key>' ], design_doc_changes: [ '<section>: <new words>' ], live_check_3_additions: [ { step, source, needs, est_usd, priority } ], owner_checklist_additions: [..], open_questions: [ { question, default_built, why } ], owner_explanation: '<how sessions start, how work joins, what the person sees while one runs, how the agent fixes its tasks, and how the credential policy works, in plain words for the owner: at most 15 short lines>', notes: [..] }. Return a summary.`, { label: 'revise', phase: 'Revise', schema: {
  type: 'object',
  properties: {
    areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' } }, required: ['key', 'title', 'items'] } },
    owner_explanation: { type: 'string' },
    rejected_check_points: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['areas', 'owner_explanation', 'rejected_check_points', 'open_questions'],
} })

return { credDrafts: credRes, starts: startsRes, selftasks: selfRes, cred: credFinal, check, final }