// The itemized to-do list and the per-session progress, as of 25 Nov 2026 ~00:50 UTC.
// Used to render the dashboard sections (node todo-data.cjs html > todo-sections.html).
const sessions = [
  { n: 1, when: '26–27 Oct', who: 'earlier session', commits: 20, areas: 0, tests: null, did: 'Version 1.0.0 released; hand-over for 1.0.x.' },
  { n: 2, when: '30 Oct', who: 'two earlier sessions', commits: 30, areas: 0, tests: null, did: 'Releases 1.0.3 and 1.0.4 (U-003 to U-017): installers carry the runtime, claimed tasks recover.' },
  { n: 3, when: '31 Oct – 1 Nov', who: 'earlier session', commits: 114, areas: 0, tests: 4500, did: 'Your eight complaints logged (U-018 to U-088), root causes found, this plan written and approved.' },
  { n: 4, when: '1 – 3 Nov', who: 'this session, week 1', commits: 269, areas: 34, tests: 5321, did: 'Bench and seven hands-on walks; fix waves 1 to 6 (session engine, Tasks, Inbox, chat, wording, navigation); plan steps B, C, D and F2 done. Ended at the weekly limit.' },
  { n: 5, when: '8 – 9 Nov', who: 'this session, week 2', commits: 309, areas: 27, tests: 6090, did: 'Wave 7 and waves 13 to 15 (merging in the app, key or subscription, costs, web search); live checks 2 and 3; run C step 1. Paused at your request.' },
  { n: 6, when: '15 – 17 Nov', who: 'this session, week 3', commits: 229, areas: 18, tests: 6854, did: 'Run L3; run C steps 2 to 4 (one repository one project, budgets that count reviews, which Claude does the work); live check 4: 98 of 103 findings real. Stopped at the 90% line.' },
  { n: 7, when: '22 Nov – now', who: 'this session, week 4', commits: 280, areas: 20, tests: 7485, did: 'Run L4, all 9 rounds (166 fixes plus 50 in fix-ups); new app icon; wave 8 planned and checked; W8a merged; W8b running. Weekly usage at 75%; the wrap-up line is 90%.' },
];

const groups = [
  { key: 'now', title: 'W8b, running now', sub: 'Wave 35. Merge after the last area; then CI and the Desktop app on Windows and Linux.', areas: [
    { area: 'w8-status-write', state: 'done in branch', note: 'Fixed 13, then 4 of 4 blocking in the fix-up (head 8e158a7). Waits for the merge.', items: [] },
    { area: 'w8-together', state: 'review running', note: 'Fix done at aef2f10 (7 fixed: Work together from the Overview and chat, docs ownership, three chat read-backs). Then the fix-up for whatever the review marks blocking.', items: [
      ['W8-join-3', 'A joined project\'s docs pull requests listed as information only (cut line, not reached).'],
      ['fix-up', 'Close the old status pull request when the status switch is off (handed over from w8-status-write).'],
    ] },
    { area: 'w8-l4-leftovers', state: 'next', note: 'Run L4\'s leftovers on starts, sessions and money.', items: [
      ['L4i-left-28', 'At the project\'s budget or the month\'s cap, the status and result name the right stop.'],
      ['L4i-left-30', '"Left for next time … CHF X was used" no longer fires after a larger task\'s pause.'],
      ['L4i-left-32', 'Start dialog stops saying "subscription" when the key is resting with mixed work.'],
      ['L4i-left-59', 'A critic review at the subscription\'s share reads as the credential stop, not a budget pause.'],
      ['L4i-left-17', 'Stopping the critic\'s monthly check is not recorded as failed.'],
      ['L4i-left-19', 'The Desktop window check must see the session run before it passes.'],
      ['L4i-left-21', '"Start a session by itself" says that tasks already ready run too.'],
      ['L4i-left-22', 'Tooltips for Go ahead without, Redo and Try again follow the prepared context.'],
      ['L4i-left-23', 'A waiting Overview says the wait once, not four times.'],
      ['L4i-left-24', 'A running continuation\'s Sessions row names who started it.'],
      ['L4i-left-25', 'Start dialog states one waiter\'s blocker once.'],
      ['L4i-left-26', 'The fake daemon models the limit wake.'],
      ['L4i-left-27', 'Assisted-mode plan card: proper Approve / Reject labels with an explanation line.'],
      ['L4i-left-29', 'Header offers no Answer for a card whose only option is Cancel task.'],
      ['L4i-left-31', '"Ended: 1 paused" and "Done; its review waits": one state, one wording.'],
      ['L4i-left-33', 'A Settings read-back leaves the Inbox once you leave Settings.'],
      ['L4i-left-49', 'Costs counts tries and runs the same way for paused runs.'],
      ['L4i-left-58', 'A review-only pass is not priced at the whole remaining estimate (and two more money cut-line items).'],
      ['L4i-left-64', 'Task rows that spent nothing don\'t show "CHF 0.00".'],
      ['W8a-left-9', 'Split the over-long stand-in line in docs/maintainers/testing.md.'],
    ] },
  ] },
  { key: 'w8c', title: 'W8c, next week', sub: 'Wave 36: each Forerunner reads what the other announced or merged; run L4\'s chat leftovers.', areas: [
    { area: 'w8-status-read', items: [
      ['W8-read-1', 'Read the other Forerunners\' status comments (author, write access, time-bounded).'],
      ['W8-read-2', 'Match the other\'s announced work against your tasks before claiming.'],
      ['W8-read-3', 'The plan\'s "Already in the project" includes the other\'s work.'],
      ['W8-read-4', 'Plans notice main moving under them.'],
      ['W8-read-5', 'Reads when a repository is linked, at Work together and in Sources (read only).'],
      ['W8-read-6', 'Another Forerunner\'s paused task does not look abandoned.'],
      ['W8-read-7', 'Two announcing the same files within seconds: GitHub\'s edit times decide who keeps it.'],
      ['W8-read-8', 'Chat answers "what did ada\'s Forerunner do yesterday?".'],
      ['W8-read-9', 'The take-over\'s 14-day activity rule also reads the status issue.'],
      ['W8a-left-10', 'AGENTS.md and CLAUDE.md, now read by chat, are handled as untrusted text.'],
    ] },
    { area: 'w8-l4-leftovers-chat', items: [
      ['L4i-left-39', 'The task check refuses, in words, a wait on a pending add instead of dropping it.'],
      ['L4i-left-45', 'Your note given with Try again is filed as yours, not the agent\'s.'],
      ['L4i-left-52', 'The Claude Code subprocess gets only the variables it needs (security).'],
      ['L4i-left-38', 'A Connect link beside "Fixing the tasks needs Claude".'],
      ['L4i-left-40', 'Plan card warning stops repeating the task\'s title.'],
      ['L4i-left-41', 'Missing restart, critic-notes and Costs render tests.'],
      ['L4i-left-42', 'Fake daemon\'s split Undo gets the daemon\'s refusal.'],
      ['L4i-left-43', 'Finding a card\'s conversation stops reading up to 400 rows (speed).'],
      ['L4i-left-44', 'Talk on a project not yet stored no longer flashes the message box.'],
      ['L4i-left-46', 'Tests for the suggestion card\'s Answered lines.'],
      ['L4i-left-47', 'A suggestion is not skipped because of an unrelated write.'],
      ['L4i-left-50', 'An unknown project\'s page shows no raw id.'],
      ['L4i-left-51', 'Continuation cases: hand-over, Stop now, removing the project.'],
      ['L4i-left-53', 'No silent UTC fallback; scheduled jobs read your zone at each use.'],
      ['L4i-left-55', 'Chat lookup-depth case and its eval file.'],
      ['L4i-left-56', 'Restart cases use a real restart (two composes on one home).'],
      ['L4i-left-57', 'Inbox no longer says "Done: You answered Yes" for a refused change.'],
      ['L4i-left-60', 'A closed project\'s lessons, recall ranking and other cut-line chat items.'],
      ['L4i-left-63', 'Queued-continuation line tested at the real daemon; last "(s)" plurals.'],
      ['W8a-left-11', 'The questions card names the decisions file on the one path where it fails.'],
      ['W8a-left-24', 'The questions card\'s decision-record wording for repository projects.'],
    ] },
  ] },
  { key: 'w8d', title: 'W8d', sub: 'Wave 37: see the other Forerunner\'s work within a minute; access and authors.', areas: [
    { area: 'w8-github-feed', items: [
      ['W8-feed-1', 'Show the other Forerunner\'s work, from its status comment, on your screens.'],
      ['W8-feed-2', 'List the other\'s pull requests on the project, read only.'],
      ['W8-feed-3', 'Show what waits for Merge on the other side.'],
      ['W8-feed-4', 'The other\'s changes reach your screen within about a minute.'],
      ['W8-feed-5', 'Tell you when the other\'s session ends.'],
      ['W8-feed-6', 'Say once that a second Forerunner works on the project.'],
      ['W8-feed-7', 'A future time ("until 14:30") does not read "just now".'],
      ['L4i-left-9', 'Last result stops counting pull requests closed without merging.'],
      ['L4i-left-10', 'Close\'s consequence line is visible, not only a tooltip.'],
      ['L4i-left-12', 'Take-out sync stops paging every answered card; close its crash gap.'],
      ['L4i-left-13', 'Real-daemon cases for Take this work out.'],
      ['W8a-left-8', 'Overview header counts every pull request, not only task ones.'],
    ] },
    { area: 'w8-shared-repo', items: [
      ['W8-repo-1', 'Someone who cannot push is told what access to ask for.'],
      ['W8-repo-2', 'Agents and commits tell people apart: no default "Alice" (privacy).'],
      ['W8-repo-3', 'After Create the repository, say how a second person gets in.'],
      ['W8-repo-4', 'The stand-in GitHub models invitations and read-only access.'],
      ['W8-repo-5', 'Setup guide lists every token permission needed (Issues too).'],
      ['W8a-left-12', 'Take-over Try again never tells you to delete someone else\'s work.'],
      ['W8a-left-13', 'You are not "me" before setup\'s name step.'],
      ['W8a-left-20', 'A guide refresh\'s pull request has its own words, not the scaffold\'s.'],
      ['W8a-left-21', 'An existing AGENTS.md keeps your text byte for byte.'],
      ['W8a-left-23', 'Take-over Try again after a failed docs pull request.'],
      ['W8a-left-32', 'The guide\'s "who merges" line says whose pull requests.'],
      ['W8b-left-1', 'The status issue\'s title is redacted like the board (privacy, never cut).'],
    ] },
  ] },
  { key: 'w8e', title: 'W8e', sub: 'Wave 38: your data stays yours; the two-person journey end to end.', areas: [
    { area: 'w8-own-devices', items: [
      ['L4i-left-1', 'The phone\'s start passes the same checks as Start (money).'],
      ['W8-own-1', 'A second install does not take over the store\'s only person.'],
      ['W8-own-2', 'The refusal\'s remedy does not create a third person.'],
      ['W8-own-3', '/health reports the store actually used.'],
      ['W8-own-4', 'An agent that loses its claim mid-run notices.'],
      ['W8-own-5', 'Starting a session checks whose agent it is.'],
      ['W8-own-6', 'Stopping another device\'s session needs a device check.'],
      ['W8-own-7', 'Rows from a device with a slow clock are not missed.'],
      ['W8-own-8', 'A lapsed claim does not block Start.'],
      ['W8-own-9', 'Project settings change only through a command with a change row (money, security).'],
      ['L4i-left-11', 'The take-over retry route checks ownership (security).'],
      ['L4i-left-16', '"Interrupted" shows the last time the session worked.'],
      ['L4i-left-34', 'A project with only a paused task says so, not "no task is ready".'],
      ['L4i-left-35', '"on" and "of" agree across start sentences.'],
      ['L4i-left-36', 'Two money cases start through the real start route.'],
      ['L4i-left-37', 'The fake daemon\'s 409 text matches the daemon\'s.'],
      ['L4i-left-61', 'The Inbox stops running a start check per plan card (speed).'],
      ['W8a-left-14', 'A zone or name saved in setup reaches every window.'],
      ['W8a-left-15', 'Test: a screen drawn before your profile arrives switches to your zone.'],
      ['W8a-left-16', 'Updates page says why its buttons are off when your profile fails to load.'],
      ['W8a-left-17', 'The fake daemon\'s take-over Try again answer matches.'],
    ] },
    { area: 'w8-journey', items: [
      ['W8-journey-1', 'Release scenario: two Forerunners, two stores, one GitHub.'],
      ['W8-journey-2', 'Requirements F.1 to F.7 rewritten for GitHub (your question OQ-W8-1).'],
      ['W8-journey-3', 'Collision and hand-over scenarios stop faking a two-person list.'],
      ['W8-journey-4', 'Your docs promise only what is built for two people.'],
      ['W8-journey-5', 'The two-person bench journey ends with every check passing.'],
      ['W8-journey-6', 'Search everything written to GitHub for private data.'],
      ['W8-journey-7', 'A task larger than a session paused at one person\'s; keys, grants and Continue per person.'],
      ['L4i-left-66', 'The wording check catches every possessive form.'],
      ['W8a-left-18', 'The bench\'s GitHub cut also cuts git clone.'],
      ['W8a-left-25', 'Settings gets a Time zone row.'],
    ] },
  ] },
  { key: 'f', title: 'F: independent final check', sub: 'Fresh agents, one per journey, real model where it matters; at most two fix rounds; then full validation and CI. API budget so far USD 16.50 of 40.', areas: [
    { area: 'journeys', items: [
      ['F-1', 'Chat recall on the real model: 12 questions about what happened.'],
      ['F-2', 'Chat\'s asks in words, a widened rule, a pause asked for in chat.'],
      ['F-3', 'Chat thinks longer and uses a stronger model when asked.'],
      ['F-4', 'Chat history from the prompt cache past 13 turns.'],
      ['F-5', 'A clean 4-task session on the real coder and critic.'],
      ['F-6', 'Missing steps from one real report become chained tasks.'],
      ['F-7', '"Fix the tasks" at Assisted on the real model.'],
      ['F-8', 'A planted instruction in a report changes nothing.'],
      ['F-9', 'Pauses on the real researcher.'],
      ['F-10', 'A run under a tiny project budget.'],
      ['F-11', 'A reviewer task that names its output file.'],
      ['F-12', 'Take it over on real GitHub.'],
      ['F-13', 'Merge and Close on real GitHub.'],
      ['F-14', 'One project per repository on real GitHub.'],
      ['F-15', 'A refused API key and chat\'s failure lines.'],
      ['F-16', 'The critic\'s live calibration on its new prompt.'],
      ['F-17', 'Kept work checked on a real wrap-up.'],
      ['F-18', 'A reply cut at its length limit.'],
      ['F-W8-1', 'Two Forerunners on the real forerunner-sandbox, stand-in model (no model money).'],
      ['F-W8-2', 'Live two-person journey, capped at USD 3 (needs a second GitHub account for the full check).'],
    ] },
  ] },
  { key: 'g', title: 'G: hand-over, then G2', sub: 'The installer and your checklist; G2 fixes what your checklist finds until it passes on your PC.', areas: [
    { area: 'hand-over', items: [
      ['G-1', 'UPDATE-LOG entries, each with a "Check in the app" step.'],
      ['G-2', 'CHANGELOG, including the lines the areas suggested (W8a-left-28).'],
      ['G-3', 'requirements.md (F.1 to F.7) and the gates evidence.'],
      ['G-4', 'What was and was not tested.'],
      ['G-5', 'Five GitHub behaviours only real GitHub shows, copied into the stand-in (W8a-left-29).'],
      ['G-6', 'Run the live-only tests changed at merges (W8a-left-30) and the live harness dry runs (W8a-left-31).'],
      ['G-7', 'Remove the CLAUDE.md work-in-progress paragraph.'],
      ['G-8', 'Installer from the Desktop app workflow.'],
      ['G-9', 'Your checklist: fresh install, first project from a brief, answer a question, steer from chat and open the PR, a Docker full-review task, optionally the subscription.'],
      ['G2', 'You walk the checklist; each problem is fixed the same way until all steps pass.'],
    ] },
  ] },
  { key: 'h', title: 'H: the phone, last', sub: 'After every desktop step, G2 included.', areas: [
    { area: 'phone', items: [
      ['H-1', 'Map, screen by screen, what carries over from the desktop.'],
      ['H-2', 'Phone Inbox shows the old options, count and reply box.'],
      ['H-3', 'Reviews "Approve" maps to Mark done anyway without the confirmation.'],
      ['H-4', 'Reviews links open with target=_blank.'],
      ['H-5', 'The phone never learns your time zone (W8a-left-26).'],
      ['H-6', 'Android adaptive icon.'],
      ['H-7', 'Walks in phone emulation, the Android emulator scenarios, a check on your phone.'],
    ] },
  ] },
  { key: 'owner', title: 'For you (none blocking)', sub: 'Defaults are built meanwhile.', areas: [
    { area: 'owner', items: [
      ['OQ-W8-1', 'May F.1 to F.7 (inbox, receipts, claiming, seeing the other\'s work, hand-over) be met through GitHub? Built as yes.'],
      ['OQ-W8-2', 'A second GitHub account for the live two-person check.'],
      ['branches', 'Delete the four merged backup branches claude/nifty-knuth-f9udt0-backup/fix-* (keep plan-files).'],
      ['registry', 'Create the forerunner-registry repository.'],
      ['install', 'Later: install the build and walk the checklist (step G).'],
    ] },
  ] },
];

module.exports = { sessions, groups };

if (require.main === module) {
  const mode = process.argv[2] || 'count';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (mode === 'count') {
    for (const g of groups) console.log(g.title, g.areas.reduce((n, a) => n + a.items.length, 0));
  } else if (mode === 'html') {
    const maxC = Math.max(...sessions.map((s) => s.commits));
    let h = '';
    h += '<section aria-labelledby="h-sessions">\n  <div class="sechead"><span class="eyebrow">2 · Progress</span><h2 id="h-sessions">Session by session</h2></div>\n';
    h += '  <p class="lede">Each row is one session, or one week of this session between two usage resets. Bars: commits that session. Areas: fix areas merged (each fixed, independently reviewed, fixed up, merged with the full suite). Tests: test cases in the code at the session\'s end (parametrised cases make the count of runs higher, 8,000+).</p>\n';
    h += '  <div class="tablewrap"><table class="sessions"><thead><tr><th>Session</th><th>Commits</th><th>Areas</th><th>Tests</th><th>What it finished</th></tr></thead><tbody>\n';
    for (const s of sessions) {
      const w = ((s.commits / maxC) * 100).toFixed(1);
      h += `    <tr><td><b>${esc(s.when)}</b><span class="sub">${esc(s.who)}</span></td><td class="mono"><div class="sbar" role="img" aria-label="${s.commits} commits"><i style="width:${w}%"></i></div>${s.commits}</td><td class="mono">${s.areas || '–'}</td><td class="mono">${s.tests ? s.tests.toLocaleString('en-US') : '–'}</td><td>${esc(s.did)}</td></tr>\n`;
    }
    h += '  </tbody></table></div>\n</section>\n\n';
    const total = groups.reduce((n, g) => n + g.areas.reduce((m, a) => m + a.items.length, 0), 0);
    h += '<section aria-labelledby="h-todo">\n  <div class="sechead"><span class="eyebrow">3 · To do</span><h2 id="h-todo">Every item left, in order</h2></div>\n';
    h += `  <p class="lede">${total} items in order of work. Each wave 8 item gets a failing test first, an independent review on the bench, and the full suite at the merge. Open a group to see its items.</p>\n  <div class="todo">\n`;
    for (const g of groups) {
      const n = g.areas.reduce((m, a) => m + a.items.length, 0);
      h += `    <details${g.key === 'now' ? ' open' : ''}><summary><b>${esc(g.title)}</b><span class="chip ${g.key === 'now' ? 'now' : g.key === 'owner' ? 'warn' : 'left'}">${n} item${n === 1 ? '' : 's'}</span><span class="sub">${esc(g.sub)}</span></summary>\n`;
      for (const a of g.areas) {
        if (!(g.key === 'f' || g.key === 'g' || g.key === 'h' || g.key === 'owner')) h += `      <h4><span class="tag">${esc(a.area)}</span>${a.state ? ` <span class="chip ${a.state === 'done in branch' ? 'fixed' : a.state === 'review running' ? 'now' : 'left'}">${esc(a.state)}</span>` : ''}${a.note ? `<span class="sub">${esc(a.note)}</span>` : ''}</h4>\n`;
        if (a.items.length) {
          h += '      <ul>\n';
          for (const [id, t] of a.items) h += `        <li><code>${esc(id)}</code> ${esc(t)}</li>\n`;
          h += '      </ul>\n';
        }
      }
      h += '    </details>\n';
    }
    h += '  </div>\n</section>\n';
    process.stdout.write(h);
  }
}
