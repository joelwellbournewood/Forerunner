export const meta = {
  name: 'wave15-triage',
  description: 'Triage live check 2 findings and wave 13 leftovers into the wave 15 fix areas; adversarial completeness check; revise',
  phases: [{ title: 'Triage' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '931ed52'

const SOURCES = `Sources (read each whole; they are JSON unless named otherwise):
1. /tmp/frbench/live2-result.json: .result.results[] per journey (github, run, research): live.findings[] (id, severity, what the person sees, expected, evidence under /tmp/frbench/live2/<journey>/, repro) and verified[] (id, real, model_only, root_cause, where, fix_sketch, failing_test_idea) — findings of severity 'words' were not verified; live.steps[] with result fail/partial/not_seen/skipped_cap/not_possible_here; live.owner_checklist_items. NOTE: finding ids repeat across journeys (github F1 vs research F1): key them as <journey>:<id>.
2. Wave 13's leftovers: /tmp/frbench/wave7g6d-fix-<area>.json and wave7g6d-fixup-<area>.json (not_done[], new_problems[], notes_for_other_areas) and /tmp/frbench/wave7g6d-review-<area>.json (blocking[] fixed by the fix-ups, non_blocking[]) for areas leftovers7-tailmerge, leftovers7-tailrun, polish-words, polish-screens; /tmp/frbench/wave7g6d-merge.json problems_left.
3. The copy line-endings fix (29e0c81): /tmp/frbench/copyfix-result.json .result.review.non_blocking and .result.fix.not_done.
4. Earlier specs for format and context: /tmp/frbench/phaseE.json (areas[] with key, title, problems, decisions, u_entries, root_causes, fix_scope, files, acceptance, depends_on, handoff_items, owner_questions, size; shared_files[]), especially the wave 13 areas leftovers7-tailmerge, leftovers7-tailrun, polish-words, polish-screens.
5. Open owner questions (decide nothing that answers one; keep today's behaviour and list the item under owner_questions): docs/status/handoff/NEXT-SESSION.md 'Open owner questions', /tmp/frbench/wave7g6-triage.json owner_questions, the polish specs' owner_questions.
6. The design target: docs/design/core-experience.md (§5 writing rules); AGENTS.md and docs/maintainers/validation.md (binding test rules).`

const ITEM_RULES = `For each source item decide one of: 'fix' (a real problem to fix in wave 15), 'words' (design §5 wording, fix in wave 15's words area), 'already_fixed' (fixed at HEAD ${HEAD}: give the evidence), 'not_a_problem' (with why), 'model_only' (the app did as designed, the model chose otherwise: no code fix; but if a prompt or brief the app sends made the model's choice likely, that IS a fix), 'owner_question' (needs the owner), 'live_only' (only a live or Windows/subscription check can show it: goes to live check 3 or the owner's checklist), 'later' (out of this round's scope, e.g. collaboration/peers → wave 8). Confirm each 'fix' at HEAD ${HEAD} by reading the code at the place the verification or report names (line numbers may have moved): if it no longer holds, say so. Merge duplicates (the same root cause from two sources is one item, citing both).`

const AREA_RULES = `Group the 'fix' and 'words' items into 3 to 5 areas for one parallel fix wave (workflow concurrency is 2 agents; each area's fixer works in its own worktree on base ${HEAD}). Rules:
- Each area owns its files; overlaps are allowed only where unavoidable, and every shared file gets a shared_files rule saying which area owns which function or sentence (as in /tmp/frbench/phaseE.json's '(wave 13)' rules). Logic areas change logic and the state words read; one words area owns the wording of shared words files (request-words.ts, task-words.ts, event-lines.ts, result.ts sentences, …). Prefer splitting by subsystem: merge/GitHub side (pr-executor, dependent-branches, merge, pull-requests, docs.ts status branch), run/budget/estimates side (agent/loop.ts wrap-up and output caps, budget-pause, runner spend, estimates model), review/critic/research side (critic evidence and rules, try-plan, executor brief, researcher specialist prompt, intake web lines), chat/commands/notifications side (settings tool, conversation agent, undo cards, notifications), and words/screens.
- Size: an area should be doable by one fixer in one long run (about 8 to 16 items, fewer if large). Order items inside an area by severity (security/data loss/money first).
- Each area spec: key (prefix 'w15-'), title, problems[] (each '[severity] ID: what the person sees; Evidence: <source path and id>; Root cause: <file:line at ${HEAD}>'), decisions[], u_entries[], root_causes[], fix_scope (one string: the order, the failing test first at the person's boundary for each item — name the boundary: real-daemon case, composed daemon test, UI test, unit test of the function that writes a sentence —, what not to touch, the security rules: never weaken the hooks or the sandbox, page/search/file text never becomes instructions), files[], acceptance[] (one checkable line per item, at the boundary), depends_on[], handoff_items[], owner_questions[], size.
- Model-facing prompts (briefs, role prompts, critic instructions, planner lines) are code: fixing them is allowed and is tested by asserting the exact text the model receives (the bench model-call log or the request builder).
- A merge order for the areas (logic before words).
- live_check_3: the steps to run with the real model after wave 15 merges: every skipped_cap/not_seen step of live check 2 that can run here, plus one confirming step per 'fix' item whose proof needs the real model; with an estimated cost (cap the total at about USD 3).
- owner_checklist: the subscription/Windows/real-limit steps (from the journeys' owner_checklist_items and the wave reports), deduplicated.
- environment_notes: the GitHub test token is expired (GitHub answers 401); the github journey ran through the agent proxy, which substitutes this session's GitHub App identity; say what live check 3's github steps need.`

const OUT = `Write two files and return their summary:
- /tmp/frbench/wave15-triage.json: { base: '${HEAD}', items: [ { id, sources: [..], severity, decision, area (if fix/words), title, evidence, root_cause_at_head, notes } ], owner_questions: [..], dropped_count_by_decision: {..} }
- /tmp/frbench/wave15-areas.json: { base: '${HEAD}', areas: [ <area spec> ], shared_files: [ '<file>: <rule>' ], merge_order: [keys], live_check_3: [ { step, source, needs, est_usd } ], owner_checklist: [..], environment_notes: [..] }
Do not edit the repository (read-only), do not commit or push.`

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    items_total: { type: 'number' },
    by_decision: { type: 'object' },
    areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' } }, required: ['key', 'title', 'items'] } },
    merge_order: { type: 'array', items: { type: 'string' } },
    live_check_3_usd: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['items_total', 'by_decision', 'areas', 'merge_order', 'live_check_3_usd'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    missing_items: { type: 'array', items: { type: 'string' }, description: 'source items not accounted for in wave15-triage.json, with their source path and id' },
    wrong_decisions: { type: 'array', items: { type: 'string' }, description: 'items decided wrongly (e.g. marked already_fixed but still true at HEAD, model_only where an app prompt caused it), with evidence' },
    file_conflicts: { type: 'array', items: { type: 'string' }, description: 'files two areas both change without a shared_files rule, or rules that contradict' },
    spec_problems: { type: 'array', items: { type: 'string' }, description: 'areas too big, items without a boundary test, acceptance not checkable, owner questions answered by a fix, security rules missing' },
    notes: { type: 'string' },
  },
  required: ['verdict', 'missing_items', 'wrong_decisions', 'file_conflicts', 'spec_problems'],
}

phase('Triage')
const triage = await agent(`You are the triage lead for Forerunner's wave 15 (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}: waves 7 groups 1-6 merged, live check 2 done with the real model). Build the fix wave from what live check 2 and wave 13 left.

${SOURCES}

${ITEM_RULES}

${AREA_RULES}

${OUT}`, { label: 'triage', phase: 'Triage', schema: SUMMARY_SCHEMA })

phase('Check')
const check = await agent(`You check a triage adversarially. Forerunner (main checkout ${REPO}, HEAD ${HEAD}). The triage lead wrote /tmp/frbench/wave15-triage.json and /tmp/frbench/wave15-areas.json from these sources:

${SOURCES}

The rules it had to follow:
${ITEM_RULES}

${AREA_RULES}

Its summary: ${JSON.stringify(triage)}

Try to find what is wrong: (1) every source item (each live finding keyed <journey>:<id>, each wave 13 not_done / new_problem / review non_blocking, each copy-fix non_blocking) is accounted for exactly once (merged duplicates cite all sources); (2) sample at least 12 decisions against the code at ${HEAD} — especially 'already_fixed', 'not_a_problem' and 'model_only' — and check the verification's root cause still holds; (3) file ownership: list every file two areas change and check a shared_files rule covers it without contradiction; (4) each area is doable in one run, each item has a failing-test-first boundary and a checkable acceptance line, owner questions are not answered by a fix, security rules are present; (5) live_check_3 covers the skipped steps and the real-model proofs within about USD 3. Read-only: do not edit any file.`, { label: 'check', phase: 'Check', schema: CHECK_SCHEMA })

let revised = null
if (check && check.verdict === 'needs-changes') {
  phase('Revise')
  revised = await agent(`You revise Forerunner's wave 15 triage (main checkout ${REPO}, HEAD ${HEAD}). Files: /tmp/frbench/wave15-triage.json and /tmp/frbench/wave15-areas.json (written by the triage lead; back them up first as *.before-check.json).

${SOURCES}

${ITEM_RULES}

${AREA_RULES}

The adversarial check found:
${JSON.stringify(check, null, 1)}

Verify each point against the sources and the code (the checker can be wrong: reject a point with evidence), fix the files accordingly, and return the updated summary. Read-only for the repository.`, { label: 'revise', phase: 'Revise', schema: SUMMARY_SCHEMA })
}
return { triage, check, revised }
