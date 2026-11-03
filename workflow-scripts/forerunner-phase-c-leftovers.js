export const meta = {
  name: 'forerunner-phase-c-leftovers',
  description: 'Triage the 140 leftovers phase C reported (not_done, new_problems, notes, review non_blocking) against the merged branch, assign real problems to phase E areas in handoffs.json, then adversarially verify the triage',
  phases: [
    { title: 'Triage', detail: 'dedupe, check against 193e579, assign or park with a reason' },
    { title: 'Verify', detail: 'an independent skeptic checks every drop and every assignment' },
  ],
}

const REPO = '/home/user/Forerunner'
const HEAD = '193e579'

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0, HEAD ${HEAD}) is a desktop app: a persistent AI project manager (React UI in apps/ui, daemon in packages/runtime, Tauri shell). The owner-approved plan is docs/status/handoff/NEXT-SESSION.md. Phase C (verification, continuity, github-result, research-web) has just been merged at ${HEAD}. Phase E (the leftovers sweep) starts next, in five areas: answers, screens, noise, bench, polish. Their scope and the files each owns are in /tmp/frbench/phaseE.json (\`areas\`: key, headline, owns; \`shared_files\`; \`triage\`: the 102 items already assigned, each with area, decision, evidence and note). Each phase E fixer reads its triage items plus \`/tmp/frbench/handoffs.json\` [<area key>] (and that file's "_about").

Inputs:
- /tmp/frbench/phaseC-leftovers-raw.json: 140 entries [phase C area, stage (fix | fixup | review), field (not_done | new_problems | notes_for_other_areas | non_blocking), text]. Many repeat each other; some were fixed later in the fix-up or the merge; some are notes about new APIs, not problems.
- /tmp/frbench/phaseC-result.json: the whole phase C report (areas[].fix/review/fixup with what each fixed, and merge.problems_left, merge.integration_fixes).
- The code at ${HEAD} (read it; do not change any file in the repository and do not switch branches: read with \`git -C ${REPO} show ${HEAD}:<path>\` or the working tree, which is at ${HEAD}).

The owner's decisions that bind this triage (do not re-open them): verification is proportional and its checks are invisible ("Reviewed" / "Reviewed and tried", no "checks only" or tier words on a person's screens); web access for the researcher and science-evaluator on the API key; API key billing first; Docker is on the owner's PC; agents touch only the forerunner-sandbox repository; the phone (apps/ui/src/mobile, apps/mobile) is phase H, after the desktop round.
`

const ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'C-<n>, stable' },
    problem: { type: 'string', description: 'what a person meets, in one or two sentences' },
    evidence: { type: 'string', description: 'file:line at HEAD or the report quote that shows it is still true' },
    expected: { type: 'string' },
    severity: { type: 'string', enum: ['major', 'minor', 'polish'] },
    disposition: { type: 'string', enum: ['area', 'owner-decision', 'phase-F-check', 'phone', 'info', 'fixed', 'duplicate', 'wrong'] },
    area: { type: 'string', description: 'answers | screens | noise | bench | polish when disposition is area; else empty' },
    sources: { type: 'array', items: { type: 'integer' }, description: 'indexes into phaseC-leftovers-raw.json' },
    reason: { type: 'string', description: 'for fixed / duplicate / wrong / info / owner-decision / phase-F-check / phone: why, with evidence' },
  },
  required: ['id', 'problem', 'evidence', 'expected', 'severity', 'disposition', 'area', 'sources', 'reason'],
}
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: ITEM },
    every_source_index_covered: { type: 'boolean' },
    written: { type: 'array', items: { type: 'string' }, description: 'files written' },
    counts: { type: 'string' },
  },
  required: ['items', 'every_source_index_covered', 'written', 'counts'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    corrections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, was: { type: 'string' }, now: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'was', 'now', 'evidence'] } },
    missed_sources: { type: 'array', items: { type: 'integer' } },
    final_counts: { type: 'string' },
    owner_decisions: { type: 'array', items: { type: 'string' }, description: 'each owner-decision item as a question the owner can answer with one choice' },
    written: { type: 'array', items: { type: 'string' } },
  },
  required: ['corrections', 'missed_sources', 'final_counts', 'owner_decisions', 'written'],
}

phase('Triage')
const triage = await agent(`${COMMON}
You triage phase C's leftovers. For EVERY index of phaseC-leftovers-raw.json (0..139), it ends up in exactly one item's sources. Group entries that describe the same problem into one item. For each item decide, checking the code at ${HEAD} (not the reports' word):
- fixed: already true at ${HEAD} (later fix-up, merge or another area did it): evidence file:line.
- duplicate: the same problem is already in phaseE.json triage (name its index and area) — it stays there.
- wrong: the report's claim does not hold at ${HEAD}: evidence.
- info: a note about an API or a design choice, no person meets a problem.
- phone: only on the phone screens (phase H).
- owner-decision: only the owner can choose (say the choice in one line).
- phase-F-check: needs the real model, real GitHub, Docker or Windows to know; phase F's walkers check it.
- area: a real problem a phase E area should fix now: pick the area whose owned files or headline fit (phaseE.json areas[].owns). Prefer the area that owns the file to change; if none fits, polish for words and layout, bench for the bench and stand-ins, screens for a screen that leads nowhere, answers for chat/Inbox/answers/start, noise for notifications and folder clutter. A phase C area's own core files (runner.ts review path, critic loop, pr-executor, web_fetch) are open to the phase E area you assign: say the file in evidence.
Severity: major (a person is stuck, misled or loses work), minor, polish.

Then write:
1. /tmp/frbench/phaseC-leftovers-triage.json: {items: [...]} (all items, every disposition).
2. /tmp/frbench/handoffs.json: keep every existing key and value; add or extend the keys answers, screens, noise, bench, polish with the area items (each the item object). Prepend to "_about" one paragraph: phase C merged at ${HEAD} (report /tmp/frbench/phaseC-result.json, triage /tmp/frbench/phaseC-leftovers-triage.json); the keys answers/screens/noise/bench/polish hold phase C leftovers for phase E; each item is the area's to fix with a test or to report in not_done with a reason; check first that it is still true.
Use python to write JSON (valid, indented). Report the items.`, { label: 'triage:phase-c-leftovers', phase: 'Triage', schema: TRIAGE_SCHEMA })

if (!triage) return { triage: null }

phase('Verify')
const verify = await agent(`${COMMON}
You are an independent skeptic of a triage another agent made of phase C's leftovers (it wrote /tmp/frbench/phaseC-leftovers-triage.json and added area items to /tmp/frbench/handoffs.json). Your job is to find what it got wrong, above all real problems it threw away.
1. Coverage: every index 0..139 of /tmp/frbench/phaseC-leftovers-raw.json is in some item's sources; list any that are not, and triage them yourself.
2. Every item with disposition fixed, wrong, info or duplicate: read the raw entries and check the claim against the code at ${HEAD} yourself. Default to doubting it: if a person could still meet the problem at ${HEAD}, it is not fixed.
3. Every area item: is it real at ${HEAD} (spot-check at least half, all majors), is the area right by phaseE.json areas[].owns, is the expected result clear enough for a fixer.
4. owner-decision items: is it really the owner's choice, or does a binding owner decision (in the context above) already answer it? Turn each remaining one into a one-line question with its choices.
Apply your corrections to both files (python, keep them valid; handoffs.json keeps every other key). Report each correction with evidence.

Triage report: ${JSON.stringify(triage)}`, { label: 'verify:phase-c-leftovers', phase: 'Verify', schema: VERIFY_SCHEMA })

return { triage, verify }
