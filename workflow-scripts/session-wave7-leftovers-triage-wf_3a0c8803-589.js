export const meta = {
  name: 'wave7-leftovers-triage',
  description: 'Sort every leftover from wave 7 groups 1-5 against the code at fa1a86f into polish, real problems, live checks and owner questions',
  phases: [{ title: 'Triage', detail: 'one agent per group result file' }, { title: 'Synthesize', detail: 'dedup, build the group 6 area spec' }],
}
const REPO = '/home/user/Forerunner'
const FILES = ['wave7g1-result.json', 'wave7g2-result.json', 'wave7g3-result.json', 'wave7g4-result.json', 'wave7g5-result.json']
const ITEM = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'file and JSON path, e.g. wave7g4-result.json areas[budget-resume].fix.not_done[2]' },
    item: { type: 'string', description: 'the leftover in one or two sentences, in plain words' },
    category: { type: 'string', enum: ['fixed_already', 'polish_existing', 'polish_add', 'real', 'live_check', 'owner_question', 'later_wave8', 'not_a_problem'] },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish', 'n/a'] },
    evidence: { type: 'string', description: 'file:line at the current HEAD (fa1a86f) and what the code does now; for fixed_already, the commit or test that fixed it' },
    test_idea: { type: 'string', description: 'for real/polish_add: the failing test to write first, at the boundary the person uses' },
  },
  required: ['source', 'item', 'category', 'severity', 'evidence'],
}
const TRIAGE = { type: 'object', properties: { items: { type: 'array', items: ITEM } }, required: ['items'] }
const COMMON = `Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0, HEAD fa1a86f) is a desktop persistent AI project manager (React UI apps/ui, daemon packages/runtime, capabilities packages/capabilities, commands packages/commands). Wave 7 of the owner-approved plan (docs/status/handoff/NEXT-SESSION.md) built the owner's decisions of 2026-11-02 in six groups; groups 1-5 are merged at fa1a86f. Group 6 is 'polish' (words and layout): its area spec is in /tmp/frbench/phaseE.json areas[key=polish] (34 problems; read them first so you know what is already in it). Do NOT edit any file in the repository and do not commit: this is read-only triage. Do not run the full test suite; read code and run a single targeted test only when that is the cheapest way to settle whether something is still broken.

Categories:
- fixed_already: the current code no longer has the problem (cite the line or the later group's commit/test).
- polish_existing: a words/layout item already covered by one of the 34 polish problems (name which).
- polish_add: a words/layout item a person sees (wording, a raw string, layout, a duplicate button) not yet in the polish area.
- real: wrong behaviour, lost or wrong state, a security or safety gap, a crash, a wrong decision, a test gap that hides a real bug. Name the root cause file:line.
- live_check: can only be checked with the real model / real GitHub / the desktop app on Windows (say which live check in /tmp/frbench/phaseE7-live.md or phaseE7-live-extra.md it belongs to, or 'new').
- owner_question: needs the owner's choice (say the options and your recommendation).
- later_wave8: belongs to collaboration / status issue / repository guide (wave 8, /tmp/frbench/collab/collab-areas.json).
- not_a_problem: the claim is wrong or the behaviour is intended by an ADR or the owner's decisions (/tmp/frbench/owner-decisions-2026-11-02.json); cite it.
Verify every claim against the code at HEAD yourself: a leftover written by an earlier agent may be stale or wrong. Be exact and terse.`

phase('Triage')
const parts = await parallel(FILES.map((f) => () => agent(`${COMMON}

Your file: /tmp/frbench/${f}. It is a wave result: {wave, areas[], missing, merge}. Each area has fix and maybe fixup reports (fields like not_done, new_problems, notes_for_other_areas, fixed) and a review (blocking, non_blocking); merge has problems_left and integration_fixes. Collect EVERY leftover: fix/fixup not_done and new_problems, review non_blocking (and any blocking the fixup did not fix), merge.problems_left and merge.integration_fixes, and any notes_for_other_areas that describe an unfixed problem (not mere API hand-overs). Skip pure API descriptions and items that the same file says were fixed. Use node or python3 to read the JSON (it is large). Then triage each item against HEAD. Return all of them.`, { label: `triage:${f}`, phase: 'Triage', schema: TRIAGE })))
const all = parts.filter(Boolean).flatMap((p) => p.items)
log(`${all.length} leftovers triaged from ${parts.filter(Boolean).length} of ${FILES.length} files`)

phase('Synthesize')
const counts = {}
for (const it of all) counts[it.category] = (counts[it.category] || 0) + 1
const syn = await agent(`${COMMON}

You are the synthesizer. Below are ${all.length} triaged leftovers from wave 7 groups 1-5 (counts by category: ${JSON.stringify(counts)}). Several files may name the same problem: merge duplicates (keep every source). Re-check every item marked real or polish_add yourself against HEAD; re-check a sample of fixed_already and not_a_problem (at least the ones whose severity was major or blocker in their source) and move any that are still broken.

Then write /tmp/frbench/wave7g6-triage.json (use node or python3 to write it; it is not in the repository) with:
{
 "base": "fa1a86f",
 "items": [ every deduplicated item, with sources[], category, severity, evidence, test_idea ],
 "new_areas": [ area objects for the real problems, in the same shape as /tmp/frbench/phaseE.json areas (key, title, problems[] each a string starting with [blocker]/[major]/[minor] and its evidence file:line, u_entries[], root_causes[] file:line, fix_scope, files[], acceptance[] (each an observable check at the person's boundary or a named failing test), depends_on[], size). Use key 'leftovers7' for one area; if the real problems are more than about 14 or split cleanly by subsystem, make two areas with DISJOINT files, keys 'leftovers7-run' (session, loop, git, budget, critic, branches) and 'leftovers7-web' (web access, SDK hooks, reader, credentials). Order problems by severity. Each must name files at HEAD lines. Group 4's two real problems must be in: same-titled tasks get the same branch fr/<first 8 chars of UUIDv7>-<slug> within about 65 s (dependent-branches); a critic review refused at the project's budget counts as a failed try instead of a pause (budget-stop/review path; evidence packages/runtime/test/budget-pause.test.ts with projectBudgetUsdMicro 12_500) — verify both. ],
 "polish_add": [ strings in the polish problems' style: '[polish] or [minor] <what the person sees>' + evidence file:line ],
 "shared_files": [ for each file both a new area and polish are likely to touch: {file, owner_rule} — logic belongs to the leftovers area, words to polish ],
 "live_checks": [ {item, which_check, steps} ],
 "owner_questions": [ {question, options, recommendation} ],
 "later_wave8": [ strings ],
 "dropped": [ {item, category fixed_already|not_a_problem|polish_existing, why} ]
}
Return a short text summary: counts per category after dedup, each new area's key and its problem titles (one line each), and the polish_add titles.

The triaged items:
${JSON.stringify(all)}`, { label: 'synthesize', phase: 'Synthesize' })
return { counts, total: all.length, summary: syn }
