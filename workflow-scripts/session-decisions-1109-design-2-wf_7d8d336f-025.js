export const meta = {
  name: 'decisions-1109-design-2',
  description: "Design the owner's follow-up decisions of 2026-11-09: the credential policy (D5, two-lens panel plus judge) and actions that start work (D6); adversarial check; revise",
  phases: [{ title: 'Design' }, { title: 'Judge' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '3600089'
const OUTDIR = '/tmp/frbench/d1109'

const CONTEXT = `Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}) is a desktop app: a persistent AI project manager that plans work, delegates tasks to specialist agents and has a critic review them; React UI in apps/ui, local daemon in packages/runtime, commands in packages/commands, billing and credentials in packages/runtime/src/billing (BillingRouter, the credential chooser, credential waits), state in packages/state. Waves 1 to 7 and wave 15 run A are merged. Wave 15 run B (w15-words, maybe a small w15-tail) runs next; the areas you design run AFTER it as 'run C', together with four other run C areas being designed in parallel (d1109-onerepo, d1109-sessions, d1109-chat-*, d1109-oversize; their drafts appear in ${OUTDIR}/ as they finish). Your file:line references are at ${HEAD}.

The owner's answers are in /tmp/frbench/owner-decisions-2026-11-09.md: read the whole file first, especially 'Follow-up answers' 6 and 7; the owner's own words are the target, the 'Decision Dn' lines are the session lead's reading of them. Also read: docs/status/handoff/NEXT-SESSION.md (the plan, the owner's decisions of 2026-11-02 on credentials, budgets and merging, the open owner questions), /tmp/frbench/wave7g6-triage.json owner_questions[0..3] (the questions these answers decide), docs/design/core-experience.md (the design target: §1 'Work keeps going by itself ... Pressing Start once per task is a bug', §3.5 the Tasks actions table, §3.8 the Inbox and 'answering resumes work', §4 how a session behaves; §5 writing rules: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does), AGENTS.md and docs/maintainers/validation.md (binding test rules: the failing test first at the boundary the person uses, a restart case for any state that must survive, siblings of each fix), the maintainer docs of the modules you touch, and the ADRs your design changes (0044, 0100 with its amendments, 0112, and others you find; the next free ADR number is 0114, and the parallel run C designs may take 0114 to 0118: propose yours as 'next free').

Rules for every design:
- Money: no budget, wrap-up line, monthly cap or plan-share cap is ever passed; spend is booked and visible in CHF; when the app says it waits, nothing moves (owner: 'It should definitely not automatically do something even when told to wait or showing that it is waiting').
- Security: never weaken the hooks or the sandbox; a refused or resting credential is never retried in a way that could lock the person's account; secrets are never shown or logged.
- Model-facing prompts are code and tested by asserting the exact text the model receives. Tests use stand-ins (the bench and testenv have stand-in providers for a subscription and an API key); what only the real credentials show goes on the owner's checklist or a live check step with a cost.
- Words the person sees follow design §5. Keep today's behaviour wherever the owner did not decide.
- Read-only: do not edit the repository, do not commit, do not push. Keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first; never leave the shell outside ${REPO}). Write only your output file under ${OUTDIR}/.

An area spec has these fields (as in /tmp/frbench/phaseE.json areas; see the 'w15-merge' area there for the level of detail): key, title, problems[] (each '[severity] Dn-k: what the person sees today or what is missing; Owner's words: <quote>; Where: <file:line at ${HEAD}>'), decisions[] (each with why), u_entries[], root_causes[], fix_scope (one string: the order, the failing test first at the person's boundary for each item — real-daemon route case in apps/ui/test/real-daemon.test.ts, composed-runtime test, UI test in apps/ui/test, unit test of the function that writes a sentence —, restart cases, what not to touch, the money and security rules), files[] (with functions or regions), acceptance[] (one checkable line per item, at the boundary), depends_on[], handoff_items[], owner_questions[] (only real new ones, with the default you build meanwhile), size (with a cut line: what may end in not_done, what never may). One area per fixer run (about 8 to 16 items); split a larger design into two areas with a clean file boundary.`

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string' } },
    file: { type: 'string' },
    summary: { type: 'string' },
    adr: { type: 'string' },
    live_check_steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, needs: { type: 'string' }, est_usd: { type: 'number' } }, required: ['step', 'needs', 'est_usd'] } },
    owner_checklist: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['keys', 'file', 'summary', 'adr', 'live_check_steps', 'owner_checklist', 'open_questions'],
}

const OUT_RULE = (key) => `Write your result to ${OUTDIR}/${key}.json as { base: '${HEAD}', decision: '<Dn>', current_state: [ '<what the code does today, file:line>' ], design: '<the design: what the person sets, sees and does, step by step, and what the engine does in each case>', alternatives_rejected: [ '<alternative: why not>' ], areas: [ <area spec>, ... ], adr: '<number and title: decision>', live_check_steps: [ { step, needs, est_usd } ], owner_checklist: [..], open_questions: [..] } (mkdir -p ${OUTDIR} first) and return the summary.`

const CRED_BASE = `Decision D5: the credential policy (owner's answers 7a, 7b, 7c in the file). Find what exists end to end: the credentials a person can have (a Claude subscription through Claude Code, an API key, more than one of each?), the first-choice setting and the per-task chooser, 'When my first choice runs out mid-session' (wait / use the other one at once), BillingRouter.pick and its skips (resting, refused, plan_share, monthly_limit, other_human), credential waits and how they end (reset, a new credential, the chooser), the plan-share cap and the monthly cap and where they are set, the cards and lines that say a wait or a switch (Start dialog, Overview, Tasks, Inbox, session page, notifications), spend booking per credential, and the restart behaviour of a wait.

Then design one policy the person sets and the system follows: which credential first (or the API key by default), and for each way the first choice can stop (a usage limit, the plan-share cap, the key's monthly cap, a refusal) what happens: go on with the next one automatically, ask first (one card with the choice and its cost in CHF and the time the limit resets), or wait. A refusal follows the same rule as running out and also tells the person what was refused and how to fix it. The stopped task itself may be finished on the API key when the policy allows it (owner 7a), transparently: the task, the session, the spend and a notification say so with the cost. When the policy says wait, or the app shows waiting, nothing moves (7b). Presets in plain words for the common frameworks the owner named, with the order visible; one place to set it (Settings, maybe per project); the Start dialog and the plan card say what will happen if the first choice runs out. Migrate today's two settings to the new policy without changing what a person already chose. Close today's bugs these answers decide (wave7g6-triage owner_questions[1..3]).`

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

Decision D6: actions that start work (owner's answer 6: option c, with questions: "will tasks start their own runs in general? Are you saying a task will have its own run when it is reopened? Can the system update and reopen and its own tasks if I dont manually do it? E.g. if I say, since it didnt run last time re-open it? Let me know how this should all fit together."). The session lead's proposal is in the file under 'Decision D6'.

Find what exists: every way work starts today (Start and the Start dialog, Approve and start, Inbox answers through resumeWork in packages/runtime/src/session/resume-work.ts, credential waits ending, budget raises and resets for paused tasks, schedules in packages/runtime/src/session/triggers.ts, chat commands), the Tasks-row actions and their routes (POST /tasks/:id/action in the daemon's server, packages/commands/src/commands/task.ts: task.reopen, task.transition, task.resume, task.pause; which have askFromChat), how a session picks up tasks made ready while it runs (design §4.2), the retry ladder inside a session, and what the person sees after each action (the Done line, the row, the Undo).

Design one rule, the same from every place (Tasks row, task drawer, Inbox, chat): actions that ask for the work now (Redo, Try again, and Resume of a task the person paused: decide with reasons whether Resume belongs here) start work exactly as an Inbox answer does (the task joins the running session, or a session of the project starts and runs everything ready, or it is queued; budgets, credential policy and the Start dialog's warnings still apply: say how the person sees the estimate and the budget when no dialog opens); actions that only bring a task back (Reopen of a cancelled task, Make ready of a draft) start nothing and say the next session takes it; the explanation lines of design §3.5 change to say what happens; the Undo right after a start-now action also stops what it started when nothing ran yet. Chat can do these when asked in words ('it did not run last time, try it again'), with its yes/no first. What the system does on its own stays as built (retries inside a session up to the limit; paused and waiting work continues when its limit or credential returns; it never reopens done or cancelled work, or retries past the limit, without the person): state it in the ADR so the rule is written down. Keep the open owner question on this closed by this answer.

${OUT_RULE('d1109-starts')}`, { label: 'design:starts', phase: 'Design', schema: DESIGN_SCHEMA })

const [credRes, startsRes] = await Promise.all([credDrafts, startsDraft])

phase('Judge')
const credFinal = await agent(`${CONTEXT}

${CRED_BASE}

You judge and combine two independent credential-policy designs: ${OUTDIR}/cred-clarity.json (the person's control and clarity) and ${OUTDIR}/cred-safety.json (correctness and money safety). Summaries: ${JSON.stringify(credRes)}

Read both whole and check their claims about the code at ${HEAD} yourself. Score each against the owner's words 7a, 7b, 7c, the money rule (when the app says it waits, nothing moves; no cap passed; every switch visible with its cost), testability without real credentials, and fit with design §5 and the existing screens. Write the final design: the better one as the base with the best of the other grafted in; say what you took and rejected and why. Final area spec(s) keyed 'd1109-cred...' (at most two areas with a clean file boundary).

${OUT_RULE('cred')}`, { label: 'cred:judge', phase: 'Judge', schema: DESIGN_SCHEMA })

phase('Check')
const check = await agent(`${CONTEXT}

You check two designs adversarially before they become run C fix areas: ${OUTDIR}/cred.json (the credential policy, from a two-lens panel: cred-clarity.json, cred-safety.json) and ${OUTDIR}/d1109-starts.json (actions that start work). Summaries: ${JSON.stringify({ cred: credFinal, starts: startsRes })}

Read each whole and try to find what is wrong:
1. Does each do what the owner's own words ask (quote them), no less and no more? Does it decide anything the owner did not?
2. Are its claims about today's code true at ${HEAD}? Check every current_state line and a sample of root_causes in the code.
3. Money and safety: can any path move work while the app says it waits; pass a cap; spend without showing it; loop on a refused credential; start work the person did not ask for; start two sessions at once?
4. Testability: a failing test at the person's boundary for each item, restart cases, the stand-in providers able to show each case.
5. Conflicts between these two designs, and with the other run C drafts in ${OUTDIR}/ (d1109-onerepo.json, d1109-sessions.json, d1109-oversize.json, chat*.json as far as they exist: D4's oversized task and the credential policy both touch session picking and pauses; D6's start-now and D2's sessions list both touch session starts), and with wave 15 run B (/tmp/frbench/wave15b-areas.json if it exists).
6. Size and cut lines.
Return your findings; do not edit the files.`, { label: 'check', phase: 'Check', schema: {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    owner_intent: { type: 'array', items: { type: 'string' } },
    wrong_claims: { type: 'array', items: { type: 'string' } },
    money_safety: { type: 'array', items: { type: 'string' } },
    testability: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    size: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'owner_intent', 'wrong_claims', 'money_safety', 'testability', 'conflicts', 'size'],
} })

phase('Revise')
const final = await agent(`${CONTEXT}

You finish two run C designs: ${OUTDIR}/cred.json and ${OUTDIR}/d1109-starts.json. An adversarial check found: ${JSON.stringify(check)}

Verify each point against the owner's words, the code at ${HEAD} and the other drafts; fix the ones that hold in the two files (rewrite them in place, keeping their format), and for any you reject say why with evidence. Then write /tmp/frbench/decisions1109-areas-2.json: { base: '${HEAD}', areas: [ <every final area spec of these two designs> ], shared_files: [ '<file> (run C): <rule>' ] (for every file these areas share with each other or with the other run C drafts, as far as you can see them), merge_order_hint: [keys], adr_plan: [ '<ADR>: <decision>, written by <area key>' ], live_check_3_additions: [ { step, source, needs, est_usd, priority } ], owner_checklist_additions: [..], open_questions: [ { question, default_built, why } ], owner_explanation: '<how actions, sessions and the system's own retries fit together, and how the credential policy works, in plain words for the owner: at most 15 short lines>', notes: [..] }. Return a summary.`, { label: 'revise', phase: 'Revise', schema: {
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

return { credDrafts: credRes, starts: startsRes, cred: credFinal, check, final }