export const meta = {
  name: 'wave15b-triage',
  description: 'Triage wave 15 run A leftovers; re-check the w15-words spec at the merged head; add a small logic tail area if needed; adversarial check; revise',
  phases: [{ title: 'Triage' }, { title: 'Check' }, { title: 'Revise' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '3600089'

const SOURCES = `Sources (read each whole; JSON unless named otherwise):
1. Wave 15 run A's reports, per area (w15-merge, w15-run, w15-review, w15-chat): /tmp/frbench/wave15a-fix-<area>.json and /tmp/frbench/wave15a-fixup-<area>.json (fixed[], not_done[], new_problems[], notes_for_other_areas[]), /tmp/frbench/wave15a-review-<area>.json (blocking[] — fixed by the fix-ups, check that the fixup report says so —, non_blocking[]), and /tmp/frbench/wave15a-merge.json (problems_left[], integration_fixes[]). Key each item as <file-stem>:<field>[<index>] (e.g. wave15a-review-w15-run:non_blocking[3]).
2. The wave 15 spec: /tmp/frbench/wave15-areas.json (areas[], shared_files[], live_check_3[], owner_checklist[], environment_notes[]) and /tmp/frbench/wave15-triage.json (148 items with decisions; the source of every W15-NN id). The w15-words area spec (areas[] key 'w15-words', 16 items) was written at 931ed52, BEFORE run A changed the code; run A merged at ${HEAD}.
3. Open owner questions (decide nothing that answers one; keep today's behaviour and list the item under owner_questions): docs/status/handoff/NEXT-SESSION.md 'Open owner questions', wave15-triage.json owner_questions, the area specs' owner_questions.
4. The design target: docs/design/core-experience.md (§5 writing rules: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does); AGENTS.md and docs/maintainers/validation.md (binding test rules).`

const ITEM_RULES = `For each source item (each not_done, new_problem, review non_blocking, notes_for_other_areas entry that asks something of another area, problems_left entry) decide one of: 'words' (design §5 wording in w15-words' files or a sentence another area asked w15-words for: goes into the w15-words addendum), 'fix' (a real logic problem: goes into the tail area), 'already_fixed' (fixed at HEAD ${HEAD}, e.g. by a fix-up or another area: give the evidence at file:line), 'duplicate' (the same as an existing W15-NN item or another source item: name it), 'not_a_problem' (with why), 'live_only' (only the real model, Windows, the subscription or real GitHub can show it: live check 3 or the owner's checklist), 'owner_question', 'later' (out of this round: wave 8's collaboration, the W15-71 'main' literals, the next wave). Confirm every 'fix' and 'words' item at HEAD ${HEAD} by reading the code at the place named (lines may have moved): if it no longer holds, it is already_fixed. Merge duplicates. Security, data loss and money first: a leftover that lets a secret reach the model, drops a person's work, writes into another project's data or lets spend pass a limit is 'fix' with severity major or higher, never 'later'.`

const AREA_RULES = `Then build run B of wave 15 (one workflow, concurrency 2, each area's fixer in its own worktree on ${HEAD}):
(a) The w15-words area, revised: re-check each of its 16 items at ${HEAD} (run A may have fixed, moved or changed the premise of some: e.g. W15-27 landed, so review_waits means the next session reviews the kept result without running the specialist again; w15-run changed the wrap-up words for W15-16; give each item's current file:line). Write the revised spec in full (same fields as the other areas: key 'w15-words', title, problems[], decisions[], u_entries[], root_causes[], fix_scope, files[], acceptance[], depends_on[], handoff_items[], owner_questions[], size), adding the new 'words' items from run A. Keep its cut line (what may end in not_done, what never may). If it would exceed about 24 items, move the lowest-severity words items to 'later' with the reason rather than overloading it.
(b) A tail area 'w15-tail' for the 'fix' items, only if there are any real ones: the logic leftovers of run A (e.g. the W15-02 sibling: a resume of a branch whose PR is open resets a person's local commit; a Docs row whose status is held by another project's status PR; the W15-33 plan-card line if it is logic). At most about 12 items, severity order, each with its failing test at the person's boundary named. If there are none, tail is null.
(c) shared_files rules marked '(wave 15 run B)' for every file both w15-tail and w15-words touch (tail owns logic and the state words read; w15-words owns the sentences), and a merge order (w15-tail first, then w15-words).
(d) live_check_3_additions (steps for 'live_only' items and for run A's fixes whose proof needs the real model that are not already in wave15-areas.json live_check_3; each with est_usd; the whole live check 3 stays capped at USD 3, so give a priority and say which existing steps they displace), owner_checklist_additions, owner_questions (new ones only).
Model-facing prompts are code: fixing them is allowed and tested by asserting the exact text the model receives.`

const OUT = `Write two files and return the summary:
- /tmp/frbench/wave15b-triage.json: { base: '${HEAD}', items: [ { id: 'W15B-NN', sources: [..], severity, decision, area (if words/fix), title, evidence, root_cause_at_head, notes } ], words_items_rechecked: [ { id: 'W15-NN', status_at_head: 'still_true'|'changed'|'already_fixed', where_now, note } ], owner_questions: [..], count_by_decision: {..} }
- /tmp/frbench/wave15b-areas.json: { base: '${HEAD}', areas: [ <w15-words revised spec>, <w15-tail spec, if any> ], shared_files: [ '<file> (wave 15 run B): <rule>' ], merge_order: [keys], live_check_3_additions: [ { step, source, needs, est_usd, priority, displaces } ], owner_checklist_additions: [..], notes: [..] }
Do not edit the repository (read-only), do not commit or push. Keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first; never leave the shell outside ${REPO}).`

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    items_total: { type: 'number' },
    by_decision: { type: 'object' },
    words_items: { type: 'number', description: 'items in the revised w15-words spec' },
    tail_items: { type: 'number', description: 'items in w15-tail, 0 if none' },
    merge_order: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['items_total', 'by_decision', 'words_items', 'tail_items', 'merge_order'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'needs-changes'] },
    missing_items: { type: 'array', items: { type: 'string' } },
    wrong_decisions: { type: 'array', items: { type: 'string' } },
    words_spec_problems: { type: 'array', items: { type: 'string' }, description: 'w15-words items whose premise or place at HEAD is wrong in the revised spec, or acceptance not checkable' },
    tail_problems: { type: 'array', items: { type: 'string' } },
    file_conflicts: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'missing_items', 'wrong_decisions', 'words_spec_problems', 'tail_problems', 'file_conflicts'],
}

phase('Triage')
const triage = await agent(`You are the triage lead for wave 15 run B of Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD}: wave 15 run A merged — areas w15-merge, w15-run, w15-review, w15-chat, each fixed, independently reviewed and fixed up; full suite and bench smoke green). Run B is the words area w15-words (planned since the start to run after the logic areas) plus, if needed, a small logic tail for what run A left.

${SOURCES}

${ITEM_RULES}

${AREA_RULES}

${OUT}`, { label: 'triage', phase: 'Triage', schema: SUMMARY_SCHEMA })

phase('Check')
const check = await agent(`You check a triage adversarially. Forerunner (main checkout ${REPO}, HEAD ${HEAD}). The triage lead wrote /tmp/frbench/wave15b-triage.json and /tmp/frbench/wave15b-areas.json from these sources:

${SOURCES}

The rules it had to follow:
${ITEM_RULES}

${AREA_RULES}

Its summary: ${JSON.stringify(triage)}

Try to find what is wrong: (1) every source item (each not_done, new_problem, review non_blocking, notes_for_other_areas entry and problems_left entry of run A) is accounted for, cited by its key; list each one missing. (2) Decisions: re-read the code at ${HEAD} for every 'already_fixed', 'not_a_problem' and 'later' item and for a sample of 'words' and 'fix' items; a security, data-loss or money item marked later or not_a_problem is wrong unless the evidence is airtight. (3) The revised w15-words spec: for each of its items check the premise and place at ${HEAD} (run A changed request-words.ts, task-words.ts, event-lines.ts, budget-pause.ts, executor.ts, runner.ts, views.ts and more); each acceptance line checkable at the person's boundary. (4) The tail area: real items only, each with a failing test at the boundary, not overlapping w15-words' sentences without a shared_files rule. (5) live check 3 additions keep the USD 3 cap. Read-only: do not edit the repository; keep every shell command inside ${REPO} or /tmp/frbench.`, { label: 'check', phase: 'Check', schema: CHECK_SCHEMA })

phase('Revise')
const revised = await agent(`You revise Forerunner's wave 15 run B triage (main checkout ${REPO}, HEAD ${HEAD}). Files: /tmp/frbench/wave15b-triage.json and /tmp/frbench/wave15b-areas.json (back them up first as *.before-check.json).

${SOURCES}

The rules:
${ITEM_RULES}

${AREA_RULES}

${OUT}

An adversarial check found: ${JSON.stringify(check)}

Verify each point against the sources and the code at ${HEAD}; fix the ones that hold (add missing items, correct decisions, fix the specs and rules); for any you reject, say why with evidence. Rewrite both files and return the summary, with notes saying what changed and what you rejected.`, { label: 'revise', phase: 'Revise', schema: SUMMARY_SCHEMA })

return { triage, check, revised }