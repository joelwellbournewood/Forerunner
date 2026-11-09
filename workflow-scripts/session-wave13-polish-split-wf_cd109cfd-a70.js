export const meta = {
  name: 'wave13-polish-split',
  description: 'Split the 34 polish problems plus 34 new polish items into two areas with disjoint files for wave 13, then adversarially check the split',
  phases: [{ title: 'Split', detail: 'locate each item, assign to polish-words or polish-screens' }, { title: 'Check', detail: 'completeness, disjointness, evidence at HEAD' }],
}
const COMMON = `Context: Forerunner (main checkout /home/user/Forerunner, branch claude/nifty-knuth-f9udt0, HEAD fa1a86f; a wave named wave 12 is running in other worktrees, ignore them and read the main checkout) is a desktop persistent AI project manager (React UI apps/ui, daemon packages/runtime, capabilities packages/capabilities, commands packages/commands, critic packages/critic). Read-only task: do NOT edit, stage or commit anything in the repository; write only the output file named below (with node or python3).

Inputs:
- /tmp/frbench/phaseE.json areas[key=polish]: the polish area (34 problems, decisions, u_entries, root_causes, fix_scope, files, acceptance, depends_on, handoff_items, owner_questions, size). Its triage items: phaseE.json triage[] with area 'polish'; phase C leftovers for it: /tmp/frbench/handoffs.json key 'polish'.
- /tmp/frbench/wave7g6-triage.json: polish_add[] (34 new items, each '[polish]/[minor] <what the person sees>' with evidence) and items[] with category polish_existing / polish_add (sources, evidence, test_idea).
- The design (docs/design*.md or wherever the repo keeps it; section 5 is the wording rules: one sentence a person reads at a glance, CHF everywhere, no ids, one button per action).
Wave 13 runs these items after wave 12 (leftovers7-merge, leftovers7-session, leftovers7-web; their specs are also in phaseE.json) merges; the shared_files strings in phaseE.json mentioning 'polish' say which parts of shared files polish owns.`

const AREA_SHAPE = 'phaseE.json area shape: {key, title, problems[] (strings starting with [minor]/[polish] and the evidence file:line at HEAD), decisions[], u_entries[], root_causes[], fix_scope (string), files[], acceptance[] (each an observable check at the person\'s boundary or a named failing test), depends_on[], handoff_items[], owner_questions[], size}'

phase('Split')
const split = await agent(`${COMMON}

Task: split all polish work for wave 13 into TWO areas that can run in parallel on disjoint files:
- 'polish-words': every sentence produced in packages/** (runtime *-words.ts, request-words.ts, task-words.ts, event-lines.ts, result.ts, push-words.ts, critic text, settings display, budget words, ...) plus docs (CHANGELOG.md, docs/maintainers/*.md, docs/user-guide.md, validation.md).
- 'polish-screens': everything in apps/ui/src/** (pages, components, Shell, Settings page, Start dialog, Costs, session page, task-actions.ts explains, layout, buttons, links, scrolling).
Items: the 34 polish problems + the 34 polish_add items (+ check the 5 polish_existing really are inside one of the 34). For EACH item: find where it lives at HEAD (file:line now, the code may have moved since the evidence was written), confirm it is still present (if it is already fixed or not a problem at HEAD, put it in dropped with evidence), and assign it to exactly one area by where its change mostly lies. An item that needs a change on both sides goes to one area, and the other side's file change is limited to a named function, recorded in shared_files as a string '<file>: <area> owns ...; <other area> may change only <function>'. Keep such cross items few. apps/ui/test/real-daemon.test.ts and apps/ui/test/fake-daemon.ts are append-only for both (own describe block). Balance the two areas roughly.

Carry over from the polish area to the right new area: its decisions, u_entries, root_causes, acceptance, handoff_items and owner_questions (split by item), and adapt its fix_scope (one commit per screen or per words file, each wording asserted at its boundary, design §5 rules, CHF only). Problems keep their original id tags (e.g. 'later #53', 'L-9', 'C-19', 'R-2') and polish_add items get a tag 'P7-<n>' (n = their index in polish_add, 1-based) so a reviewer can trace them.

Write /tmp/frbench/wave7g6b-areas.json:
{ "base": "fa1a86f", "areas": [ two objects in the ${AREA_SHAPE} ], "shared_files": [strings], "assignment": [ {item_tag, source ('polish#<n>' or 'polish_add#<n>'), area, files[] (file:line at HEAD)} for every item ], "dropped": [ {item_tag, source, why, evidence} ] }
Return a short summary: counts per area, cross items, dropped items with one-line reasons.`, { label: 'split', phase: 'Split' })

phase('Check')
const check = await agent(`${COMMON}

An agent wrote /tmp/frbench/wave7g6b-areas.json, a split of wave 13's polish work into 'polish-words' and 'polish-screens'. Its summary: ${split}

Check it adversarially and FIX the file in place where it is wrong (write it back with node or python3; keep the same shape):
1. Completeness: every one of the 34 polish problems (phaseE.json areas[key=polish].problems) and all 34 wave7g6-triage.json polish_add items appear exactly once in assignment[] (or in dropped[] with evidence). List any missing or duplicated, and fix.
2. Disjoint files: list every file each area's assignment touches; any file in both areas must be covered by a shared_files string naming who owns what (a named function for the other side). Move items to remove needless overlap.
3. Evidence at HEAD: for at least 25 items (all the dropped ones, and every [minor] item), open the file:line and confirm the problem is still there and the location is right; correct locations; move an item wrongly dropped back into an area.
4. Each area object is complete (title, problems, root_causes, fix_scope, files, acceptance with an observable check per problem or group of problems, depends_on naming wave 12, size) and the problems text carries enough evidence for a fixer to start.
Return a short report: what you changed, final counts per area, the cross files, and anything you could not resolve.`, { label: 'check', phase: 'Check' })
return { split, check }
