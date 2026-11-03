export const meta = {
  name: 'forerunner-merge-live-fixes',
  description: 'Merge fix/intake-live then fix/live-context into the round branch, one at a time with full validation, bench smoke, push',
  phases: [{ title: 'Merge', detail: 'one branch at a time, full validation after each' }],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'string' } },
    head_sha: { type: 'string' },
    pushed: { type: 'boolean' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    integration_fixes: { type: 'array', items: { type: 'string' } },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    smoke: { type: 'string' },
    problems_left: { type: 'array', items: { type: 'string' } },
  },
  required: ['merged', 'head_sha', 'pushed', 'validation', 'problems_left'],
}

phase('Merge')
const merge = await agent(`
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app: a persistent AI project manager (React UI in apps/ui, daemon in packages/runtime). Fix wave 3 (progress-navigation, system-text) has just been merged into ${BRANCH} and pushed. Two more reviewed branches must now go in, ONE AT A TIME: first fix/intake-live (the plan from a brief: replies read whole, prose shortened instead of refused, one retry with the problems in words, true failure words, small plans for short briefs, the plan card, New project without a Goal, ADR 0103), then fix/live-context (the chat told about planning, RichText/EventText for model text, the bench's live mode, the model-call log with prices). Their reports are in /tmp/frbench/livefix.json (results[].fix, .review, .fixup: read the fixup's fixed list and both reviews' non_blocking notes, and each fixer's notes_for_other_areas: they name the shared files and the merge conflicts to expect, e.g. docs/maintainers/runtime.md, apps.md, testing.md, the ADR number 0103 if wave 3 also added one, IntakeBanner test ids and data-state that the smoke journey reads).

Binding rules: AGENTS.md and docs/maintainers/validation.md (test at the boundary the person uses; a changed daemon route has its real-daemon.test.ts case and fake-daemon.ts change in the same commit; failing test first for a behaviour bug; never weaken a test). The owner decided on 2026-11-01 (docs/status/handoff/NEXT-SESSION.md, "Owner decisions"): the critic always reviews code tasks; keep that true through the merge (fix/intake-live's fixup restored defaultRiskTier 1 for new projects: check wave 3 did not undo it). Windows CI is several times slower: in any test you touch, no short real-time waits; leave nothing queued or running for the next test.

Steps:
1. \`cd ${REPO} && git status\`: on ${BRANCH}, clean (the only untracked file allowed is apps/ui/playwright.local.config.ts; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it). \`git fetch origin ${BRANCH}\` and make sure the local branch equals origin.
2. \`git merge --no-edit --no-ff fix/intake-live\`. Resolve conflicts keeping both sides' intent (wave 3 owns the IntakeBanner layout and system-written words; intake-live owns the cause words and the intake). \`git grep -n "^<<<<<<< "\` must find nothing. \`pnpm install --frozen-lockfile\`. Full validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, \`cd apps/ui && npx vitest run --config vitest.config.ts\`, Playwright with the local config (\`cd apps/ui && npx playwright test --config playwright.local.config.ts\`), and the cargo checks in apps/desktop/src-tauri if either branch touched the shell. Fix what the merge broke with the smallest correct change, each fix its own commit naming both areas.
3. Only when step 2 is fully green: \`git merge --no-edit --no-ff fix/live-context\`, the same conflict rules (the smoke journey reads the IntakeBanner by data-testid and data-state: keep wave 3's test ids or update the journey), then the same full validation and fixes.
4. Bench smoke on the merged result (stand-in): \`node scripts/bench/start.mjs --name merge-live --daemon-port 48410 --ui-port 2010 --fresh && node scripts/bench/journeys/smoke.cjs merge-live; node scripts/bench/stop.mjs --name merge-live\`; then the planted bad first reply: \`node scripts/bench/start.mjs --name merge-live2 --daemon-port 48420 --ui-port 2020 --fresh --env FORERUNNER_BENCH_INTAKE_BAD=reason-too-long && node scripts/bench/journeys/intake.cjs merge-live2; node scripts/bench/stop.mjs --name merge-live2\`. Both must end with every check ok, or each failure explained (a real product failure is fixed with a test, or reported in problems_left).
5. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (if not, re-create from the first unsigned commit with \`git commit-tree -S\`, same trees/authors/messages, and move the branch with \`git update-ref\` after checking the tip's tree is unchanged). End every commit message you write with these two lines:
${TRAILER}
6. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push. Never open a pull request.

Report: what was merged (with the merge commit ids), conflicts and how you resolved them, fixes after each merge, every validation command with its result, the smoke and intake journey results, whether you pushed (and the head sha), and anything left broken.`, { label: 'merge:live-fixes', phase: 'Merge', schema: MERGE_SCHEMA })

return { merge }
