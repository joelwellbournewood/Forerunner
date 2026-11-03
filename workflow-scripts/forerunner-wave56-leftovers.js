export const meta = {
  name: 'forerunner-wave56-leftovers',
  description: 'Triage the leftovers of phase E waves 5 and 6 (294 entries) against the merged head c8c16fb; assign real problems to wave 7 groups 2-6 or wave 8 (collaboration) in handoffs.json; collect the live checks; adversarially verify',
  phases: [
    { title: 'Triage', detail: 'one agent per wave: dedupe, check at c8c16fb, assign or park' },
    { title: 'Verify', detail: 'a skeptic per wave checks every drop and every assignment' },
  ],
}

const REPO = '/home/user/Forerunner'
const HEAD = 'c8c16fb'

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0) is a desktop app: a persistent AI project manager. Phase E waves 5 (answers, screens, noise, bench) and 6 (stops, asking, decisions, verification) are merged at ${HEAD}. /tmp/frbench/wave56-leftovers-raw.json holds what they left: entries [wave, area, stage (fix | fixup | review | merge), field (not_done | new_problems | notes_for_other_areas | non_blocking | problems_left), text]; full reports in /tmp/frbench/wave5-result.json and wave6-result.json. Many repeat; some were fixed later in the fixup or the merge; some are notes, not problems.

Where items can go (read each area's spec in /tmp/frbench/phaseE.json areas by key, and its files):
- wave 7 groups not started yet: dependent-branches, credential-limits (group 2); merge-in-app, credential-chooser, cost, merged-copy (group 3); budget-resume, web-search (group 4); merged-actions, sites (group 5); polish (group 6, words, layout and small leftovers of any area). Group 1 (merge-record, budget-stop, polish-desktop) is running now: do not assign to it.
- wave 8 (collaboration, after wave 7): the areas in /tmp/frbench/collab/collab-areas.json (collab-*, status-issue-host, status-issue-write, status-issue-read, repo-guide).
- phone (phase H): only the phone's screens (apps/ui/src/mobile, apps/mobile) and its watcher.
- live-check: a check that needs the real model, real GitHub, Docker or Windows; it goes into the list for the live check after wave 7.
- owner-decision: only the owner can choose; the owner's decisions of 2026-11-02 (/tmp/frbench/owner-decisions-2026-11-02.json) already answer many: do not re-open them.
- info, fixed (true at ${HEAD}: file:line), duplicate (already an item in handoffs.json or a spec: name it), wrong (does not hold at ${HEAD}: evidence).
Check every claim in the code at ${HEAD} (\`git -C ${REPO} show ${HEAD}:<path>\` or the working tree); do not change any repository file.
`

const ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'W5-n or W6-n' },
    problem: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' },
    severity: { type: 'string', enum: ['major', 'minor', 'polish'] },
    disposition: { type: 'string', enum: ['area', 'live-check', 'phone', 'owner-decision', 'info', 'fixed', 'duplicate', 'wrong'] },
    area: { type: 'string' },
    sources: { type: 'array', items: { type: 'integer' } },
    reason: { type: 'string' },
  },
  required: ['id', 'problem', 'evidence', 'expected', 'severity', 'disposition', 'area', 'sources', 'reason'],
}
const TRIAGE = { type: 'object', properties: { items: { type: 'array', items: ITEM }, covered: { type: 'string' } }, required: ['items', 'covered'] }
const VERIFY = {
  type: 'object',
  properties: {
    corrections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, was: { type: 'string' }, now: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'was', 'now', 'evidence'] } },
    missed_sources: { type: 'array', items: { type: 'integer' } },
    final: { type: 'array', items: ITEM },
  },
  required: ['corrections', 'missed_sources', 'final'],
}

const WAVES = [{ key: 'wave5', prefix: 'W5' }, { key: 'wave6', prefix: 'W6' }]

phase('Triage')
const results = await pipeline(
  WAVES,
  (w) => agent(`${COMMON}
You triage the entries whose wave is "${w.key}" (their indexes in the raw file; every one of them ends up in exactly one item's sources). Group entries that describe the same problem; ids ${w.prefix}-1, ${w.prefix}-2, ... Return the items.`, { label: `triage:${w.key}`, phase: 'Triage', schema: TRIAGE }),
  (t, w) => t && agent(`${COMMON}
You are an independent skeptic of the triage of "${w.key}" below. Check: every raw index of that wave is covered; every fixed, wrong, info and duplicate claim against the code at ${HEAD} yourself (default to doubting a drop: if a person could still meet it, it is not fixed); the majors and half the rest of the area items are real and in the right area (by the area's files and scope); live checks are really ones the stand-in cannot do. Return the corrected final list (all items).

Triage: ${JSON.stringify(t)}`, { label: `verify:${w.key}`, phase: 'Verify', schema: VERIFY }).then((v) => ({ key: w.key, triage: t, verify: v })),
)

phase('Verify')
const write = await agent(`${COMMON}
Write the verified results (below) into the files, with python, keeping JSON valid and every existing key:
- /tmp/frbench/wave56-leftovers-triage.json: {items: [all final items of both waves]}.
- /tmp/frbench/handoffs.json: for each final item with disposition 'area', append it to handoffs[<area>] (create the key if missing). Prepend to "_about" one paragraph: waves 5 and 6 merged at ${HEAD}; ids W5-n / W6-n are their leftovers (triage file above); each is the area's to fix with a test or to report in not_done with a reason; check first that it is still true.
- /tmp/frbench/phaseE7-live-extra.md: every 'live-check' item as a step (what to do, what to expect), grouped by area, to run with the live check after wave 7 (/tmp/frbench/phaseE7-live.md).
- /tmp/frbench/owner-questions-wave56.md: the 'owner-decision' items as one-line questions with choices (empty list if none).
Return counts per disposition and per area.

Results: ${JSON.stringify(results.filter(Boolean).map((r) => ({ key: r.key, final: r.verify ? r.verify.final : r.triage.items, corrections: r.verify ? r.verify.corrections : [] })))}`, { label: 'write:wave56', phase: 'Verify' })

return { results, write }
