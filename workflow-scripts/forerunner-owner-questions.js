export const meta = {
  name: 'forerunner-owner-questions',
  description: 'Answer the owner\'s design questions (merging per task and multi-agent work; subscription vs API key; budgets, cancels and resuming; status on GitHub; web search; site lists) from the code and the docs, with options, unforeseen consequences and a recommendation; adversarially checked; no code changes',
  phases: [
    { title: 'Research', detail: 'one agent per question: current behaviour, options, consequences, recommendation' },
    { title: 'Challenge', detail: 'independent skeptics look for what each recommendation gets wrong' },
    { title: 'Synthesis', detail: 'one answer per question for the owner' },
  ],
}

const REPO = '/home/user/Forerunner'
const COMMON = `
Context: Forerunner (repository ${REPO}, branch claude/nifty-knuth-f9udt0, read it at HEAD; also read the branches fix/decisions, fix/stops, fix/asking and fix/verification where they matter: they hold not-yet-merged phase E work) is a desktop app: a persistent AI project manager. A person gives a brief; an intake drafts a plan; the person approves; sessions run tasks with specialist agents (coder, tester, researcher, ...) and a critic reviews each task. Projects can be local folders or GitHub repositories (task branches and pull requests). Credentials: a Claude API key (the runtime's own agent loop calling the Messages API) and/or a Claude subscription (the Claude Agent SDK, i.e. the Claude Code harness, with its built-in tools behind the runtime's hooks). Design docs: docs/design/core-experience.md, docs/decisions/ (ADRs; 0101 Docker for full review, 0104 proportional verification, 0105 continuity, 0106 empty repository and status update, 0107 research web access), docs/maintainers/*.md, docs/user-guide.md, docs/status/handoff/NEXT-SESSION.md (the owner's decisions).

The owner (a non-developer who will use the app on Windows with Docker) asked these questions about choices the session lead made; you research one of them. Ground every claim about the app in code you read (file:line) and every claim about Claude or GitHub in documentation you read (for the Claude API: the claude-api skill files under /tmp/claude-0/bundled-skills/*/claude-api/ (shared/tool-use-concepts.md, shared/prompt-caching.md, the Server Tools and Task Budgets sections of its SKILL.md) and the live docs listed in its shared/live-sources.md; for the Agent SDK / Claude Code: code.claude.com docs (agent-sdk, hooks, settings permissions); for GitHub: docs.github.com). Say plainly what you could not verify. Do not change any file in the repository; you may write notes under /tmp/frbench/owner-q/.

The owner's priorities: (1) it works and is reliable for a person, never stuck, never untrue; (2) the person's own preferences (e.g. which credential first); then cost. Write for a non-developer: short, concrete, no jargon without a one-line explanation.
`

const ANSWER = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    current_behaviour: { type: 'string', description: 'what the app does today (HEAD and the phase E branches), with file:line' },
    options: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, how_it_works: { type: 'string' },
      good: { type: 'array', items: { type: 'string' } },
      bad_and_unforeseen: { type: 'array', items: { type: 'string' } },
      effort: { type: 'string', description: 'small / medium / large, and what it touches' },
    }, required: ['name', 'how_it_works', 'good', 'bad_and_unforeseen', 'effort'] } },
    recommendation: { type: 'string' },
    why: { type: 'string' },
    what_to_build: { type: 'array', items: { type: 'string' }, description: 'concrete changes if the owner agrees, each with the files' },
    open_points_for_the_owner: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'current_behaviour', 'options', 'recommendation', 'why', 'what_to_build', 'open_points_for_the_owner', 'unverified'],
}
const CHALLENGE = {
  type: 'object',
  properties: {
    holds: { type: 'boolean', description: 'does the recommendation survive' },
    wrong_facts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, truth: { type: 'string' }, evidence: { type: 'string' } }, required: ['claim', 'truth', 'evidence'] } },
    missed_consequences: { type: 'array', items: { type: 'string' } },
    better_option: { type: 'string', description: 'empty if none' },
    notes: { type: 'string' },
  },
  required: ['holds', 'wrong_facts', 'missed_consequences', 'better_option', 'notes'],
}

const QUESTIONS = [
  { key: 'q1-merging', challenge: true, text: `Owner's question 1: "Would it be better to merge after every task? And how would this affect co-work or multi-bot work? What could be the unforeseen negative consequences for one or the other approach, and which approach should we take based on that?"
Background: in a repository project each task gets its own branch and pull request; a task that depends on another whose PR is not merged yet did not see that work (live check: the tester failed until the person merged the coder's PR). The session lead's default (fix/decisions, ADR 0106) merges the dependencies' unmerged branches into the dependent task's branch; the PR still targets the default branch. Research: what the app does at HEAD and on fix/decisions (pr-executor.ts, runner.ts dependency branches, the critic's diff base, the merge step / merge_pr tool and ADR 0062, auto-merge settings, how a person merges), and how many tasks run at once (session concurrency, parallel specialists). Options to weigh at least: (a) the app merges each task's PR itself after the critic accepts (auto-merge, perhaps squash), (b) dependent branches built on unmerged dependency branches (the default), (c) stacked PRs (base = dependency branch), (d) hold dependents until the person merges, (e) one branch/PR per session or per milestone. For each: what happens with parallel tasks (two agents changing the same files), with a person also pushing to the repo, with several Forerunner installs or people on the same repository ("co-work"), with a task that is later sent back or cancelled after its work was merged, with branch protection or required reviews/checks on the repository, with the person's wish to review before anything reaches main, and with Undo.` },
  { key: 'q2q5-credentials-web', challenge: true, text: `Owner's questions 2 and 5: (2) "The subscription and the API key should both be able to be used in a similar way, even though they don't have the exact same capabilities. It will be important to intelligently determine in which cases either can be used. The first priority is function and reliability. The second priority is allowing the user to prioritize the API or the Claude subscription as they prefer. Think about the best way to accommodate both while maintaining proper function." (5) "Figure out how to get the API to search for things. I believe the API can access websites. Also enable web search using the Claude subscription if possible, but make sure everything works based on the user request and the available key or subscription token. Tell me what the options are."
Research: how a task's credential is chosen today (billing order, packages/runtime/src/daemon/billing-order*.ts and the routing), what each path can do (tools, web, sandbox, models, costs, limits such as the subscription's usage limits and rate limits), what happens when the chosen credential fails mid-task (limit reached, key invalid) and whether the other is tried, how the research-web work (ADR 0107: the runtime's own web_fetch on the API path; the subscription's WebFetch denied by the hooks because allowed_domains is empty; WebSearch allowed) behaves, and the session lead's default on fix/decisions (research to the API key when saved). Facts to use and verify: the Claude Messages API has server-side tools web_search (type web_search_20260209 on current models, $10 per 1,000 searches plus tokens) and web_fetch (web_fetch_20260209; fetches only URLs already in the conversation), both with max_uses and allowed_domains/blocked_domains; they run on Anthropic's servers, outside the runtime's own hooks, and their results arrive in the same response (pause_turn handling in the loop). The Agent SDK has built-in WebSearch and WebFetch tools that PreToolUse hooks can allow or deny per URL. Design: a capability-aware router (what a task needs vs what each credential can do on this install), the person's preferred order as the tie-breaker, a fallback when one credential fails, and how web search and page reading work on both paths with the same site rules (question 6: any site by default, optional allow or block lists per project) and the runtime's safety rules (no private network addresses, prompt-injection handling of page text, the audit log). Say what each option costs per research task.` },
  { key: 'q3-budgets', challenge: true, text: `Owner's question 3: "When the task is too big for the budget, it seems like many times we may lose money by spending tokens, hitting the budget, and then canceling the task. Think carefully about what happens when a task is canceled or abandoned when the limit is reached. Is this going to cause downstream consequences other than losing tokens? Can we keep a session alive with the dynamic option to increase the budget? If not, how will the session's budget be calculated and what will happen when there's a mismatch with the calculation? In the end, tasks must be able to be resumed after running out of budget without losing all the work. 80% of the budget should go towards doing the task, while the remaining 20% should be used to wrap up the task: make commits or comments, to-do lists, whatever needs to be done."
Research: every budget in the app (task budget, session work budget, monthly cap, the Start dialog's estimate, estimates vs real costs: the live check found estimates about 10x above real costs for coder tasks and below for research) and exactly what happens at each limit today and on the phase E branches (runner.ts budget_exceeded: released to Ready; continuity's budget card 'Raise the budget' / 'Cancel task'; fix/decisions: a second session-budget stop files a card; fix/stops: cancel and Undo): are the task's files, branch, partial commits, the agent's notes kept; does the next run start from that work or from scratch (the brief's 'previous attempt' section); what dependents do when a task is cancelled (blocked? cancelled? run without it?); PR and branch leftovers; the person's Inbox. Can a running session's budget be raised while it runs (a command or card that changes the limit live, without a restart), and what the UI would need. A wrap-up reserve: stop the work at about 80% of the task's budget and use the rest to save the work (commit, a short 'where I stopped and what is left' note that the next run reads, a to-do list), so a resumed task continues. On the API path, Anthropic's task budgets beta (output_config.task_budget, the model paces itself) may help; on the subscription path, what the Agent SDK offers. Say how a mismatch between the estimate and the real cost is handled today and how it should be.` },
  { key: 'q4-status-github', challenge: false, text: `Owner's question 4: "Why would the status stay in the app, and why would you not push the status to GitHub? Explain why the choice is the way you've chosen it."
Research: what 'the status' is (docs/status.md and anything else a session writes about the project's state), who reads it (the person, the next session's agents, the chat), where it lives in a local project and in a repository project at HEAD (ADR 0106: a status PR on branch fr/status, updated in place or one per session?) and on fix/decisions (no status PR by default, a project setting turns it on). Options: (a) a status PR (as at HEAD), (b) commit the status straight to the default branch, (c) one long-lived status branch without a PR, (d) put the status into each task's PR or as a PR comment, (e) a GitHub issue that the app updates, (f) only in the app, with a button to publish it. For each: what the person sees on GitHub, merge conflicts with task PRs that also touch docs, branch protection and required reviews, noise in the repository, whether the next session's agents and other collaborators can read it, and what happens offline.` },
  { key: 'q6-sites', challenge: true, text: `Owner's question 6: "Researchers should be able to look at any website by default, with the option to restrict it to certain websites or domains when desired."
Research: the page reader's rules today (ADR 0107; packages/capabilities web_fetch, settings.browser site list and block list, the defaults, the safety checks: private and local network addresses, redirects, content types, size limits; the subscription path's WebFetch hooks), where a project's settings live and whether a screen can edit them (C-66: no screen sets them, the project view carries no version), and the phase E branches. Design: any public website by default on both credential paths (API key and subscription), with per-project 'only these sites' or 'never these sites' lists the person can set on the project page (and maybe a global default in Settings), the same rules applied to Anthropic's server-side web_search/web_fetch if those are used (allowed_domains / blocked_domains: they cannot both be set), and what must never be allowed whatever the list says (private networks, file:, the app's own daemon).` },
]

phase('Research')
const results = await pipeline(
  QUESTIONS,
  (q) => agent(`${COMMON}\n${q.text}`, { label: `research:${q.key}`, phase: 'Research', schema: ANSWER }),
  (ans, q) => {
    if (!ans || !q.challenge) return { key: q.key, answer: ans, challenge: null }
    return agent(`${COMMON}
You are an independent skeptic. Another agent answered the owner's question below; its answer holds claims to check, not facts. Try to break the recommendation: check its facts about the app in the code yourself (file:line), its facts about Claude/GitHub in the docs, and look for consequences it missed (reliability, cost, safety, a person getting stuck or told something untrue, Windows, offline, co-work). Default to doubting it. Do not change any file.

The question: ${q.text}

The answer: ${JSON.stringify(ans)}`, { label: `challenge:${q.key}`, phase: 'Challenge', schema: CHALLENGE })
      .then((c) => ({ key: q.key, answer: ans, challenge: c }))
  },
)

phase('Synthesis')
const synthesis = await agent(`${COMMON}
You write the owner's answers. Inputs: the research answers and the skeptics' challenges below (a challenge's wrong_facts override the answer where its evidence is better; weigh missed_consequences and better_option). Also question 7, answered here by the session lead: "Why would we need Ctrl-click on top of normal click?" — we do not need it; a normal click already opens a link (an external one in the system browser). Ctrl-click and Shift-click are what many people do out of habit to open a link in a new tab or window; before the fix they silently did nothing, which feels broken. The only open point is a Ctrl-click on one of the app's own links (e.g. Inbox): today it does nothing; the alternative is to treat it like a normal click.

Write /tmp/frbench/owner-answers.md: one section per question (1 to 7), each with: the short answer (two or three sentences, the recommendation first), what happens today, the options in a small table (option, good, bad/unforeseen), the recommendation and why, and what would be built (one line each). Plain words for a non-developer; no file paths in the main text (put them in a short 'for the record' line at the end of each section). Then a final section 'What I need from you': at most one line per question, each a yes/no or a choice.

Return the markdown text too.

Research and challenges: ${JSON.stringify(results.filter(Boolean))}`, { label: 'synthesis:owner-answers', phase: 'Synthesis' })

return { results, synthesis }
