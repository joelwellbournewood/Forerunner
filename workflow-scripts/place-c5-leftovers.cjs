// Places run C sub-run C5's leftovers (d1109-cred-engine and d1109-run-visible merged at d133246; both
// had a fix-up) into the C6 areas (d1109-cred-screens, d1109-selftasks-chat; problems + acceptance) where
// an area owns the code, otherwise into /tmp/frbench/leftovers-C5.json for the triage after live check 4.
// Folds C5's merge notes into live check 4's steps (segments " C5 leftovers adds"; no new step, no new
// cost) and adds "(C5-merge)" session lead decisions. Idempotent: earlier C5-left entries, " C5 leftovers
// adds" segments and "(C5-merge)" decisions are replaced. No other sub-run's tags or decisions are touched.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "d133246008888fa945d41a4ae0101e5b85fd19e4";
const SRC = (k) =>
  `/tmp/frbench/runC-C5-fixup-${k}.json first (notes_for_other_areas, not_done, new_problems), then runC-C5-fix-${k}.json and runC-C5-review-${k}.json (non_blocking), and runC-C5-merge.json problems_left`;

const toAreas = {
  "d1109-cred-screens": {
    from: "d1109-cred-engine",
    items: [
      [
        "C5-left-1",
        "major, transparency",
        "CE-11 was not built in C5, and CS-5 (never cut) shows what it records: build the switch data here first. (1) The session log's switch line once per session, '\"X\" goes on with your API key from where it stopped: ...' (switchLogLine and backLogLine already exist in packages/runtime/src/session/credential-words.ts), a second task's switch as a detail line, and the back line when the first choice serves again; the runner's '\"X\" continues on your API key now.' goes (runner.ts: change only that line's region and the once-per-session dedupe; no other C6 area touches runner.ts). (2) billing.switch and billing.back events, switchedFrom on the Run row, SessionResult.switched and CostView.byCredential, which CS-5's session page line, result line, drawer run line and Costs split read. (3) After a grant (Use API key), the session log says the work ran on the API key and why (C5's review non_blocking 10: today the person sees only 'The session started with a budget of CHF 5.00.'). The fix-up names three tests of other areas to re-baseline (task-usage-limit, subscription-path, real-daemon): update their assertions keeping their intent. A restart case: the switch line is not written twice after a restart mid-session.",
      ],
      [
        "C5-left-2",
        "minor",
        "CE-12: the switch notification has no producer (switchNotificationWords exists in credential-words.ts). Produce it once per switch from the data C5-left-1 adds, with its restart case (no second notification for the same switch after a restart). May end in not_done with the reason if CS-1, CS-2, CS-3, CS-5, CS-8 and C5-left-1 need the time.",
      ],
      [
        "C5-left-3",
        "minor, words",
        "CE-9, the chat half of D5-S7: POST /chat's view does not carry ChatReply.oneOff, so no one-off press can show; and while chat is held, the hold reply still offers 'Think it through' with 'Thinks longer on this model: about 30 seconds, at most CHF 0.03' (server.ts about :2503 offers it because the stored reply has a closer and no notice), and pressing it only gets the hold reply again (C5 review non_blocking 1, walk1-steps/01). Carry oneOff through POST /chat and the client, show the press, and offer no Think it through on a held reply. docs/user-guide.md already says 'While chat waits it says why and offers Use API key for that one question': make it true or reword it (review non_blocking 2).",
      ],
      [
        "C5-left-4",
        "minor",
        "What Settings reads: GET /settings/billing-order and the current Settings section still read billing_order (personOrderOf), not credential_policy, so once a policy is stored Settings can show an order that is not in force (C5 review non_blocking 4). When CS-1's section and route land, nothing the person sees reads billing_order, and POST /settings/billing-order maps onto the policy as the spec says. credential_policy's narrows treats an unset earlier value as rank 0 even when mid_session_limit use_other is stored: derive the earlier rank from the stored values (cred-engine's new_problems). The explicit post-restart assertions removed from billing-order.test.ts 'policy and rest survive a restart' (chosen, order, blocked: resting) come back on GET /settings/credential-policy (review non_blocking 3).",
      ],
      [
        "C5-left-5",
        "words",
        "The refused card's withdrawn line ('A new one is saved; ...') also shows when TR-10 closes the card with nothing waiting (cred-engine's new_problems): it says what happened to waiting work only when work waited; otherwise the card closes with the one sentence that the new sign-in or key is saved. The sentence is in credential-words.ts; the card on screen is this area's (D5-S7).",
      ],
    ],
  },
  "d1109-selftasks-chat": {
    from: "d1109-cred-engine and d1109-run-visible",
    items: [
      [
        "C5-left-6",
        "minor, CI",
        "C4b-left-3's fix (5edf901, the restarted daemon's clock goes on from later) leaves one tie: the case now orders 'Style the page: colours' before 'Check that the links work', and both are made after the restart, so a same-millisecond created_at can still decide the order (C5's run-visible review non_blocking 12; it passed 3 of 3). apps/ui/test/real-daemon.test.ts, d1109-selftasks-run's block 'the card in the Inbox names the project ... after a restart': make the order deterministic (advance the shifted clock between the two creations, or assert the order the stored created_at and priority give), keeping the case's intent. Force the tie first to show it fails, then show the file green 10 times in a row.",
      ],
      [
        "C5-left-7",
        "minor",
        "C4-left-11, not built in C5 (d1109-cred-engine's not_done, time): the task check's model is rungModelFor(modeDefaults.planning.tier) in packages/runtime/src/session/task-check.ts; unlike the intake (intake.ts, resolveRunSettings with the principal's planning override and the project's highest model) it ignores both, so 'routed like the intake's planning call' holds for the provider, not the model. 'fix the tasks' from chat runs this check (SC-1, SC-14; LC-C28 runs it on the real API): choose the check's model as the intake does, under the credential policy (C5 added runTaskCheck's held branch: TaskCheckRun not_made reason 'held' with an optional wait; keep it).",
      ],
    ],
  },
};

const carried = [
  ["L3-left-14", "money"],
  ["C3-left-4", "minor"],
  ["C3-left-5", "minor, tests"],
  ["C3-left-6", "minor"],
  ["C4b-left-1", "minor, tests"],
];
const engine = p.areas.find((x) => x.key === "d1109-cred-engine");
const carriedText = (id) => {
  const t = engine.problems.find((x) => typeof x === "string" && x.includes(` ${id} (`));
  if (!t) throw new Error(`no carried text for ${id}`);
  return t.replace(/^\[[^\]]*\]\s*/, "");
};

const triage = [
  ["C5L-1", "major", "d1109-cred-engine", "CE-6 (D5-5) not built: the subscription's share reached mid-run is still the hooks' plan-level budget pause (a budget card until the 1st), not a credential stop that waits or asks under the policy, and the allowance raise's change line is not built (both Wait lines of the share exist in askCardWords and are unit-tested). The share is held at every pick (CE-2), so a task's next pick waits and no money passes it. Needs the executor's budget-stop branch turned into a credential stop and a composed SDK test with a tiny allowance (ADR 0120's consequences name it)."],
  ["C5L-2", "minor", "d1109-cred-engine", "CE-10: background jobs are not marked 'not done for the period' after a held call, and nothing logs it in one line. A held batch pick waits and a grant never covers batch (credential-policy.test.ts), so nothing is spent; whether calibration and the model watch try again next tick is not verified."],
  ["C5L-3", "words", "d1109-cred-engine", "CE-1's one-time Update on homes with both credentials and nothing chosen ('Chat, planning and reviews now use your Claude subscription first, like your tasks ...'): not built (the spec allowed it)."],
  ["C5L-4", "tests", "d1109-cred-engine", "CE-5's composed repository case (the work-in-progress commit under the continuing run's commit on the task's branch) is not built: the composed world's scripted Claude Code writes no file through the SDK driver's tools. The brief is covered at the model-facing boundary. Live check 4's LC-C23 is now its only check (folded there)."],
  ["C5L-5", "minor", "d1109-cred-engine", "syncAskAnswers writes the grant, calls onGrant, then marks the card applied, not atomically: a crash in between could start a second continuation after a restart. One transaction, or onGrant idempotent per card, with a restart case."],
  ["C5L-6", "minor", "d1109-cred-engine", "onGrant readmits every ready task of a project with a running session, not only the tasks that waited for the stop."],
  ["C5L-7", "minor, money", "d1109-cred-engine", "compose's credentialHold reads human.timezone and monthly_cap_usd_micro as captured at compose time, not at each call: a monthly cap the person lowers, or a new zone, reaches the hold only after a restart. Check first whether the router's key_month stop reads the cap fresh at each pick; if it does not, this is major (a cap could be passed)."],
  ["C5L-8", "minor", "d1109-cred-engine", "The router falls back to Date.now() when RouteContext.nowMs is absent (AGENTS.md: time goes through a Clock). Today's callers pass nowMs; make it required."],
  ["C5L-9", "minor, tests", "d1109-cred-engine", "The concurrent-refusal test calls RouterTaskBilling.refuse twice; there is no case where a task run and a chat call meet the refusal at the same moment through the composed runtime (cred-world.ts can build it)."],
  ["C5L-10", "words", "d1109-cred-engine", "The intake card still says 'milestone(s)', 'task(s)' and 'doc(s)' (packages/runtime/src/intake.ts about :1476; C4b-left-2 fixed only 'a first-session plan of N tasks' beside it)."],
  ["C5L-11", "decision", "d1109-run-visible", "The project status line's Cancel and Continue show their explanation only as a tooltip; the bar's and Working now's Cancel show it beside the button (design section 3). While a session waits the Overview already states the fact four times with three Cancel buttons, which is heavy at 375 px (/tmp/frbench/review-d1109-run-visible/steps/05-rv3-home-while-it-waits-375.png). Not decided now: LC-C31 looks at the waiting Overview at both widths first, then the session lead decides (for example: the status line keeps the fact and drops its own Cancel while the bar shows it)."],
  ["C5L-12", "words", "d1109-run-visible", "Two wordings of one fact (design section 5 rule 10): on Home and the Overview a running project's status line says 'Working on \"Create index.html\" (0 of 7 done)' beside the bar's 'Quote page · the coder works on \"Create index.html\"' (/tmp/frbench/fix-d1109-run-visible-after-steps/01-after-home-while-running.png); the session page says 'Current task: Choosing the next task…' while the bar says 'the critic checks \"X\"'."],
  ["C5L-13", "words", "d1109-run-visible", "The Overview says 'Last result: No session yet.' while the project's first session runs (/tmp/frbench/fix-d1109-run-visible-after-steps/08-after-stop-menu-open.png)."],
  ["C5L-14", "minor, words", "d1109-run-visible", "Stopping the critic's monthly check (Stop now or Stop all) aborts its run and the job records it as failed; its notification reads as a failed calibration, not as stopped by the person (packages/runtime/src/jobs)."],
  ["C5L-15", "words", "d1109-run-visible", "After Cancel on a waiting session, chat's project facts (packages/runtime/src/conversation/project-facts.ts) and the typed 'summary' command (packages/commands/src/commands/summary.ts:79) still read the stored last result as written, so chat can repeat '...; then your session goes on.'. run-indicator.ts resultAfterWait(store, projectId, since, text) is the one rule (daemon-only; the commands package needs it through a port)."],
  ["C5L-16", "minor", "d1109-run-visible", "A calibration (fr jobs calibrate) or a session that a CLI one-shot starts beside a running daemon shows on GET /running (shared store) but sends no run.changed: the bar learns it only at a reload or reconnect."],
  ["C5L-17", "minor", "d1109-run-visible", "While a start is queued behind another project's session, that project's header still offers 'Start session'; pressing it again asks for one more start (the status line offers nothing then)."],
  ["C5L-18", "minor, tests", "d1109-run-visible", "scripts/desktop-window-check.mjs passes trivially when the session has already ended, and reads document.title, not the native window title (state::window_title / set_main_title are covered only by Rust unit tests). Make it fail when no running state was seen; the native title and the tray stay for the owner's install walk."],
  ["C5L-19", "docs", "d1109-run-visible", "docs/maintainers/runtime.md says run.changed is poked by 'the wait list'; compose pokes it on session and project events, the scheduler's requestStart and cancelPending, and the calibration job's onRowChanged."],
  ["C5L-20", "minor, tests", "d1109-run-visible", "The real-daemon life-cycle case does not assert 'plans the session' during a live session (only through the restart ghost row)."],
  ["C5L-21", "decision", "d1109-cred-engine and d1109-run-visible", "Bench BEFORE walks: d1109-cred-engine made none (the code was changed first; the before behaviour is shown by the tests that failed before, e.g. billing-order 'From the API.' with nothing chosen); d1109-run-visible's ran on the base exported with git archive, not on a worktree branch. Accepted."],
  ["C5L-22", "decision", "d1109-run-visible", "The UI's unit suite runs in Node, so a browser-only failure (a value import that reaches a Node module) blanked every page while vitest stayed green during the fix; apps/ui/test/browser-imports.test.ts now guards the workspace packages, and Playwright with the real Vite build runs at every merge (it did at C5's). Accepted as is; keep Playwright in every merge's validation."],
  ["C5L-23", "decision", "d1109-run-visible", "The session log line written at the time of a wait keeps '...; then your session goes on.' after Cancel: a timestamped record of what was promised then, not a promise now. Accepted."],
  ["C5L-24", "minor, tests", "d1109-run-visible", "Not walked on a real desktop: the tray dot, tooltip and menu's first item, the native window title, the critic's monthly check on the bar (nothing on a running daemon can start it) and a working row past 49 steps (the stand-in's tasks stop at 30 parts). Covered by cargo tests, run-indicator.test.tsx and unit cases with 60 and 120 steps; the owner's install walk covers the tray and title (U-096)."],
  ...carried.map(([id, sev]) => [`C5L-${id}`, sev, "d1109-cred-engine (carried, not built in C5: time)", carriedText(id)]),
];

const forSessionLead = {
  changelog_update_log_lines: [
    "One credential choice for every call: until you pick one, chat, planning, reviews, the task check and the jobs use your Claude subscription first, like your tasks (the owner's answer 4).",
    "When your rule says wait, nothing moves to the API key; under 'then ask me' one card asks whether your API key does the work until the subscription is back, and the app says a card waits only while it is in the Inbox.",
    "A refused key or sign-in gets no further request until you save a new one, the model list included.",
    "A task that its credential stopped is finished from where it stopped, not started again.",
    "A running session shows on every page, in Talk, in the tray and in the window title; a session that waits says when it goes on, with Cancel. A start that waits behind another session shows on its project at once; after Cancel nothing says a session goes on by itself; the critic's monthly check shows on the bar while it runs.",
  ],
  u_entries:
    "U-096 (d1109-run-visible) check in the app, add: 'press Start on a second project while one runs: its line says \"Starts after the session on <first>\" at once; after Cancel on a waiting session, its Last result, Read aloud and Inbox Update say \"then it runs at your next Start.\"'. d1109-cred-engine amended U-078, U-052, U-048 and U-074 (read their check_in_the_app steps in runC-C5-fix-d1109-cred-engine.json and -fixup-).",
  adrs: "ADR 0120 'Which Claude does the work' (new; one dated line in 0114; amendments of 0100, 0044, 0098, 0112); ADR 0118 gained D8.",
  next_migration: "0011 (C5 added none)",
};

function place(areas) {
  for (const [key, { from, items }] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("C5-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("C5-left-")));
    const src = from
      .split(" and ")
      .map((k) => SRC(k))
      .join("; ");
    for (const [id, sev, text] of items) {
      a.problems.push(`[${sev}] ${id} (run C sub-run C5's leftover, from ${from}; read ${src}): ${text}`);
    }
    a.acceptance.push(
      `Run C sub-run C5's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason; a coverage case that passes at once says so and names what it guards.`,
    );
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync(
  "/tmp/frbench/leftovers-C5.json",
  JSON.stringify(
    {
      why:
        "Run C sub-run C5's leftovers that no C6 area owns, and the engine leftovers C5 carried but did not build. Triage them with live check 4's findings, /tmp/frbench/leftovers-L3.json, leftovers-C2.json, leftovers-C3.json, leftovers-C4.json, leftovers-C4b-design.json and leftovers-C4b.json (the next leftovers run). Sources: " +
        SRC("d1109-cred-engine") +
        "; " +
        SRC("d1109-run-visible") +
        ".",
      base: HEAD,
      items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
      for_session_lead: forSessionLead,
    },
    null,
    1,
  ),
);

// Live check 4: fold into existing steps.
const own = / C5 leftovers adds(?:(?! C\d\w?(?: leftovers)? adds)[^])*/;
const adds = {
  "LC-C20":
    "C5 leftovers adds (the merge's notes): scripts/desktop-window-check.mjs passes trivially once the session has ended and reads document.title, not the native title (C5L-18): read the job's log for the bar and the title while the session runs, not only its result; the tray dot, its tooltip and the native title stay for the owner's install walk (U-096).",
  "LC-C21":
    "C5 leftovers adds: after the refusal, the model-call log shows no further request with the refused key at all, GET /v1/models included (C5's fix-up of CE-8).",
  "LC-C23":
    "C5 leftovers adds: this step is now the only check of CE-5's repository case (no composed test, C5L-4): the task's branch holds the work-in-progress commit under the continuing run's commit; and the session log's switch line and the session page's switch line as C6 built them (C5-left-1).",
  "LC-C24":
    "C5 leftovers adds: 'Waits for your answer ... The card is in the Inbox.' shows only while the card is open; the answered card reads one 'Done:'; a Start pressed during the stop goes on at once after Use API key (C5's fix-up of blocking 1 to 3).",
  "LC-C31":
    "C5 leftovers adds: while the session waits, look at the Overview at 375 px and at 1280 px and record how often the wait and Cancel show (bar, Working now, status line) and whether the status line's Cancel reads clearly with its explanation only as a tooltip (C5L-11: the session lead decides at the triage); after Cancel, ask chat 'what happened last session?' and type 'summary': record whether either still says the session goes on (C5L-15).",
};
const l = p.live_check_4;
for (const s of l.steps) {
  s.step = s.step.replace(own, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C5-merge)"));
p.session_lead_decisions.push(
  "(C5-merge) Both C5 areas had a fix-up: C6 reads each one's runC-C5-fixup-<key>.json notes_for_other_areas first (they supersede the fix's where they differ), then runC-C5-fix-<key>.json's notes and not_done.",
  "(C5-merge) CE-11's switch data (the session log's switch line, billing.switch and billing.back, switchedFrom, SessionResult.switched, CostView.byCredential) was not built in C5; CS-5 (never cut) shows it, so d1109-cred-screens builds it first in C6 (C5-left-1, major), changing runner.ts only in the switch line's region.",
  "(C5-merge) CE-6 (the share reached mid-run as a credential stop) goes to the triage after live check 4 (C5L-1), not to C6: no C6 area owns the executor, and the share is held at every pick already, so no money passes it; until then a share reached mid-run still shows the plan-level budget card until the 1st.",
  "(C5-merge) The engine leftovers C5 carried but did not build (L3-left-14, C3-left-4, C3-left-5, C3-left-6, C4b-left-1) go to the triage after live check 4 (leftovers-C5.json), not to C6, which has no engine area; C4-left-11 goes to d1109-selftasks-chat with 'fix the tasks' (C5-left-7).",
  "(C5-merge) The status line's tooltip-only Cancel is not decided now: LC-C31 looks at the waiting Overview at both widths first (C5L-11).",
);

const c5 = p.sub_runs.find((s) => s.name === "C5");
c5.merged = Object.assign({}, c5.merged || {}, {
  head: HEAD,
  review: "fix-needed on both areas (cred-engine 5 blocking, run-visible 4 blocking); both fix-ups fixed every blocking item; the merge needed no fix-up commit",
  leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.items.map((i) => i[0])])),
  leftovers_for_triage: "/tmp/frbench/leftovers-C5.json",
});
if (!c5.merged.ci) c5.merged.ci = "pending: CI 312 (43958488578) and Desktop app 77 (43958488591), started 2026-11-16 21:17 UTC";

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log(
  "placed",
  Object.values(toAreas).flatMap((v) => v.items).length,
  "in",
  Object.keys(toAreas).length,
  "areas; triage",
  triage.length,
  "; live steps amended",
  Object.keys(adds).join(","),
  "; decisions",
  p.session_lead_decisions.length,
);
