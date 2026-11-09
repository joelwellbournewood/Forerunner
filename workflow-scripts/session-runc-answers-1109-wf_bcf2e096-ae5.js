export const meta = {
  name: 'runC-answers-1109',
  description: "Fold the owner's answers to the ten questions (2026-11-09 evening) into run C's plan for C2-C6 and write the wave 8 re-plan brief; adversarial check; revise",
  phases: [{ title: 'Revise' }, { title: 'Check' }, { title: 'Finish' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '7d6b34a'

const CONTEXT = `Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${HEAD} plus run C sub-run C1 being built in worktrees right now). Run C builds the owner's decisions of 2026-11-09 in six sub-runs C1 to C6; its plan is /tmp/frbench/runC-plan.json (areas[] with the area specs, sub_runs, shared_files, adr_plan, u_entries, design_doc_changes, wave8_amendments, live_check_4, owner_questions, session_lead_decisions). C1 (d1109-chat-guard, d1109-oversize-start, d1109-sessions) is being built from its current spec: DO NOT change C1's three area specs (their fixers and reviewers read them now). C2 to C6 have not started.

Read whole: /tmp/frbench/owner-decisions-2026-11-09.md, especially its last section 'Answers to the ten questions, 2026-11-09 ~20:05 UTC' (verbatim answers and the session lead's reading; it overrules everything earlier), then /tmp/frbench/runC-plan.json, then wave 8's spec /tmp/frbench/collab/collab-areas.json with /tmp/frbench/collab/owner-summary.md, and docs/design/core-experience.md section 5 (the writing rules). Read-only on the repository: no edits, commits or pushes; keep every shell command inside ${REPO} or /tmp/frbench (cd ${REPO} first).`

const TASK = `Fold the answers into run C's plan for C2 to C6, and write the wave 8 re-plan brief:
1. Answer 1 (D9, collaboration through GitHub): d1109-onerepo-link (C2): for a repository whose project is used on another computer (found from the repository), the offer is to work on it together as the same project (this Forerunner adopts that project's id from the repository; nothing is taken over; nothing is written into the other person's pull requests), never a second project and never a take-over of a project someone else uses; keep a take-over only for a project nobody uses any more (the person's own reinstall included), as today's 14-day rule says. Say what run C builds now (the recognition and the same-project link, with words that promise only what exists) and what wave 8 builds (seeing each other's work through the status issue, claims, the repository guide). d1109-onerepo-join (C4) and any area that says 'take it over' or 'another computer' follow. Remove the owner question it answers.
2. Answer 2 (chat thinking longer): d1109-chat-depth (C3): no daily cap of chat's own (the budgets and the monthly cap still bound it); thinking longer on the same model goes ahead as needed; before switching to a stronger model, or an answer expected to cost more than CHF 0.10, chat asks in one line with the cost and the time and goes on only on yes; the model is chosen by the need, never above the project's highest model. Remove the questions it answers.
3. Answer 3: the yes covers all work and chat until the stop ends (as built): remove the question.
4. Answer 4: d1109-cred-engine (C5) and d1109-cred-screens (C6): one order for every call (tasks, chat, planning, reviews, the task check, jobs), the person's, set in one clean options menu; until the person picks, the default preset for everything; no hidden split (remove CALL_FALLBACK_ORDER's separate order); migration keeps an explicit earlier choice. Remove the questions it answers.
5. Answer 5: the larger task runs in its normal turn (priority, then the plan's order) like any task, works until the wrap-up line, wraps up and continues next time. C1's d1109-oversize-start builds a hold ('after the work that fits, one a session'); add to d1109-oversize-pause (C2) one item, first in its order, that removes that hold and the sentences that say it (plan card, Start dialog, chat, the result), with its failing test at the boundary and a restart case; keep everything else d1109-oversize-pause does. Remove the question.
6. Answer 6: the calibration stays monthly and shows on the run indicator (d1109-run-visible, C5) with words saying what it does; remove the question.
7. Answers 7, 8, 9: the defaults are confirmed: remove those questions (keep the behaviour).
8. Update shared_files, adr_plan, u_entries, design_doc_changes and live_check_4 where these change them; keep the sub-run order unless a change forces it (say why).
9. Wave 8 re-plan brief: write /tmp/frbench/wave8-replan-brief.md: what the owner's answer 1 changes in wave 8's 16 areas (collab-areas.json): which areas stay, which change (a shared database or server is no longer required: every person runs their own Forerunner with their own credentials; GitHub is the meeting place: one project per repository, the status issue as the noticeboard, claims, the repository guide), which go, and the open questions for the wave 8 planner. It is a brief for a later planning step, not the plan itself.

Write the revised plan to /tmp/frbench/runC-plan.json (back it up first as /tmp/frbench/runC-plan.before-answers.json) with a new field 'answers_1109_changes' listing every change made, and return the summary.`

const SUMMARY = {
  type: 'object',
  properties: {
    changed_areas: { type: 'array', items: { type: 'string' } },
    removed_questions: { type: 'number' },
    remaining_questions: { type: 'array', items: { type: 'string' } },
    wave8_brief: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['changed_areas', 'removed_questions', 'remaining_questions', 'wave8_brief'],
}

phase('Revise')
const rev = await agent(`${CONTEXT}\n\n${TASK}`, { label: 'revise', phase: 'Revise', schema: SUMMARY })

phase('Check')
const check = await agent(`${CONTEXT}

Check adversarially the revision just made to /tmp/frbench/runC-plan.json (the version before it: /tmp/frbench/runC-plan.before-answers.json) and /tmp/frbench/wave8-replan-brief.md. The task was:
${TASK}

Its summary: ${JSON.stringify(rev)}

Find what is wrong: an answer not built, or built against the owner's words (quote them); C1's three specs changed (diff them: they must be identical); a contradiction left between areas, or with the sub-run order (an area needing code from the same or a later sub-run); a sentence that promises more than the app does (e.g. 'work together' words that promise wave 8's features); money and the person's control (chat asking before a stronger model or an answer over CHF 0.10; no cap passed; one order for every call); questions removed that are not answered, or answered ones left. Do not edit the files; return findings.`, { label: 'check', phase: 'Check', schema: {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['ok', 'needs-changes'] }, findings: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['verdict', 'findings'],
} })

phase('Finish')
const fin = await agent(`${CONTEXT}

Finish the revision of /tmp/frbench/runC-plan.json and /tmp/frbench/wave8-replan-brief.md. The task was:
${TASK}

An adversarial check found: ${JSON.stringify(check)}

Verify each finding against the owner's words, the files and the code at ${HEAD}; fix the ones that hold (never change C1's three area specs); say why for any you reject. Rewrite the files and return the summary.`, { label: 'finish', phase: 'Finish', schema: SUMMARY })

return { rev, check, fin }