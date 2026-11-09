export const meta = {
  name: 'runC-reconcile',
  description: "Reconcile the two run C designs (D1-D4 and D5-D8) into one ordered build plan: sub-runs by dependency, one name per area, contradictions resolved per the owner's confirmed answers; adversarial check; revise",
  phases: [{ title: 'Reconcile' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '3600089'

const SOURCES = `Sources (read each whole):
1. /tmp/frbench/owner-decisions-2026-11-09.md: the owner's answers, in order; later sections overrule earlier ones; the last section ('Session lead's notes after the two run C designs') states two points the owner already decided that the D5-D8 design wrongly listed as open: (a) a session the person started goes on by itself when its credential is back (the reset), as the person's own start continuing, shown on the run indicator with Cancel, never moving onto another credential unless the policy says so; a NEW session after a stop still needs the person or the hands-off setting; (b) the agent changes its own tasks without asking from Standard up and asks first at Advisor and Assisted.
2. /tmp/frbench/decisions1109-areas.json: run C's D1-D4 spec (8 areas: d1109-sessions, d1109-oversize-start, d1109-chat-guard, d1109-oversize-pause, d1109-chat-recall, d1109-onerepo-link, d1109-chat-depth, d1109-onerepo-join; shared_files, merge_order, concurrency_pairs, wave8_amendments, adr_plan, live_check_3_additions, owner_checklist_additions, open_questions, notes).
3. /tmp/frbench/decisions1109-areas-2.json: run C's D5-D8 spec (6 areas: d1109-starts-engine, d1109-selftasks-run, d1109-run-visible, d1109-cred-engine, d1109-cred-screens, d1109-selftasks-chat; shared_files, merge_order_hint, adr_plan, design_doc_changes, live_check_3_additions, owner_checklist_additions, open_questions, owner_explanation, notes). Its notes name edits the D1-D4 areas need, and some of its references use draft names (onerepo-link, d1109-oversize-run, d1109-oversize-words) that the D1-D4 revision renamed.
4. The design drafts behind both, in /tmp/frbench/d1109/ (d1109-onerepo.json, d1109-sessions.json, d1109-oversize.json, chat.json, chat-*.json, cred.json, cred-*.json, d1109-starts.json, d1109-selftasks.json) for detail.
5. Run B's spec (/tmp/frbench/wave15b-areas.json: w15-tail, w15-words, running now on ${HEAD}) and /tmp/frbench/phaseE.json shared_files (the '(wave 15 run B)' rules): run C runs on run B's merged head.
6. The fix pipeline: /home/user/Forerunner/.claude/worktrees/_wf-scripts/forerunner-phase-e6.js (read it): each run takes a list of area keys; every fixer starts its worktree by merging the branch as it is when the fixer starts, so an area that needs another area's code must be in a LATER run than that area (a pair inside one run builds on the same base and only meets at the merge); concurrency is 2 agents; the merge agent merges every area of the run in key order at the end and runs the full suite and the bench smoke.
7. docs/design/core-experience.md, AGENTS.md, docs/maintainers/validation.md, docs/decisions/README.md (the ADR template; the next free number is 0114).`

const TASK = `Make ONE build plan for run C out of the two specs:
(a) One name per area, used everywhere (keys, depends_on, shared_files, notes): the 14 final areas (or fewer or more if a merge or split is clearly better; say why).
(b) Resolve every contradiction between the two specs and with the owner's answers, the latest owner section winning. At least: the continuation after a credential stop (owner-decided (a) above: reinstate it where the D5-D8 revision removed it, in d1109-starts-engine, d1109-cred-engine, d1109-cred-screens and d1109-run-visible, with its words and its Cancel); D7's level (owner-decided (b): not an open question); d1109-oversize's 'goes on by itself' (a limit raised or reset only prepares, except the person's own waiting session, which goes on as in (a)); d1109-sessions reading plan.startedBy and run-visible's runText; the draft names; who owns each shared function or sentence; the ADR numbers (one sequence from 0114 in merge order, no number used twice); the U-entry numbers.
(c) Order: group the areas into sequential sub-runs C1, C2, C3, ... of 2 to 4 areas each, so that no area depends on an area of the same or a later sub-run, and within a sub-run the areas touch disjoint regions as far as possible (pairs by concurrency). Prefer security and data-integrity work first (chat-guard before chat-recall; onerepo-link before onerepo-join), and the engine before its screens. Give each sub-run a wave number for ports (17, 18, 19, ...), its key order (= merge order) and a short note for its fixers.
(d) shared_files: one list, each rule marked '(run C)' and naming the sub-run, covering every file two run C areas touch and every file a run C area shares with run B's areas.
(e) Open owner questions: one deduplicated list of what is truly still open (not the two decided points), each with the default built meanwhile and why, ranked by how much the answer changes; and one list of session-lead decisions you made.
(f) Live checks: the run C real-model steps of both specs, deduplicated, with costs and priorities, as 'live check 4' after the last sub-run, with a proposed cap; plus anything that must run after a particular sub-run.
(g) design_doc_changes: one merged list for the session lead (docs/design/core-experience.md is edited by the session lead, not by fixers).
(h) wave8_amendments: the merged list.

Write /tmp/frbench/runC-plan.json: { base: 'run B merged head (built on ${HEAD})', sub_runs: [ { name, wave, keys, depends_on_sub_runs, note } ], areas: [ <every final area spec, complete, same fields as phaseE.json areas, with the corrections applied> ], shared_files: [..], adr_plan: [..], u_entries: [..], design_doc_changes: [..], wave8_amendments: [..], live_check_4: { cap_usd, steps: [ { step, source, needs, est_usd, priority, after_sub_run } ] }, owner_checklist_additions: [..], owner_questions: [ { question, default_built, why, rank } ], session_lead_decisions: [..], notes: [..] }. Read-only on the repository: do not edit, commit or push. Keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first).`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sub_runs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, wave: { type: 'number' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['name', 'wave', 'keys'] } },
    areas_total: { type: 'number' },
    items_total: { type: 'number' },
    owner_questions: { type: 'array', items: { type: 'string' } },
    live_check_4_usd: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['sub_runs', 'areas_total', 'items_total', 'owner_questions', 'live_check_4_usd'],
}

phase('Reconcile')
const plan = await agent(`You are the planner of run C for Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}; wave 15 run B is being built on top of it). Two design workflows produced run C's fix areas in parallel for the owner's decisions of 2026-11-09; your job is to turn them into one consistent, ordered build plan.

${SOURCES}

${TASK}`, { label: 'reconcile', phase: 'Reconcile', schema: PLAN_SCHEMA })

phase('Check')
const check = await agent(`You check run C's build plan adversarially. Forerunner (main checkout ${REPO}, HEAD ${HEAD}). The planner wrote /tmp/frbench/runC-plan.json from:

${SOURCES}

Its task was:
${TASK}

Its summary: ${JSON.stringify(plan)}

Try to find what is wrong: (1) an area in a sub-run that needs code from an area of the same or a later sub-run (read each area's depends_on, files and fix_scope; check the code paths they name at ${HEAD}); (2) a contradiction left between areas or with the owner's answers (latest section wins; the two decided points in the last section); (3) an owner answer not built by any area, or built against the owner's words (quote them); (4) shared files without a rule, or rules that contradict; (5) ADR or U-entry numbers used twice or out of merge order; (6) items lost between the two specs and the plan (count the problems of every area in both sources and in the plan, and list any dropped without a reason); (7) security, money and the person's control: anything that could start a session the person did not ask for (beyond the decided continuation of their own session), move work while the app says it waits, pass a cap, or let recorded text steer a model; (8) owner questions that are not really open, or open ones missing. Do not edit the file; return findings.`, { label: 'check', phase: 'Check', schema: {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    ordering: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    owner_intent: { type: 'array', items: { type: 'string' } },
    shared_files: { type: 'array', items: { type: 'string' } },
    numbering: { type: 'array', items: { type: 'string' } },
    lost_items: { type: 'array', items: { type: 'string' } },
    safety: { type: 'array', items: { type: 'string' } },
    owner_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'ordering', 'contradictions', 'owner_intent', 'shared_files', 'numbering', 'lost_items', 'safety', 'owner_questions'],
} })

phase('Revise')
const final = await agent(`You finish run C's build plan for Forerunner (main checkout ${REPO}, HEAD ${HEAD}): /tmp/frbench/runC-plan.json (back it up first as /tmp/frbench/runC-plan.before-check.json).

${SOURCES}

The task the plan answers:
${TASK}

An adversarial check found: ${JSON.stringify(check)}

Verify each point against the sources and the code at ${HEAD}; fix the ones that hold; for any you reject, say why with evidence. Rewrite the file and return the summary, with notes saying what changed and what you rejected. Also add to the file 'owner_summary': at most 12 short plain lines for the owner: what run C builds, in what order, roughly how long (each sub-run is about 5 to 7 hours of agent work), and what is left for later.`, { label: 'revise', phase: 'Revise', schema: PLAN_SCHEMA })

return { plan, check, final }