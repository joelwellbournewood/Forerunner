export const meta = {
  name: 'live-check-3',
  description: 'Live check 3 of wave 15 (7d6b34a): three journeys with the real model and forerunner-sandbox (cap USD 3.00), then a code-level verification of each finding at 7d6b34a and at the current head',
  phases: [{ title: 'Live', detail: 'github, run, research journeys with the real model' }, { title: 'Verify', detail: 'confirm each finding without the real model' }],
}

const REPO = '/home/user/Forerunner'
const CHECKOUT = '/home/user/Forerunner/.claude/worktrees/live3-7d6b34a'
const BASE = '7d6b34a'
const HEAD = '112227c'

const COMMON = `You run part of LIVE CHECK 3 of Forerunner: the app at ${BASE} (wave 15 merged: runs A and B), used as a person would, with the REAL Claude model and REAL GitHub (forerunner-sandbox), reporting what a person would see go wrong. The repository owner asked for these live checks (docs/status/handoff/NEXT-SESSION.md, owner-approved plan; USD 40 of API spend for live checks, about USD 10 spent before this one) and renewed the GitHub test token for this check.

Read FIRST, whole: /tmp/frbench/live3/BRIEF.md. It is binding, with these overrides for you:
- The checkout at ${BASE} is ready at ${CHECKOUT} (pnpm install done; the Playwright local config copied). Start every bench from there (\`cd ${CHECKOUT} && ... node scripts/bench/start.mjs ...\`). Do NOT edit, commit or push anything in it or in the main checkout ${REPO}, and run no git command that changes either. Keep every shell command inside ${CHECKOUT}, ${REPO} or /tmp/frbench (cd there first; never end a command elsewhere).
- The plan files are already in /tmp/frbench (do not re-extract them). Live check 2's helper scripts for your journey are in /tmp/frbench/live3/<your journey>/live2-scripts/ (adapt them; written for 7d54fff).
- Your evidence folder is /tmp/frbench/live3/<your journey>/. You report through the structured output below, not as a JSON text reply; quote the evidence that matters in it.
- forerunner-sandbox has NO open pull requests from earlier benches any more: #1, #2, #3, #5, #6 and #7 were closed with the owner's OK on 2026-11-09. Ignore the brief's lines saying they are open.
- GitHub: start the bench WITHOUT NODE_USE_ENV_PROXY so the daemon reaches GitHub directly with the renewed token (it answers 200 here); the steps' words 'GitHub via the proxy' mean 'GitHub with the real token'. If GitHub answers 401, stop the GitHub steps and report it.
- Spending: your journey's own cap is given below; the whole live check's cap is USD 3.00 with the brief's drop order. Check spend after each step (\`node scripts/bench/calls.mjs --name <bench> --cap <usd>\` from ${CHECKOUT}). Start no new step once your spend reaches 87% of your cap.
- Other journeys run beside yours on this 4-CPU machine: one bench at a time per journey, stopped with scripts/bench/stop.mjs when done; never kill processes by name pattern, only PIDs you started; use only your ports.

The steps are in /tmp/frbench/live3/steps.json: do the ones whose journey is yours, in priority order (1, then 2, then 3); an entry with addition: true revises or extends the step with the same id. The sources they cite are in /tmp/frbench (phaseE7-live*.md, wave15a-*.json, wave15b-*.json, wave15-areas.json, wave15b-areas.json). Before you finish: stop every bench you started; close every pull request on forerunner-sandbox your journey opened and left open (say which), unless a step says to leave it.`

const JOURNEYS = [
  { key: 'github', cap: 1.2, ports: 'daemon 48900-48909, UI 2400-2409', extra: 'Also do the brief\'s extra step G0 first (the setup assistant connects GitHub with the token typed from the environment; no screenshot of the field). Order your steps so one project\'s state feeds the next.' },
  { key: 'run', cap: 0.8, ports: 'daemon 48920-48929, UI 2420-2429', extra: 'No GitHub: folder projects.' },
  { key: 'research', cap: 1.0, ports: 'daemon 48940-48949, UI 2440-2449', extra: 'No GitHub. X9 (Docker full review) and B1 (the agent browser) are priority 3 and opportunistic: skip them with not_possible_here if they cannot be set up cheaply.' },
]

const LIVE_SCHEMA = {
  type: 'object',
  properties: {
    journey: { type: 'string' },
    benches: { type: 'array', items: { type: 'string' } },
    spend_usd: { type: 'number' },
    steps: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, step: { type: 'string' },
      result: { type: 'string', enum: ['pass', 'fail', 'partial', 'not_seen', 'not_possible_here', 'skipped_cap'] },
      observed: { type: 'string' }, evidence: { type: 'string' },
    }, required: ['id', 'step', 'result', 'observed'] } },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'words'] },
      title: { type: 'string' }, step: { type: 'string' }, what_the_person_sees: { type: 'string' }, expected: { type: 'string' },
      evidence: { type: 'string' }, repro: { type: 'string' }, suspected_cause: { type: 'string' },
    }, required: ['id', 'severity', 'title', 'what_the_person_sees', 'expected', 'evidence', 'repro'] } },
    sandbox_prs: { type: 'object', properties: { opened: { type: 'array', items: { type: 'string' } }, closed: { type: 'array', items: { type: 'string' } }, left_open: { type: 'array', items: { type: 'string' } } } },
    owner_checklist_items: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['journey', 'spend_usd', 'steps', 'findings', 'owner_checklist_items'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    real: { type: 'boolean', description: 'true if the code at the base explains the finding (or it reproduces on the stand-in bench); false if it is a misreading, a test artefact or the model alone' },
    model_only: { type: 'boolean' },
    root_cause: { type: 'string' },
    where: { type: 'string', description: 'file:line at the base' },
    still_at_head: { type: 'string', enum: ['yes', 'no', 'changed', 'unknown'], description: `whether it still holds at ${HEAD} (run C step 1 merged: chat treats records as data, oversized tasks start, the sessions list)` },
    head_note: { type: 'string' },
    fix_sketch: { type: 'string' },
    failing_test_idea: { type: 'string' },
    area_hint: { type: 'string', description: 'which run C area (runC-plan.json) or a small fix area it belongs to' },
    notes: { type: 'string' },
  },
  required: ['id', 'real', 'model_only', 'root_cause', 'where', 'still_at_head', 'fix_sketch', 'failing_test_idea'],
}

const verifyPorts = { github: '48960-48964 / UI 2460-2464', run: '48965-48969 / UI 2465-2469', research: '48970-48974 / UI 2470-2474' }

const results = await pipeline(
  JOURNEYS,
  (j) => agent(`${COMMON}

YOUR JOURNEY: "${j.key}". Spending cap: USD ${j.cap.toFixed(2)}. Ports: ${j.ports}. Evidence folder: /tmp/frbench/live3/${j.key}/. ${j.extra}

Report every step you took with what you observed and the evidence, every finding with its evidence and repro, your total spend, the owner's-checklist items (subscription or Windows steps), and the pull requests you opened and closed on forerunner-sandbox.`, { label: `live:${j.key}`, phase: 'Live', schema: LIVE_SCHEMA }),
  (live, j) => {
    if (!live) return { journey: j.key, live: null, verified: [] }
    const toVerify = (live.findings || []).filter((f) => f.severity !== 'words')
    return parallel(toVerify.map((f) => () => agent(`You verify one finding of Forerunner's live check 3 against the code at ${BASE} (checkout ${CHECKOUT}) and say whether it still holds at the current head ${HEAD} (main checkout ${REPO}: run C step 1 merged). Read-only in both: do not edit, commit or push; keep every shell command inside ${CHECKOUT}, ${REPO} or /tmp/frbench. You may run unit tests and the stand-in bench (\`node scripts/bench/start.mjs --provider bench\`) on ports ${verifyPorts[j.key]}, stopped when done; never the real model or real GitHub. Read docs/design/core-experience.md for what the person should see, and /tmp/frbench/runC-plan.json to name the run C area a fix belongs to.

The finding (from journey "${j.key}", which ran the real model; its evidence is under /tmp/frbench/live3/${j.key}/):
${JSON.stringify(f, null, 1)}

Decide: is it real (the code explains it, or it reproduces on the stand-in), the model alone (the app did as designed; the model chose differently: no code fix, unless a prompt or brief the app sends made the choice likely), or a misreading/test artefact? Root cause with file:line, whether it still holds at ${HEAD}, a fix sketch, the failing test at the person's boundary, and the run C area or a small fix area it belongs to. Default to skeptical: if the evidence does not support the claim, say real=false and why.`, { label: `verify:${f.id}`, phase: 'Verify', schema: VERIFY_SCHEMA })))
      .then((vs) => ({ journey: j.key, live, verified: vs.filter(Boolean) }))
  },
)
const total = results.filter(Boolean).reduce((s, r) => s + ((r.live && r.live.spend_usd) || 0), 0)
log(`Live check 3: total spend USD ${total.toFixed(2)}`)
return { results, total_spend_usd: total }