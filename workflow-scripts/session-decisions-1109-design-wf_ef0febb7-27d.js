export const meta = {
  name: 'decisions-1109-design',
  description: "Design the owner's decisions of 2026-11-09 (one project per repository, a sessions list, chat recall and escalation, oversized tasks) into fix-area specs; chat by judge panel; adversarial check; revise",
  phases: [{ title: 'Design' }, { title: 'Chat panel' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '3600089'
const OUTDIR = '/tmp/frbench/d1109'

const CONTEXT = `Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}) is a desktop app: a persistent AI project manager that plans work, delegates tasks to specialist agents and has a critic review them; React UI in apps/ui, local daemon in packages/runtime, commands in packages/commands, capabilities (GitHub, web, git) in packages/capabilities, state in packages/state. Waves 1 to 7 and wave 15 run A are merged. Wave 15 run B (w15-words, maybe a small w15-tail) runs next; the areas you design run AFTER it as 'run C', on its merged head, so your file:line references are at ${HEAD} and may move a little. Wave 8 (collaboration between two people, the status issue, the repository guide) comes after run C: its spec is /tmp/frbench/collab/collab-areas.json (16 areas) with /tmp/frbench/collab/owner-summary.md.

The owner's answers of 2026-11-09 are in /tmp/frbench/owner-decisions-2026-11-09.md: read the whole file first; the owner's own words are the target, the 'Decision Dn' lines are the session lead's reading of them. Also read: docs/status/handoff/NEXT-SESSION.md (the plan, the owner's earlier decisions, the open owner questions), docs/design/core-experience.md (the design target; §5 writing rules: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does), AGENTS.md and docs/maintainers/validation.md (binding test rules: the failing test first at the boundary the person uses, a restart case for any state that must survive, siblings of each fix), the maintainer docs of the modules you touch (docs/maintainers/*.md), and the ADRs your design changes (docs/decisions/; the next free ADR number is 0114).

Rules for every design:
- Security: never weaken the hooks or the sandbox; text from pages, searches, files, cards, chat history or any record never becomes instructions to a model (it is quoted as data); nothing reaches this PC's or the home network's private addresses through the page reader.
- Money: no budget, wrap-up line, monthly cap or plan-share cap is ever passed; spend is booked and visible in CHF.
- Model-facing prompts and tool definitions are code: they are changed in the repository (evals/registry/...) and tested by asserting the exact text the model receives. Tests use stand-ins; behaviour that only the real model can show gets a live check step (with an estimated cost in USD) instead.
- Words the person sees follow design §5. Keep today's behaviour wherever the owner did not decide.
- Read-only: do not edit the repository, do not commit, do not push. Keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first; never leave the shell outside ${REPO}). Write only your output file under ${OUTDIR}/.

An area spec has these fields (as in /tmp/frbench/phaseE.json areas; look at the 'w15-merge' area there for the level of detail): key, title, problems[] (each '[severity] Dn-k: what the person sees today or what is missing; Owner's words: <quote>; Where: <file:line at ${HEAD}>'), decisions[] (the design choices, each with why), u_entries[] (the UPDATE-LOG/user-guide entries it changes or adds), root_causes[] (file:line at ${HEAD}), fix_scope (one string: the order of work, the failing test first at the person's boundary for each item — name the boundary: real-daemon route case in apps/ui/test/real-daemon.test.ts, composed-runtime test, UI test in apps/ui/test, unit test of the function that writes a sentence —, restart cases, what not to touch, the security and money rules), files[] (with the functions or regions changed), acceptance[] (one checkable line per item, at the boundary), depends_on[], handoff_items[], owner_questions[] (only real new ones; the default you build meanwhile), size (with a cut line: what may end in not_done, what never may). One area should be doable by one fixer in one long run (about 8 to 16 items); split a larger design into two areas with a clean file boundary.`

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string' }, description: 'area keys written' },
    file: { type: 'string' },
    summary: { type: 'string', description: 'the design in a few sentences: what the person will see and do' },
    wave8_amendments: { type: 'array', items: { type: 'string' }, description: 'changes this design needs in the wave 8 spec (area key: change), or parts deliberately left to wave 8' },
    adr: { type: 'string', description: 'the ADR to write or amend (number, title) and its decision in two sentences' },
    live_check_steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, needs: { type: 'string' }, est_usd: { type: 'number' } }, required: ['step', 'needs', 'est_usd'] } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['keys', 'file', 'summary', 'wave8_amendments', 'adr', 'live_check_steps', 'open_questions'],
}

const OUT_RULE = (key) => `Write your result to ${OUTDIR}/${key}.json as { base: '${HEAD}', decision: '<Dn>', current_state: [ '<what the code does today, file:line>' ], design: '<the design, what the person sees and does, step by step>', alternatives_rejected: [ '<alternative: why not>' ], areas: [ <area spec>, ... ], wave8_amendments: [..], adr: '<number and title: decision>', live_check_steps: [ { step, needs, est_usd } ], open_questions: [..] } (mkdir -p ${OUTDIR} first) and return the summary.`

const SIMPLE = [
  {
    key: 'd1109-onerepo',
    prompt: `Decision D1: one repository belongs to one project ("There should not be 2 projects in one repo. If there are multiple people and agents, and even if they are working on different parts of a bigger project, they should be working on one project. Make it such that multiple projects are not done on one repo, in an intelligent way.").

Find every way a project gets a repository or a folder today: the setup assistant, New project (with a repository, with a folder, making a repository via the repo.create card), linking one in Settings or the Overview, chat's project.create and settings commands, the import path, and how a repository is identified (URL forms: https/ssh, .git suffix, case; a local folder's git root; a renamed or moved repository on GitHub). Find what wave 15's W15-01 built (the hidden ownership marker in the status and scaffold pull request bodies, soleLinkedProject, the legacy rule in packages/runtime/src/loop/docs.ts and the daemon's docs rows) and what wave 8 plans (collab-identity, collab-members, collab-shared-repo, status-issue-*, repo-guide: AGENTS.md in every repository).

Design the 'intelligent' rule end to end: (1) on this computer, linking a repository or folder another project already uses never makes a second project: the person is offered that project (open it; or, for a new idea, add it to that project as work) in one plain sentence, from every entry point, chat included; (2) a repository that another install's project already uses (another person's) is recognised from the repository itself (decide what Forerunner writes there and reads: the marker, a line in the repository guide, the status issue of wave 8 — prefer what wave 8 builds anyway, and say what run C builds now and what wave 8 takes over), and the person is offered to ask to be added to that project (wave 8's sharing) rather than starting a parallel one; (3) projects that already share a repository on this computer (made before the rule) get one safe way to become one, without losing tasks, history, budgets or open pull requests, and without guessing; until the person chooses, nothing writes into the other's pull requests (W15-01's safety part stays); (4) a 'bigger project with parts' is one project whose tasks or areas are grouped, not several projects: say whether anything is needed for that now (keep it minimal). Simplify W15-01's legacy rule where the new rule makes it moot, without weakening its fail-closed guarantee.`,
  },
  {
    key: 'd1109-sessions',
    prompt: `Decision D2: every project has a list of its sessions (owner: "Yes" to 'should a project have a list of its sessions?').

Find what exists: the session record and its page (routes and UI), the session result and its sentences, lastSession on the Overview, recovery after a crash, sessions that ended at a budget or credential wait, chat-only and planning sessions, the session log, the Activity or Changes screens, and design core-experience.md's navigation (where a list of a project's past work belongs; a 'Sessions' tab does not exist today). Design the list: where it lives (fit the design's navigation, do not add clutter), what one row says (when, how long, what it did in one sentence, tasks done/paused/failed, spent in CHF on which credential, how it ended), ordering, paging for a long history, what opens on a click (the session's page, with its tasks and log), the running session at the top with live progress, the empty state, and the daemon route(s) with a restart case. Keep the money figures the same as the session page and the Overview (one figure per session).`,
  },
  {
    key: 'd1109-oversize',
    prompt: `Decision D4: a task whose estimate alone exceeds the session's work budget ("it should get a warning, but it should get done anyway. when the budget will run out, it should be the case that the agent will do as much as it can, and wrap up in an organized and error free way such that the work can be continued in the next run.").

Find what exists: the Start dialog's warning for such a task, how the session picks tasks (a task whose estimate is above what is left is skipped and gets a line in the session's result: W6-23), the budget stop as a clean pause (ADR 0112 with its amendments: the wrap-up line, the work kept as a commit on the task's branch, the handoff, one card 'Continue (CHF N more)' or 'Cancel task', the month cap and project budget cases), wave 15's W15-13 (the write room below the wrap-up line) and W15-14 (finished work reviewed instead of paused), the review-only pass (W15-27), and how a paused task continues in the next session. Also the task budget versus the session budget versus the project budget and monthly cap: which ones an oversized task can exceed by estimate, and which the run may never pass.

Design: such a task starts (the Start dialog keeps a clear warning; the plan card too), works until the wrap-up line, then wraps up 'organized and error free': the brief and the wrap-up words tell the specialist exactly what a good wrap-up is (finish the current step, leave the code building and the tests that ran passing or clearly marked, commit, write the handoff: done, left, next step, anything half-done), the kept work is checked (a wrap-up that leaves the branch broken is caught and said, not hidden), the task pauses with one card and continues from its kept work in the next run (by itself where the person's settings say so, as the budget stop does today). Guard against a task that never finishes: a task that pauses again without progress is shown to the person with a plain question instead of looping. Nothing passes a limit; the estimate and the spend stay honest. Keep the review rules (a paused task is reviewed only when its work is done).`,
  },
]

const CHAT_BASE = `Decision D3: chat ("chat should be able to intelligently/ selectively recall anything that has been recorded. Chat should also be able to use more effort or a better model, selectively and transparently, in order to be more useful, knowing that this will take more time to reply. There should be something indicating what the chat is doing when waiting. If this can be harmonized together with viewing only open cards for short answers, it makes sense. We are trying to both balance and be flexible with time and tokens spent vs quality and relevance of the reponse.").

Find what exists: the conversation agent (packages/runtime/src/conversation/agent.ts, project-facts.ts, the chat's context: tasks, last outcome, this project's open cards (W15-30), its read tools and commands), its model and effort (on the bench claude-haiku-5-5 at low effort; see packages/runtime/src/models and the settings), its prompt caching, how chat is billed and capped, how a reply reaches the UI (ChatTab, Talk, streaming or not, what the person sees while waiting), what is recorded and where (conversation history, memory/lessons, tasks and their runs, sessions and results, cards and answers, decisions, the project's documents, audit rows, the change log), and the injection defences (pnpm test:injection, evals/registry/principals/conversation-agent.md).`

const LENSES = [
  { key: 'speed', lens: 'Lens: time and tokens first. The default reply must stay fast and cheap: the smallest context that answers most questions (this project\'s open cards and state), recall only on demand through narrow tools, escalation only on a clear need with a hard cap per reply and per day, prompt caching kept intact. Show what this saves and what it risks.' },
  { key: 'quality', lens: 'Lens: quality and relevance first. Chat must find the right recorded fact even when the person names it loosely (search across every record kind with good ranking, dates, \'last week\', a task\'s old name), know when its answer is uncertain and look further or think harder, and escalate to more effort or a stronger model when the question is hard (planning advice, a failed task\'s cause, comparing options). Show how quality is tested without the real model and what the live check must prove.' },
  { key: 'transparency', lens: 'Lens: what the person sees and controls. While chat works the person sees a plain line of what it is doing ("Looking through last week\'s sessions…", "Thinking harder with a stronger model: about 20 seconds, about CHF 0.05"), the reply says when it used more effort or a stronger model and what that cost, the person can ask for a quick or a thorough answer in words or with one control, and can stop a long one. Fit design §5 and the existing chat screens; no clutter.' },
]

phase('Design')
const simple = pipeline(SIMPLE, (d) => agent(`${CONTEXT}

${d.prompt}

${OUT_RULE(d.key)}`, { label: `design:${d.key}`, phase: 'Design', schema: DESIGN_SCHEMA }))

const chatDrafts = pipeline(LENSES, (l) => agent(`${CONTEXT}

${CHAT_BASE}

${l.lens}

Produce a complete design under this lens (it will be judged against two other lenses and the best parts combined): current state, the design, how 'only open cards for short answers' and 'recall anything recorded' fit together, the escalation policy (who decides, on what signal, which model and effort, the caps, how it is billed and shown), the waiting indicator (what the daemon sends while the reply is made, how the UI shows it, stop), and the area spec(s) (keys 'd1109-chat-...', split into two areas if large: e.g. recall and context; escalation and the waiting line).

${OUT_RULE('chat-' + l.key)}`, { label: `chat:${l.key}`, phase: 'Chat panel', schema: DESIGN_SCHEMA }))

const [simpleRes, chatRes] = await Promise.all([simple, chatDrafts])

const chatFinal = await agent(`${CONTEXT}

${CHAT_BASE}

You are the judge and synthesiser of three independent chat designs, each made under a different lens: ${OUTDIR}/chat-speed.json (time and tokens first), ${OUTDIR}/chat-quality.json (quality and relevance first), ${OUTDIR}/chat-transparency.json (what the person sees and controls). Their summaries: ${JSON.stringify(chatRes)}

Read all three whole and check their claims about the current code at ${HEAD} yourself. Score each against the owner's words (recall anything recorded, selectively; more effort or a better model, selectively and transparently, knowing it takes longer; something showing what chat is doing while waiting; short answers from the open cards; balance and flexibility between time/tokens and quality/relevance), safety (recorded text is data, never instructions; injection tests), money (caps, booking, CHF), testability without the real model, and fit with the screens and design §5. Then write the final design: take the best design as the base and graft the best ideas of the others; say what you took from each and what you rejected and why. Write the final area spec(s) (keys 'd1109-chat-...', at most two areas with a clean file boundary).

${OUT_RULE('chat')}`, { label: 'chat:judge', phase: 'Chat panel', schema: DESIGN_SCHEMA })

phase('Check')
const all = { simple: simpleRes, chat: chatFinal }
const check = await agent(`${CONTEXT}

You check four designs adversarially before they become run C's fix areas: ${OUTDIR}/d1109-onerepo.json, ${OUTDIR}/d1109-sessions.json, ${OUTDIR}/d1109-oversize.json and ${OUTDIR}/chat.json (the synthesis of a three-lens panel; the lens drafts are chat-speed.json, chat-quality.json, chat-transparency.json). Summaries: ${JSON.stringify(all)}

Read each whole and try to find what is wrong:
1. Does each design do what the owner's own words ask (quote them), no less and no more? Does any answer an owner question that is still open (NEXT-SESSION.md, /tmp/frbench/wave15-triage.json owner_questions, questions 6 and 7 of the owner's file) or change behaviour the owner did not decide?
2. Are its claims about today's code true at ${HEAD}? Check every 'current_state' line and a sample of root_causes by reading the code.
3. Security and money: can recalled or quoted text reach a model as instructions; can escalation, an oversized task or a sessions list ever pass a limit or hide spend; does the one-repository rule ever write into or act on another person's or project's repository data; does anything fail open?
4. Testability: each item has a failing test at the person's boundary, restart cases where state must survive, model-facing text asserted exactly; live check steps for what only the real model shows, with costs.
5. Conflicts: files two of these areas change without a rule; overlap with wave 15 run B (/tmp/frbench/wave15b-areas.json if it exists: w15-words owns the shared words files' sentences, w15-tail some logic) and with wave 8 (/tmp/frbench/collab/collab-areas.json): duplicated or contradicting work, and whether the wave8_amendments are right.
6. Size: each area doable in one long fixer run; a cut line that never drops the owner's core ask.
Return your findings; do not edit the files.`, { label: 'check', phase: 'Check', schema: {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    owner_intent: { type: 'array', items: { type: 'string' } },
    wrong_claims: { type: 'array', items: { type: 'string' } },
    safety_money: { type: 'array', items: { type: 'string' } },
    testability: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    size: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'owner_intent', 'wrong_claims', 'safety_money', 'testability', 'conflicts', 'size'],
} })

phase('Revise')
const final = await agent(`${CONTEXT}

You finish run C's spec from four designs: ${OUTDIR}/d1109-onerepo.json, ${OUTDIR}/d1109-sessions.json, ${OUTDIR}/d1109-oversize.json and ${OUTDIR}/chat.json. An adversarial check found: ${JSON.stringify(check)}

Verify each point against the owner's words, the code at ${HEAD} and the other specs; fix the ones that hold, and for any you reject say why with evidence. Then write /tmp/frbench/decisions1109-areas.json: { base: '${HEAD}', areas: [ <every final area spec> ], shared_files: [ '<file> (run C): <rule naming which area owns which function or sentence>' ] (for every file two run C areas change, and every file a run C area shares with w15-words or w15-tail), merge_order: [keys], concurrency_pairs: [[key,key],...] (2 agents at a time), wave8_amendments: [ '<wave 8 area key>: <change>' ], adr_plan: [ '<ADR number and title>: <decision>, written by <area key>' ], live_check_3_additions: [ { step, source, needs, est_usd, priority } ], owner_checklist_additions: [..], open_questions: [ { question, default_built, why } ], notes: [..] }. Back up nothing (it is a new file). Return a summary.`, { label: 'revise', phase: 'Revise', schema: {
  type: 'object',
  properties: {
    areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' } }, required: ['key', 'title', 'items'] } },
    merge_order: { type: 'array', items: { type: 'string' } },
    live_check_usd: { type: 'number' },
    rejected_check_points: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['areas', 'merge_order', 'live_check_usd', 'rejected_check_points', 'open_questions'],
} })

return { simple: simpleRes, chatDrafts: chatRes, chat: chatFinal, check, final }