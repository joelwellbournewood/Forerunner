export const meta = {
  name: 'run-l4-triage',
  description: 'Triage live check 4 findings and the run C / L3 leftovers into one fix run (run L4): per-group triage, synthesis into areas, adversarial check, revise',
  phases: [{ title: 'Triage', detail: 'one triager per subsystem group' }, { title: 'Synthesis', detail: 'areas, shared files, sub-runs' }, { title: 'Check', detail: 'adversarial completeness and decision check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '4cf11fd'
const GROUPS = ['selftasks', 'creds', 'chat', 'github', 'money', 'other']

const CONTEXT = `Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}: run C merged, the owner's decisions of 2026-11-09 and the budget answer of 2026-11-16 built; live check 4 done with the real model). You are part of the triage that builds ONE fix run, "run L4", from what live check 4 found and what run C and run L3 left. Read-only for the repository: do not edit, commit or push; keep every shell command inside ${REPO} or /tmp/frbench.

Read first: /tmp/frbench/owner-decisions-2026-11-09.md (the owner's words: later sections overrule earlier ones; they decide what the app must do), docs/design/core-experience.md (the design target; section 5 the writing rules), AGENTS.md and docs/maintainers/validation.md (the test rules), /tmp/frbench/runC-plan.json (session_lead_decisions, shared_files, owner_questions; the run C areas and what they own), /tmp/frbench/live4/BRIEF.md and /tmp/frbench/live4/steps.json (what live check 4 was asked to check).`

const ITEM_RULES = `Decide each source item exactly once: 'fix' (a real problem to fix in run L4), 'words' (design section 5 wording only), 'already_fixed' (fixed at ${HEAD}: give the evidence: file:line or the test), 'not_a_problem' (say why), 'model_only' (the app did as designed and the model chose otherwise; but if a prompt, tool definition or brief the app sends made that choice likely, it IS a 'fix'), 'owner_question' (only the owner can decide it: say the question in one sentence and the default the app keeps until the owner answers), 'live_only' (only the owner's own subscription, Windows desktop or a real account limit can show it: it goes to the owner's checklist), 'accepted' (a session lead decision already recorded it as accepted: name the decision), 'later' (outside this round: collaboration between people, the phone round). A 'fix' or 'words' item is confirmed at ${HEAD} by reading the code at the place its verdict or report names (line numbers may have moved): if it no longer holds, decide 'already_fixed'. Merge duplicates: the same root cause from several sources is ONE item that cites every source key. Severity: blocker, major, minor, words. Money, data loss, security and the owner's decisions first.`

const AREA_RULES = `Areas for run L4 (the fix workflow runs each area as fix, independent review on the bench, fix-up, then merge; two areas at a time in parallel worktrees, as sub-runs of at most two areas that share no file): each area owns its files; where two areas must touch one file, a shared_files rule says which area owns which function or sentence. An area is one fixer's long run: about 8 to 16 items, fewer if large. Order inside an area: blocker, major (money and the owner's decisions first), minor, words. Each area spec has the fields of the run C areas in /tmp/frbench/runC-plan.json (read two of them as the model): key (prefix 'l4-'), title, problems[] (each '[severity] ID: what the person sees; Evidence: <source keys and file paths>; Root cause: <file:line at ${HEAD}>'), decisions[], u_entries[], root_causes[], fix_scope (one string: the order; for each item its failing test first at the person's boundary, naming the boundary: a real-daemon case for a route, a composed runtime test for engine behaviour, a UI test that clicks and asserts what appears and what is sent, an exact-text assertion for model-facing prompts and tool definitions; what not to touch; the security rules: never weaken the hooks or the sandbox, text from pages, searches, files, cards, chat history, reports or any record never becomes instructions to a model; money: no budget, wrap-up line, monthly cap or plan-share cap is ever passed), files[], acceptance[] (one checkable line per item at that boundary), depends_on[], handoff_items[], owner_questions[], size (with a cut line: which items may end in not_done and which never).`

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    group: { type: 'string' },
    source_keys_total: { type: 'number' },
    by_decision: { type: 'object' },
    items_file: { type: 'string' },
    proposed_areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' }, majors: { type: 'number' } }, required: ['key', 'title', 'items'] } },
    owner_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['group', 'source_keys_total', 'by_decision', 'items_file', 'proposed_areas', 'owner_questions'],
}

const groupPrompt = (g) => `${CONTEXT}

Your group: "${g}". Your sources: /tmp/frbench/runL4/sources-${g}.json (read it whole). It holds: live_findings[] (key, the live check 4 finding with its evidence under /tmp/frbench/live4/<journey>/, and the skeptical verdict: real, model_only, severity, root_cause, where, fix_sketch, failing_test_idea, area_hint, known_leftover); live_steps[] (steps of live check 4 that did not pass: read their observed text for problems that have no finding; most are covered by a finding); leftovers[] (key '<file tag>:<id>', from, severity, text; their source files /tmp/frbench/leftovers-*.json have for_session_lead notes, and the run C / run L3 reports they name are in /tmp/frbench). Other groups triage the other bundles; an item of yours that belongs to another subsystem is still yours to decide (say so in its notes and suggest the area).

${ITEM_RULES}

Then propose one or two fix areas for your group's 'fix' and 'words' items, following these rules:
${AREA_RULES}

Write /tmp/frbench/runL4/triage-${g}.json: { group, base: '${HEAD}', items: [ { id: 'L4-${g}-<n>', sources: [source keys], severity, decision, title, what_the_person_sees, evidence, root_cause_at_head, fix_sketch, test_boundary, area (proposed key, for fix/words), owner_question (for owner_question: the question and the default kept), notes } ], proposed_areas: [ <area spec> ], owner_questions: [..], owner_checklist: [..] }. Every source key of your bundle appears in exactly one item's sources. Return the summary.`

phase('Triage')
const groups = await pipeline(GROUPS, (g) => agent(groupPrompt(g), { label: `triage:${g}`, phase: 'Triage', schema: GROUP_SCHEMA }))

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan_file: { type: 'string' },
    items_total: { type: 'number' },
    by_decision: { type: 'object' },
    areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' }, majors: { type: 'number' }, sub_run: { type: 'string' } }, required: ['key', 'title', 'items', 'sub_run'] } },
    sub_runs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['name', 'keys'] } },
    owner_questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['plan_file', 'items_total', 'by_decision', 'areas', 'sub_runs', 'owner_questions'],
}

phase('Synthesis')
const plan = await agent(`${CONTEXT}

Six group triagers wrote /tmp/frbench/runL4/triage-<group>.json for the groups ${GROUPS.join(', ')} (their summaries: ${JSON.stringify(groups)}). Read all six whole. Build the run L4 plan:
1. Cross-group duplicates: one item per root cause (keep every source key); re-check any two items that touch the same function.
2. Areas: rebuild the proposed areas into the final set, following these rules:
${AREA_RULES}
   Prefer few areas that own whole subsystems over many small ones; one words area may own the shared words files (request-words.ts, task-words.ts, event-lines.ts, credential-words.ts, result.ts sentences) and take every 'words' item, unless a words item belongs with a logic change in the same function.
3. Sub-runs: group the areas into sub-runs of at most two areas each that share no file (the fix workflow runs a sub-run's two areas in parallel, then merges them; sub-runs run one after another, each on the last one's merge). Order: the areas with the majors that the rest builds on first.
4. shared_files: one rule per file two areas of the whole run change ('<file>: <area> owns <function or sentence>; <area> owns ...').
5. owner_questions: every owner_question item, deduplicated, each with the default the app keeps.
6. owner_checklist: the live-only items, /tmp/frbench/runL4/owner-checklist-live4.json and the earlier owner checklist items you find in runC-plan.json and the leftovers files, deduplicated.
7. final_check: for phase F (the independent final check with the real model after run L4): the steps that prove the run L4 fixes that only the real model or real GitHub can show, with an estimated USD each (keep the total under about USD 5).
Write /tmp/frbench/runL4-plan.json: { base: '${HEAD}', items: [ every item of the six files, with its final area or decision ], areas: [ <area spec> ], sub_runs: [ { name: 'L4a', keys: [..], note } ], merge_order: [..], shared_files: [..], owner_questions: [..], owner_checklist: [..], final_check: [ { step, proves, needs, est_usd } ], decisions: [ the session-lead decisions you applied, each citing the owner's words or a recorded decision ] }. Return the summary.`, { label: 'synthesis', phase: 'Synthesis', schema: PLAN_SCHEMA })

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    missing_items: { type: 'array', items: { type: 'string' } },
    wrong_decisions: { type: 'array', items: { type: 'string' } },
    file_conflicts: { type: 'array', items: { type: 'string' } },
    spec_problems: { type: 'array', items: { type: 'string' } },
    owner_question_problems: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'missing_items', 'wrong_decisions', 'file_conflicts', 'spec_problems', 'owner_question_problems'],
}

phase('Check')
const check = await agent(`${CONTEXT}

You check the run L4 triage adversarially. The sources: /tmp/frbench/runL4/sources-<group>.json for ${GROUPS.join(', ')}; the group triages /tmp/frbench/runL4/triage-<group>.json; the plan /tmp/frbench/runL4-plan.json (summary: ${JSON.stringify(plan)}).

The rules it had to follow:
${ITEM_RULES}
${AREA_RULES}

Find what is wrong: (1) every source key of the six bundles is in exactly one item of the plan (count them; list each missing or doubled key); (2) sample at least 15 decisions against the code at ${HEAD}, above all 'already_fixed', 'not_a_problem', 'model_only' and 'accepted', and every major: does the root cause hold, is the decision right; (3) every 'owner_question' really needs the owner (not something the owner's words of 2026-11-09 or 2026-11-16 already decide: quote them), and no fix answers an open owner question; (4) file ownership: every file two areas change has a rule and no rule contradicts another, and the two areas of each sub-run share no file; (5) each area is doable in one run, each item has a failing-test-first boundary and a checkable acceptance line, the security and money rules are in every fix_scope; (6) final_check covers the fixes that need the real model. Read-only: edit nothing.`, { label: 'check', phase: 'Check', schema: CHECK_SCHEMA })

let revised = null
if (check && check.verdict === 'needs-changes') {
  phase('Revise')
  revised = await agent(`${CONTEXT}

You revise the run L4 plan /tmp/frbench/runL4-plan.json (back it up first as /tmp/frbench/runL4-plan.before-check.json). Sources and group triages: /tmp/frbench/runL4/sources-<group>.json and triage-<group>.json for ${GROUPS.join(', ')}.

${ITEM_RULES}
${AREA_RULES}

The adversarial check found:
${JSON.stringify(check, null, 1)}

Verify each point against the sources and the code (the checker can be wrong: reject a point with evidence in the plan's decisions), fix the plan accordingly, and return the updated summary.`, { label: 'revise', phase: 'Revise', schema: PLAN_SCHEMA })
}
return { groups, plan, check, revised }