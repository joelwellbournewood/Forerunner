export const meta = {
  name: 'live-check-2',
  description: 'Live check 2 after wave 7: three journeys with the real model and forerunner-sandbox (cap USD 7.25), then a code-level verification of each finding',
  phases: [{ title: 'Live', detail: 'github, run, research journeys with the real model' }, { title: 'Verify', detail: 'confirm each finding at 7d54fff without the real model' }],
}

const REPO = '/home/user/Forerunner'
const BASE = '7d54fff'

const COMMON = `Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0 at ${BASE}) is a desktop app: a persistent AI project manager that plans work, delegates tasks to specialist agents, has a critic review them, and opens pull requests. Wave 7 (groups 1 to 6) is merged; this is LIVE CHECK 2: the merged app with the REAL Claude model (and real GitHub where a step needs it). The design target is docs/design/core-experience.md (states, one-line explanations, the writing rules in §5); read it, and scripts/bench/README.md (the bench: real daemon + real UI; --provider bench-live is the real Messages API with a model-call log; calls.mjs prints spend; the journeys in scripts/bench/journeys/). You test as a person would, through the UI (Playwright scripts against the bench's UI) and its routes, and you keep evidence.

Work in the MAIN checkout ${REPO} read-only: do not edit, commit or push anything in the repository (no code fixes: a failure is a finding). Write your scripts and evidence under /tmp/frbench/live2/<your journey>/. Do not run git commands that change the main checkout.

SECRETS (binding):
- The Anthropic API key is in the environment as FORERUNNER_ANTHROPIC_API_KEY. Pass it ONLY as a prefix on the bench start: \`ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node scripts/bench/start.mjs ... --provider bench-live\`. Where a step needs the key typed into the app (Settings, the setup assistant), a Playwright script types it from process.env.FORERUNNER_ANTHROPIC_API_KEY, takes NO screenshot while the field holds it, and never logs it.
- The GitHub token for the sandbox is FORERUNNER_TEST_GITHUB_TOKEN: enter it in the app's UI from the environment the same way (no screenshot of the field, never printed). Use it ONLY for joelwellbournewood/forerunner-sandbox; do not create, rename or delete repositories (a repository card is answered No), do not change branch protection.
- Never print, echo, log or write either value; check them only with \`test -n\`. Never use the environment's GH_TOKEN, GITHUB_TOKEN or ANTHROPIC_BASE_URL for the app.
- Do not use the session's GitHub tools for anything but reading forerunner-sandbox's state (curl with the sandbox token for GitHub's REST API is fine for reading PRs, commits, merging on "GitHub's website" steps, closing PRs you opened).

Rules:
- SPENDING CAP: your journey's cap is given below. Check spend with \`node scripts/bench/calls.mjs --name <bench> --cap <usd>\` after each step (it exits 3 at the cap); for the routed provider (no --provider), read the app's Costs tab and the ledger. Keep about 15% for one retry. At the cap, stop at a clean point and report what was left.
- 4 CPUs are shared with other journeys: one bench at a time per journey, stopped (scripts/bench/stop.mjs) when you are done with it. Never kill processes by name pattern; stop only PIDs you started.
- Ports: use only your range (below). Bench names start with your journey's name.
- Real model: a failure cannot be forced. A step that needs one (a hand-over, a retry, a usage limit) is 'not_seen' unless it happens; the bench walks of the areas stand for it.
- Subscription (Claude Code) steps cannot run here (no subscription token in the cloud); Windows-only steps neither. Mark them 'not_possible_here' and list them under owner_checklist_items.
- Words: wave 7 changed many sentences on purpose (polish-words, polish-screens, the tail areas). Where a quoted line changed, expect the merged words and judge the meaning and design §5, not the old text.
- A finding is something a person would see go wrong, or a promise the app breaks (an action that does not do what its line says, a number that disagrees with another screen, a state that never ends, words that break design §5, a security or data-loss problem). Give each its evidence (screenshot path, response JSON, log lines, model-call log entries) and the steps to reproduce. Severity: blocker (data loss, security, the main journey cannot be completed), major (a promise broken, a wrong state, money wrong), minor (works but confusing), words (§5 only).
- Before you finish: stop every bench you started; keep homes and evidence (the session lead deletes them later); close every pull request on forerunner-sandbox that your journey opened and left open (say which), unless a step says to leave it for the session lead.`

const JOURNEYS = [
  {
    key: 'github', cap: 2.75, ports: 'daemon 48900-48909, UI 2400-2409',
    steps: `Your steps (all need forerunner-sandbox; run them one after another, they share its main):
1. /tmp/frbench/phaseE7-live.md §1 "Merging on forerunner-sandbox" in full (first chain; Open this version; Merge on the last PR; Files; Take this work out; second chain with Squash and merge on GitHub's website and its take-out; automatic mode; Local only).
2. /tmp/frbench/phaseE7-live.md §3 case 2 (the wrap-up case in a repository project: the work-in-progress commit stays on the PC, nothing pushed, no PR while paused).
3. /tmp/frbench/phaseE7-live-extra.md §6 "decisions" steps that need GitHub (C-57's status pull request setting, L-16), reusing the projects above where you can.
4. From /tmp/frbench/phaseE7-live-w12w14.md, the steps that need GitHub: "wave 12 leftovers7-merge" (R-branch two same-titled tasks, R-rebuildcard after a second chain, R-repooffer answered No, R-mergeretry/R-queuedwords as its "Review notes for the live check" say), "wave 14 leftovers7-merge2" (R-conflict, R-copystuck, the notification for a later merge; R-chain only if the run gives you a chain of three), and both "fix-up" sections for merge and merge2 (the conflict notice's Redo; a conflict resolved on GitHub with a commit).
5. Wave 13 leftovers7-tailmerge's LIVE steps: read /tmp/frbench/wave7g6d-fix-leftovers7-tailmerge.json and wave7g6d-fixup-leftovers7-tailmerge.json (fixed[].check_in_the_app): TM-1 (a redo from main that changes nothing closes its PR), TM-2 ('I resolved it' with a rebase in progress), TM-4 (a merge held by changes left in the task folder says why), TM-7, TM-8 (Create a repository dialog: Preview then ×: no card left; NEVER press Yes).
Order them so one project's state feeds the next; skip a step that would need more money than is left, and say so.`,
  },
  {
    key: 'run', cap: 2.5, ports: 'daemon 48920-48929, UI 2420-2429',
    steps: `Your steps (no GitHub; folder projects):
1. /tmp/frbench/phaseE7-live.md §2 "Credentials" (routed provider: no --provider flag, a key-shaped invalid key written into the bench's file vault, then the real key typed into Settings from the environment; the waiting task starts by itself) and its research plan-card screenshot.
2. /tmp/frbench/phaseE7-live.md §3 cases 1, 3 and 4 (budgets in a folder project: the wrap-up, the tiny budget, Cancel with a dependent) — scripts/bench/journeys/budget.cjs helps.
3. /tmp/frbench/phaseE7-live.md §5 "Costs": \`node scripts/bench/journeys/smoke.cjs <bench> --live\` on a fresh bench-live bench (estimate vs real cost per task within about x2, cache reads after each task's first call, the Start dialog).
4. /tmp/frbench/phaseE7-live-extra.md §1 answers, §2 screens, §3 noise, §4 stops (reuse runs where it says so).
5. From /tmp/frbench/phaseE7-live-w12w14.md: "wave 12 leftovers7-session" steps that work on the API key (R-criticbudget, R-waitqueue only if a wait happens, R-recovery: kill the daemon by its PID mid-session and restart it, R-sessreview, R-estimates: the plan card's figure equals the Start dialog's), the "Review notes for the live check" chat line-first check (a project with several tasks and a last session: three chat lines, each reply answers its line), and "wave 14 leftovers7-web" R-sandbox on Linux as root (the log line names the sandbox; a second daemon on the same home: browser unavailable, no unsandboxed line).
6. Wave 13 leftovers7-tailrun's steps that need no subscription (read /tmp/frbench/wave7g6d-fix-leftovers7-tailrun.json fixed[].check_in_the_app): TR-2 (opening the Start dialog records no wait), TR-3, TR-11 (New task's runs-on line follows the typed words), TR-12 (Start while the plan is drafted), TR-14 (a review paused at a budget says the work is done), and polish-words / polish-screens steps that read the real model's output (/tmp/frbench/wave7g6d-fixup-polish-words.json and wave7g6d-fix-polish-screens.json, wave7g6d-fixup-polish-screens.json check_in_the_app): the Tasks screen, the Inbox cards, the money words, Settings in CHF.`,
  },
  {
    key: 'research', cap: 2.0, ports: 'daemon 48940-48949, UI 2440-2449',
    steps: `Your steps (no GitHub):
1. /tmp/frbench/phaseE7-live.md §4 "Research with web search" in full (the brief, the model-call log's web_search tool and lists, server blocks back byte for byte, web_fetch, the search's price, cache reads, the report citing only pages it opened, the review's sources, the cost against USD 1.32, then "Only these websites: developer.mozilla.org").
2. From /tmp/frbench/phaseE7-live-w12w14.md "wave 14 leftovers7-web": R-failopen (the stored only list set to ['10.1.2.3'] in the bench's state DB: no web search offered, the daemon log line, every page outside the list 'Not read'; and ['github.io']: 'Research reads: only github.io') and R-researchreads (the Overview's line follows a change made in chat, without a reload).
3. Wave 13 leftovers7-tailrun TR-5 (the planner's line for an empty 'only' list: a research brief planned under an empty only list plans no research that needs a website) and TR-9 if not covered by step 2.
4. /tmp/frbench/phaseE7-live-extra.md §5 asking and §7 verification. §7 may need the Docker full review: you may start a private dockerd as root (\`dockerd --host unix://<dir>/docker.sock --data-root <dir>/data --exec-root <dir>/exec --pidfile <dir>/docker.pid --iptables=false --ip6tables=false --bridge=none --storage-driver=vfs\`, <dir> under /tmp/frbench/live2/research/, DOCKER_HOST=unix://<dir>/docker.sock; base image mirror.gcr.io/library/node:22-bookworm-slim, the runner image as scripts/sandbox-full-review.mjs and docs/maintainers/testing.md describe; stop it by its PID and delete <dir> when done; vfs copies every layer: watch the disk, keep it above 8 GB free). If Docker cannot be made to work, mark those steps not_possible_here with why.`,
  },
]

const LIVE_SCHEMA = {
  type: 'object',
  properties: {
    journey: { type: 'string' },
    benches: { type: 'array', items: { type: 'string' } },
    spend_usd: { type: 'number' },
    steps: { type: 'array', items: { type: 'object', properties: {
      source: { type: 'string' }, step: { type: 'string' },
      result: { type: 'string', enum: ['pass', 'fail', 'partial', 'not_seen', 'not_possible_here', 'skipped_cap'] },
      observed: { type: 'string' }, evidence: { type: 'string' },
    }, required: ['source', 'step', 'result', 'observed'] } },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'words'] },
      title: { type: 'string' }, what_the_person_sees: { type: 'string' }, expected: { type: 'string' },
      evidence: { type: 'string' }, repro: { type: 'string' }, suspected_cause: { type: 'string' },
    }, required: ['id', 'severity', 'title', 'what_the_person_sees', 'expected', 'evidence', 'repro'] } },
    owner_checklist_items: { type: 'array', items: { type: 'string' } },
    sandbox_cleanup: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['journey', 'spend_usd', 'steps', 'findings', 'owner_checklist_items', 'sandbox_cleanup'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    real: { type: 'boolean', description: 'true if the code at the base explains the finding (or it reproduces on the stand-in bench); false if it is a misreading, a test artefact or the model alone' },
    model_only: { type: 'boolean', description: 'true if the app behaved as designed and only the model chose differently (no code fix)' },
    root_cause: { type: 'string' },
    where: { type: 'string', description: 'file:line at the base' },
    fix_sketch: { type: 'string' },
    failing_test_idea: { type: 'string', description: 'the boundary test that fails today' },
    area_hint: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['id', 'real', 'model_only', 'root_cause', 'where', 'fix_sketch', 'failing_test_idea'],
}

const results = await pipeline(
  JOURNEYS,
  (j) => agent(`${COMMON}

YOUR JOURNEY: "${j.key}". Spending cap: USD ${j.cap.toFixed(2)}. Ports: ${j.ports}. Evidence folder: /tmp/frbench/live2/${j.key}/.

${j.steps}

Report every step you took (pass/fail/partial/not_seen/not_possible_here/skipped_cap) with what you observed and the evidence path, every finding with its evidence and repro, your total spend, the owner's-checklist items (subscription or Windows steps), and what you closed on forerunner-sandbox.`, { label: `live:${j.key}`, phase: 'Live', schema: LIVE_SCHEMA }),
  (live, j) => {
    if (!live) return { journey: j.key, live: null, verified: [] }
    const toVerify = (live.findings || []).filter((f) => f.severity !== 'words')
    return parallel(toVerify.map((f) => () => agent(`You verify one finding of Forerunner's live check 2 against the code at ${BASE} (main checkout ${REPO}; read-only: do not edit, commit or push; you may run unit tests and the stand-in bench, \`node scripts/bench/start.mjs --provider bench\`, on ports ${j.key === 'github' ? '48960-48964 / UI 2460-2464' : j.key === 'run' ? '48965-48969 / UI 2465-2469' : '48970-48974 / UI 2470-2474'}, stopped when done; never the real model or real GitHub). Read docs/design/core-experience.md for what the person should see.

The finding (from journey "${j.key}", which ran the real model; its evidence is under /tmp/frbench/live2/${j.key}/):
${JSON.stringify(f, null, 1)}

Decide: is it real (the code explains it, or it reproduces on the stand-in), is it the model alone (the app did what it is designed to do; the model chose differently, so no code fix), or a misreading/test artefact? Find the root cause with file:line, sketch the fix, and name the failing test at the person's boundary that would prove it. Default to skeptical: if the evidence does not support the claim, say real=false and why.`, { label: `verify:${f.id}`, phase: 'Verify', schema: VERIFY_SCHEMA })))
      .then((vs) => ({ journey: j.key, live, verified: vs.filter(Boolean) }))
  },
)
const total = results.filter(Boolean).reduce((s, r) => s + ((r.live && r.live.spend_usd) || 0), 0)
log(`Live check 2: total spend USD ${total.toFixed(2)}`)
return { results, total_spend_usd: total }
