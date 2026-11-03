export const meta = {
  name: 'forerunner-live-fixes',
  description: 'Fix what the first real-model run found (intake plan rejected, oversized plans, chat blind to planning, bench not live-ready), review each independently, fix up; no merge',
  phases: [
    { title: 'Fix', detail: 'two owners in their own worktrees' },
    { title: 'Review', detail: 'independent reviewer per branch, with the real replies as fixtures' },
    { title: 'Fixup', detail: 'blocking review findings fixed on the branch' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app: a persistent AI project manager that turns a person's brief into a plan (the "intake"), delegates tasks to specialist agents and has a critic review them; React UI in apps/ui, local daemon in packages/runtime. This round fixes what makes the app not work for a person. Three fix waves on the stand-in model are merged or running. Tonight the app ran for the first time against the REAL Claude API, and the most important flow failed: creating a project from a brief showed "Planning failed" in 5 of 6 tries. Read /tmp/frbench/live1-report.md in full first: it is your problem list, with the exact texts the person saw.

The real intake replies are fixtures: /tmp/frbench/live1-fixtures.json (array of {line, model, stop_reason, usage, reply_text}; the first element may also carry the request {system, messages}). If that file is missing, say so in not_done and build fixtures from the report's description (reason fields of 603, 754 and 592 characters; docs strings that contain markdown code fences before the JSON's own end), but check again before you finish: it may arrive while you work. Copy what your tests need into the repo under the package's test fixtures; they are model output, with no secret in them.

Read before you start: docs/design/core-experience.md (the design target, especially §3.3 intake and the plan card, §3.9 chat, §5 writing rules); docs/decisions/0102-core-experience-round-decisions.md; AGENTS.md; docs/maintainers/validation.md (binding: test what the person sees and sends at the boundary they use; a changed daemon route gets a case in apps/ui/test/real-daemon.test.ts AND apps/ui/test/fake-daemon.ts changes in the same commit; persisted state tested across a restart; failing test first, then the fix; never weaken a test); scripts/bench/README.md.

Environment facts:
- THIS machine has no Claude API key: use the stand-in (--provider bench) and the fixtures. A helper session with the key will run the live check after your branch is merged; make that check easy (the bench must work with a real model).
- Other agents are working in parallel on branch fix/progress-navigation and fix/system-text (wave 3: the project status sentence, shell, Start dialog, session Updates and system-written texts, including the IntakeBanner's failed-state layout). Keep to your files; where you must touch a shared file, keep the change small and say so in notes_for_other_areas.
- 4 CPUs: at most one bench per agent; stop it when done. Never kill processes by name pattern (pkill -f); stop only PIDs you started, or use scripts/bench/stop.mjs. Use the ports given to you.
- Playwright: run the UI browser suite with a local config: \`cp /tmp/frbench/pw-local.config.template.ts apps/ui/playwright.local.config.ts && (cd apps/ui && npx playwright test --config playwright.local.config.ts)\`; never commit that file; never run "playwright install".
- Windows CI is several times slower than this machine and slow at starting processes (git): in tests, never rely on how long real work takes; wait for the event or the state with a generous limit (at least 10 s) and a message saying what you saw; leave nothing queued or running for the next test.
- Do not edit docs/status/UPDATE-LOG.md, CHANGELOG.md or docs/requirements.md (the session lead writes them from your report). DO update the maintainer doc of every module you change (docs/maintainers/*; the docs check requires it) and the user guide where behaviour the person sees changed.
- Commits: \`area: what changed\` with a body saying why, the root cause and the tests that failed before. End every commit message with these two lines:
${TRAILER}
  Every commit must carry a signature (the git config signs by default; check with \`git cat-file commit HEAD | grep -c '^gpgsig'\`).
- Never push. Never open pull requests.
- Validation before you report: pnpm check (lint, typecheck, unit, docs, secret scan), the UI vitest suite (cd apps/ui && npx vitest run --config vitest.config.ts), pnpm test:integration, pnpm test:e2e and Playwright as above; plus your bench walk.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    branch: { type: 'string' },
    head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    fixed: { type: 'array', items: { type: 'object', properties: {
      problem: { type: 'string' },
      failing_test_before: { type: 'string' },
      how: { type: 'string' },
      check_in_the_app: { type: 'string' },
    }, required: ['problem', 'failing_test_before', 'how', 'check_in_the_app'] } },
    not_done: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, why: { type: 'string' } }, required: ['problem', 'why'] } },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    live_check_steps: { type: 'string', description: 'exactly what the live helper should run and look at to confirm your fixes with the real model' },
    new_problems: { type: 'array', items: { type: 'string' } },
    notes_for_other_areas: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'branch', 'head_sha', 'commits', 'fixed', 'not_done', 'validation', 'live_check_steps'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix-needed'] },
    what_i_did: { type: 'string' },
    blocking: { type: 'array', items: { type: 'object', properties: {
      issue: { type: 'string' }, evidence: { type: 'string' }, where: { type: 'string' }, expected: { type: 'string' },
    }, required: ['issue', 'evidence', 'expected'] } },
    non_blocking: { type: 'array', items: { type: 'string' } },
    claims_checked: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, holds: { type: 'boolean' }, note: { type: 'string' } }, required: ['claim', 'holds'] } },
  },
  required: ['verdict', 'what_i_did', 'blocking'],
}

const AREAS = [
  {
    key: 'intake-live',
    port: 48210, ui: 1810,
    scope: `You own the intake: packages/runtime/src/session/intake.ts, packages/runtime/src/session/project-plan.ts, the intake prompt (find it from intake.ts; it may live under evals/registry or packages/runtime/src), the plan card's words (packages/runtime/src/daemon/request-words.ts plan part and the UI component that renders the plan card, IntakeCard or similar in apps/ui/src), the New project dialog (apps/ui/src/pages/NewProjectDialog.tsx) and the bench stand-in's intake role-player (testenv/src/bench/).
Fix, each with a failing test first:
1. BLOCKER: a plan is rejected because plan.reason (or any other prose field) is longer than the schema allows. A long explanation must never cost the person their plan. Tell the model every length limit in the prompt, AND accept an over-long prose field by shortening it at a sentence or word boundary (with an ellipsis) rather than rejecting the plan. Check every length limit in the plan schema the same way (task titles, outcomes, acceptance criteria, question texts, doc bodies) and decide per field: shorten prose, reject only what cannot be shortened safely. The fixtures at lines 1, 22, 24 and 25 must all become plan cards.
2. BLOCKER: parseIntakeReply takes the first \`\`\` fence anywhere in the reply, so a reply whose docs contain markdown code fences is parsed from a doc snippet and rejected as "not JSON". Parse the whole reply as JSON first; only if that fails, look for the fenced block that parses to an object with the plan's shape (try each fence, outermost/longest first), and strip a leading/trailing prose line. Fixtures 23 and 25 must parse.
3. When a reply still does not validate, retry once automatically, in the same intake, telling the model the exact validation errors in words, before the person ever sees "Planning failed". Count the retry's cost like any call. Test with the stand-in (make the bench role-player able to send an invalid first reply, e.g. an env flag FORERUNNER_BENCH_INTAKE_BAD=reason-too-long|fenced-docs|missing-tasks, documented in scripts/bench/README.md) and with fixtures.
4. MAJOR: the failure words must be true. "Claude's plan was missing parts Forerunner needs" was shown for a field that was too long. intakeFailureWords (or what the IntakeBanner shows) must name the real cause in the person's words ("Claude's plan could not be read", "Claude's plan was missing its tasks", "Claude did not answer", the usage limit, ...) and keep "Try again". Leave the banner's layout to wave 3's system-text (it changes 'Planning failed. Nothing was written.' + reason into one line); you own the cause words.
5. MAJOR: a one-line brief gets a plan that is too big (6 tasks over 3 milestones incl. reviewer, Docker deploy and writer-marketing tasks; ~5,600 output tokens; "Small-project mode: off" sent). Design §3.3: a short brief gets a small plan (1 to 3 tasks), no milestones beyond one, no deploy/reviewer/marketing task unless the brief asks for it, and the doc set scaffolded silently (short docs, or the model writes only the plan and Forerunner writes stub docs). Find how small-project mode is decided and turn it on for short briefs (say under ~200 characters and no list of features); make the prompt say what a small plan is. Test with the request the code builds (the prompt text and the mode flag) for a one-line brief and a long brief. You cannot run the real model: write in live_check_steps how the helper confirms the size.
6. MINOR: the brief for a coder asks for "committed in the project working tree" while the coder has no commit tool and did not commit. Make the outcome/acceptance the planner writes (prompt) and the coder's brief consistent with what the specialist can do (check the specialist registry for its tools; if the executor commits for it, say so in the brief instead).
7. POLISH, plan card: no separator between a task's title and "Needs Docker" ("…rendering\\"Needs Docker"); the ops-deploy task shows no cost and the total leaves it out (every task gets "about CHF x" or a plain "cost not known" and the total says what it covers); the decision record is pasted in full ("Status: proposed. The human reads this before approving.", "Answers: _pending_"): show only its decision in one or two sentences, with the full record one click away.
8. POLISH: the New project dialog refuses a one-line brief without a Goal. When the Goal is empty, use the brief's first sentence (shortened) as the goal, or make the goal optional, and say which in the dialog.
Run the bench (stand-in, with your bad-reply flag) through New project → the plan card → Approve and start, with screenshots before/after, and run the unit tests on every fixture.`,
  },
  {
    key: 'live-context',
    port: 48230, ui: 1830,
    scope: `You own what the chat is told about planning, how chat and session text render markdown, and the bench's live mode: packages/runtime/src/conversation/ (project-facts.ts and the context builder), apps/ui/src/components/Conversation.tsx and where session event lines are rendered, scripts/bench/ (journeys/smoke.cjs, lib.mjs, README.md) and the bench model-call log writer (find it from the --provider bench-live path in packages/runtime).
Fix, each with a failing test first:
1. MAJOR: the chat is not told the plan from the brief is drafting, waiting for approval or failed. Asked while planning had failed it said "The Quote page project has no tasks yet… I can add tasks…". The project facts the chat gets must carry the intake state in words (drafting: "The plan from your brief is being drafted."; waiting: "The plan from your brief waits for your approval in the Inbox."; failed: "Planning failed: <cause>. The person can press Try again on the project page.") and the reply rules must use it. Test: the context built for a project in each intake state (unit) and a real-daemon chat turn with the plan failed (fake/stand-in model: the request it receives carries the line). If the chat can retry the plan itself through an existing command, offer it; do not add a new command unless it is small and tested.
2. POLISH: raw markdown ("**…**", "**Summary**:") shows in chat replies and session event lines. Either render a safe subset (bold, italics, inline code, bullet and numbered lists, line breaks; never raw HTML) in the chat bubbles and session lines, or tell the models to write plain sentences and strip the markers where text is shown. Prefer rendering in the UI plus the plain-text instruction for the chat. Test in apps/ui (vitest) with a reply that contains them.
3. The bench with a real model (scripts/bench): smoke.cjs must not assume the stand-in's texts (task titles like "Create the page skeleton in index.html", "[stand-in model]" in the chat reply, file names script.js/styles.css, \`const QUOTES = [\`): check structure and states instead (a plan card with N≥1 tasks, Approve and start, a session that ends, files written, a chat reply that is not empty and names a task); when the project says planning failed, press Try again up to 2 times and report it as a finding; a check "every planned task is done" must fail on 0 of 0 tasks; the "plan card missing" finding must say what the project page said. It must still pass 100% on --provider bench. Add a --live flag or detect bench-live from bench.json.
4. The model-call log has no cost: add usd (and the price row used) to each line from the app's own price table (packages/billing/src/pricing.ts), and a short summary script or flag that prints total calls and USD by kind (intake, specialist, critic, chat), so the live helper can keep to its spend cap without its own script. Never log a key: test that a call made with a key in the environment writes no part of it.
5. The setup's Done step says "Until Claude is connected your agent cannot start work" on a bench-live install that has a key. Find out whether that sentence is true for a real install with a key (then fix the condition) or bench-only (then make the bench pass the key the way the app reads it).
Run the bench (stand-in) through the smoke journey before and after; run the smoke journey with a bench-live dry run if possible (it must fail fast and clearly without a key, not hang).`,
  },
]

const fixPrompt = (a) => `${COMMON}
You are the owner of fix "${a.key}", working in your own git worktree (you start on ${BRANCH} at its current tip). First create and check out branch fix/${a.key} in your worktree. Bench ports for you: daemon ${a.port}, UI ${a.ui}; bench name fix-${a.key}.

${a.scope}

Report with the schema: fixed (each with the test that failed before, how, and the steps a person takes in the app to see it), not_done with reasons, validation commands with results, live_check_steps (what the live helper should do with the real model to confirm each fix, with expected texts), new_problems and notes_for_other_areas.`

const reviewPrompt = (a, fix) => `${COMMON}
You are an independent reviewer for fix "${a.key}". You did not write it; be skeptical and verify everything yourself. Work in your own worktree: \`git checkout --detach fix/${a.key}\`. Bench ports for you: daemon ${a.port + 5}, UI ${a.ui + 5}; bench name review-${a.key}.

The fix's scope was:
${a.scope}

The fixer's report: ${JSON.stringify(fix).slice(0, 30000)}

Check: (1) each claimed fix with its test, by reading the diff (git diff ${BRANCH}...fix/${a.key}) and running the tests; (2) the real replies in /tmp/frbench/live1-fixtures.json: run every intake reply through the fixed parser/validator and confirm each becomes a plan the person can approve (or, for live-context, that the chat context lines are right for each intake state); (3) the person's journey on the bench (stand-in), clicking in the UI with scripts/bench/recorder.cjs, including the failure path the fix added a bench flag for; (4) that no test was weakened, the docs check passes, maintainer docs were updated, and that nothing in the change could log or show a key; (5) design §5 writing rules for every new text. A finding is blocking when the person would still see the problem, a claim does not hold, a test is missing for a claimed fix, or the validation rules are broken. Stop your bench when done.`

const fixupPrompt = (a, fix, review) => `${COMMON}
You finish fix "${a.key}". The fixer's work is on branch fix/${a.key}; an independent reviewer found blocking problems. Work in your own worktree: \`git checkout fix/${a.key}\` (the branch, not detached) and commit on it. Bench ports: daemon ${a.port + 10}, UI ${a.ui + 10}; bench name fixup-${a.key}.

The scope was:
${a.scope}

Fixer's report: ${JSON.stringify(fix).slice(0, 20000)}

Reviewer's findings: ${JSON.stringify(review).slice(0, 20000)}

Fix every blocking finding with a failing test first; fix the non-blocking ones that are small and in scope. Re-run the full validation. Report with the schema (fixed lists only what you fixed in this pass; head_sha is the branch's new tip).`

phase('Fix')
const results = await pipeline(
  AREAS,
  (a) => agent(fixPrompt(a), { label: `fix:${a.key}`, phase: 'Fix', schema: FIX_SCHEMA, isolation: 'worktree' }),
  async (fix, a) => {
    if (!fix) return { key: a.key, fix: null }
    const review = await agent(reviewPrompt(a, fix), { label: `review:${a.key}`, phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree' })
    let fixup = null
    if (review && review.verdict === 'fix-needed' && review.blocking.length > 0) {
      fixup = await agent(fixupPrompt(a, fix, review), { label: `fixup:${a.key}`, phase: 'Fixup', schema: FIX_SCHEMA, isolation: 'worktree' })
    }
    return { key: a.key, fix, review, fixup }
  },
)
log(results.map((r) => `${r?.key}: review=${r?.review?.verdict ?? 'none'} fixup=${r?.fixup ? 'yes' : 'no'}`).join('; '))
return { results }
