// Places run C step 3's leftovers (C3 merged at 46c516d): into later run C areas (C4-C6, problems +
// acceptance) where an area owns the code, otherwise into /tmp/frbench/leftovers-C3.json for the triage
// after live check 4. Folds C3's real-model checks into existing live check 4 steps (no new step, no new
// cost) and adds session lead decisions.
// Idempotent: earlier C3-left entries, " C3 adds:" segments and "(C3)" decisions are replaced.
const fs = require("fs");
const E = "/tmp/frbench/phaseE.json";
const P = "/tmp/frbench/runC-plan.json";
const e = JSON.parse(fs.readFileSync(E, "utf8"));
const p = JSON.parse(fs.readFileSync(P, "utf8"));
const HEAD = "46c516dc193179e8fb8f2f12fde091077c8648e7";
const src = (k) => `/tmp/frbench/runC-C3-fix-${k}.json, -review- and -fixup- (not_done, new_problems, notes_for_other_areas)`;

const toAreas = {
  "d1109-onerepo-join": [
    ["C3-left-1", "minor, CI", "d1109-chat-depth", "apps/ui/test/sessions-tab.test.tsx (d1109-sessions, merged in C1; case SL-7) fails in the hours after UTC midnight ('16 Nov, 01:xx ·' against /^\\d\\d:\\d\\d ·/; seen at 01:xx and 02:31 UTC on 2026-11-16) and passes with TZ=Etc/GMT-12: the test reads the real clock. Pin its clock (and any sibling in that file that reads today's date) so CI passes at every hour; the assertion's intent stays (a row of today shows the time, an older row the day). This area changes session-list.ts's rows for joined projects."],
    ["C3-left-2", "minor", "d1109-starts-engine", "From d1109-starts-engine's note: keptStartOf now also returns a Start kept by POST /sessions while the credential rests ('Start at 15:40'), besides the hands-off start; Make one project refuses while a kept continuation, a kept start or a pending start waits on either project (keptContinuationOf, keptStartOf, startPendingOf), with a case for each."],
  ],
  "d1109-selftasks-run": [
    ["C3-left-3", "words", "d1109-starts-engine", "Every answer path calls prepareAnswer without taskIds (cannot-run-card.ts:195, findings.ts:233 and :702, person-questions.ts:1079 and :1186, pr-answers.ts:242 and :392), so admit takes every ready task of the project and summarize() answers 'joined' if any one joined: the Done line can say 'It joins the session that is running.' when the answered task did not fit. Pass the answered task's ids and word the line for that task (design section 5: a sentence promises only what the app does). This area's added tasks go through the same admit rule; it re-runs session-join.test.ts."],
  ],
  "d1109-cred-engine": [
    ["C3-left-4", "minor", "d1109-starts-engine", "Chat's session.start ('run it now', after its yes) while the credential rests is not kept for the reset the way the Start dialog's Start is (ADR 0118's known gap): chat's start meets the wait. Keep it as POST /sessions does ({result: 'kept'}, RuntimeApp.continuations.keepStart), with its own undo (dropping the kept start) and read-back sentence, under the policy this area builds."],
    ["C3-left-5", "minor, tests", "d1109-starts-engine", "The continuation's test gaps (d1109-starts-engine's review): the handover-test continuation, Stop now (as opposed to Stop after this task), the project's removal dropping a continuation, a restart after an answered card (S-2), and a readmit case that fails without readmit (session-join.test.ts's S-7 readmit case is vacuous because B is already promised). This area calls readmit and personContinue: each case fails first where it can."],
    ["C3-left-6", "minor", "d1109-chat-depth", "compose's chatRoom reads only the month cap and the project's budget: the subscription's plan share is not a cap level for chat, so the Claude-plan form of the footer and the ask line (askLine and handOverStep's plan form) is exercised only by words tests, and there is no composed chat case on a Claude subscription. Add the plan share to chatRoom with the policy, and a composed case on the subscription stand-in (the footer, the ask line and the booking)."],
  ],
  "d1109-run-visible": [
    ["C3-left-7", "minor", "d1109-starts-engine", "Not built in C3 and not in its not_done (d1109-starts-engine's review): the Start dialog's 'Starts after the session on \"Quote page\"' while another project's session runs (decision D6-7; StartSessionDialog.tsx:489 still says 'Starts after the current session' without naming it), and the Continue prefill that sends POST /sessions with continues (after Cancel the wait, or a session's Continue). This area shows the same waiting person start on the run indicator: build both with it, one sentence for one state."],
    ["C3-left-8", "words", "d1109-starts-engine", "After Cancel the wait, the ended session's stored summary still reads 'Waits until 02:23 …; then your session goes on.' on its page and in the Sessions list (a stale promise; review walk D). The continuation's words follow the kept state wherever they show, as the indicator does: after Cancel, nothing says the session goes on."],
  ],
  "d1109-cred-screens": [
    ["C3-left-9", "words", "d1109-starts-engine", "BillingOrderSection.tsx's 'Resting until HH:MM (its usage limit); your session that waits for it goes on then' shows whether or not a session waits (design section 5 rule 9). And the Start dialog's line 'Nothing can run until 03:43 (…). Press Start and the work starts then.' sits beside the button that now reads 'Start at 03:43': one sentence that matches the button (asserted in W15-65 and TR-2; update them keeping their intent)."],
  ],
  "d1109-selftasks-chat": [
    ["C3-left-10", "minor, security", "d1109-chat-depth", "No pnpm test:injection case covers chat's hand-over channel (a record's words asking for a thorough answer, a stronger model or a higher amount): evals/src/injection-runner.ts matches each attempt to a command result in order, and answer_thoroughly is not a command. Add a judge for hand-over attempts and cases with controls (the composed card test is the only cover now). This area shares agent.ts's model path."],
    ["C3-left-11", "minor", "d1109-chat-depth", "Stop pressed while the claim guard's nudge runs: `stopped` is read before the nudge, so the reply is the guard's true line, the turn's row is not marked stopped and no stopped footer shows. A Stop at any point of the turn ends it as stopped, with its money line."],
  ],
};

const triage = [
  ["C3L-1", "minor", "d1109-starts-engine", "L3-left-12, carried (not built in C3): a review-only session's plan line and session review use the writer's estimate ('Plan: 1 task, about CHF 0.03.'; the review measured against item.estimateUsdMicro). It needs a review-only estimate in the estimates model (l3-money-engine's module)."],
  ["C3L-2", "words", "d1109-starts-engine", "S-11 (cut line): 'go ahead and run it' is not parsed as a start (the parser splits on 'and', so the line goes to the chat model, whose session_start is read back too); no German start phrases."],
  ["C3L-3", "words", "d1109-starts-engine", "S-3 (cut line): Settings' change line after a budget raise does not say what follows ('Raised: … it runs at your next Start'); the cards and row words do."],
  ["C3L-4", "words", "d1109-starts-engine", "With the hands-off setting turned on later, its session also runs a task made ready while it was off, whose line had said 'It runs at your next Start.': say so in the setting's effect line."],
  ["C3L-5", "words", "d1109-starts-engine", "Chat's start read-back says 'up to CHF 5' (formatChfShort drops .00): money reads with two decimals (design section 5 rule 7)."],
  ["C3L-6", "minor", "d1109-starts-engine", "runner.ts: priceNow was inserted between reviewOnlyResult's JSDoc and its function, so that doc comment sits on priceNow."],
  ["C3L-7", "words", "d1109-chat-depth", "Sibling of L3-left-11: every chat failure but the timeout still reads 'I could not answer (<error message>).', a raw state in brackets; some messages carry meaning (conversation.test.ts asserts 'month cap reached'), so it needs one sentence per error code (caps, credentials, provider errors)."],
  ["C3L-8", "words", "d1109-chat-depth", "Once another line follows an ask line, the old line stays as text ending 'Go ahead?' with no button, a question the person can no longer answer (a typed yes then answers nothing: 'Yes to what?'): dim it or word it as past."],
  ["C3L-9", "minor", "d1109-chat-depth", "C2-left-7's end: Inbox, Overview and Changes do not read ?answered=, ?request=, ?decision= or ?projectId=, so the From line names those records with no link (the spec allowed it); making those pages open the record is page work."],
  ["C3L-10", "minor, tests", "d1109-chat-depth", "Chat depth's missing acceptance cases: Stop leaves a task the turn added with its Undo; chat_ask_above at CHF 1.00 (a CHF 0.40 longer pass goes ahead, a stronger one still asks); the project-budget cap line composed; at least three lookups before the wrap-up on a 10,000-token context; Costs' 'Planning and chat' growing; after composing twice, the ask repeated with new figures when the price changed; Answer now has no test that fails without it (SessionBudget.wrapUpNow untested)."],
  ["C3L-11", "minor", "d1109-chat-depth", "figuresOf runs on every typed quick turn before the first model call (it builds the thorough request's tool registry, counts its tokens and reads up to 200 chat.reply rows): unmeasured latency on the 1 s first-token path; LC-C12 reads it."],
  ["C3L-12", "minor", "d1109-chat-depth", "depth.ts still exports askAboveWords ('asks first above CHF 0.10'), used only by its words test; the settings words come from commands' chatAskAboveWords: remove the dead export."],
  ["C3L-13", "minor", "merge-w19", "With both C3 areas, every chat request is about 3% larger; on flatPricing the default USD 0.05 turn floor no longer holds six calls of a lookup-heavy turn (the merge gave one test the ceiling). On the real chat model's prices the floor holds far more; LC-C10 watches for 'I could not answer (run budget would be exceeded).' on a lookup-heavy turn."],
  ["C3L-14", "decision", "d1109-chat-depth", "In a project with a failed task's card listed in full, every chat change (task_create and the rest) waits for a Yes (d1109-chat-guard's read-back after records), even when nothing in the card reads like instructions (bench: 'Add \"Write the FAQ page\" to Quote Page?'). By design; the owner sees it in LC-C13, then decide whether an unflagged card should keep that rule."],
  ["C3L-15", "minor, tests", "ci-307-fix review", "The 'once' / 'no second one' / 'nothing more' checks tick right after 'task done' while that session may still be active; a start made by mistake at those ticks is queued (scheduler.pendingFor), not started, and with startServices false nothing drains it until a later tick, so the count right after can miss it (continuation.test.ts about :281-284, :465-472, :585-586; start-by-itself.test.ts about :197-199, :310-311). Strengthen without loosening: await settleSessions(rt) before the 'nothing more' ticks and before the count, and expect(rt.scheduler.pendingFor(rt.agent.id)).toBeUndefined()."],
  ["C3L-16", "minor, CI", "ci-307-fix review", "Windows: other composed tests close while a session's tail may still run and then remove the home with plain rmSync, or compose again on the same home (stop-by.test.ts:288-289 after POST /shutdown; capabilities-wiring.test.ts:373-378; budget-pause.test.ts:461 and :1381; oversized-task.test.ts:218 and :451). They passed on Windows CI so far; give each the same settleSessions and removeHomes (packages/runtime/test/helpers.ts, ba9874a) where a session can still run."],
];

function place(areas) {
  for (const [key, items] of Object.entries(toAreas)) {
    const a = areas.find((x) => x.key === key);
    if (!a) throw new Error(`no area ${key}`);
    a.problems = a.problems.filter((x) => !(typeof x === "string" && x.includes("C3-left-")));
    a.acceptance = (a.acceptance || []).filter((x) => !(typeof x === "string" && x.includes("C3-left-")));
    for (const [id, sev, from, text] of items) {
      a.problems.push(`[${sev}] ${id} (run C step 3's leftover, from ${from}; read ${src(from)}): ${text}`);
    }
    a.acceptance.push(`Run C step 3's leftovers ${items.map((i) => i[0]).join(", ")}: each has a failing test first (model-facing text asserted exactly; person-facing words checked against design section 5), or ends in not_done with the reason.`);
  }
}
place(e.areas);
place(p.areas);

fs.writeFileSync("/tmp/frbench/leftovers-C3.json", JSON.stringify({
  why: "Run C step 3's leftovers that no later run C area owns. Triage them with live check 4's findings, /tmp/frbench/leftovers-L3.json and leftovers-C2.json (the next leftovers run). Sources: /tmp/frbench/runC-C3-{fix,review,fixup}-<key>.json and runC-C3-merge.json problems_left.",
  base: HEAD,
  items: triage.map(([id, severity, from, text]) => ({ id, severity, from, text })),
}, null, 1));

// Live check 4: fold C3's real-model checks into the steps that already make those journeys.
const adds = {
  "LC-C10": "C3 adds: note whether a lookup-heavy turn ever answers 'I could not answer (run budget would be exceeded).' (C3L-13).",
  "LC-C12": "C3 adds: read the first-token time on Performance with figuresOf on the quick path (C3L-11).",
  "LC-C13": "C3 adds (d1109-chat-depth's fix-up): in a project whose task failed and whose card waits, the failure question gets 'This needs a stronger model: … Go ahead?', Go ahead runs it, and the answer names the cause from the run's report; note whether the real chat model calls answer_thoroughly {why: failure} or answers alone, and how often it asks in vain; note how it feels that every chat change there waits for a Yes (C3L-14).",
  "LC-C16": "C3 adds: Enter pressed while an answer is made does not stop it; Think it through never shows under a change.",
  "LC-C18": "C3 adds (d1109-starts-engine): each Inbox option says what pressing it does as things stand (it joins the running session if it fits, or it runs at your next Start), and the Done line names the answered task's own outcome (C3-left-3).",
  "LC-C31": "C3 adds: the continuation's first log line is 'Goes on with your session of HH:MM.'; while the credential rests, Start reads 'Start at HH:MM' and keeps one start; with quiet hours covering the reset, every line names when the session really goes on; after Cancel the wait, nothing anywhere says the session goes on (C3-left-8).",
};
const l = p.live_check_4;
const own = / C3 adds(?:(?! C\d\w?(?: leftovers)? adds)[^])*/;
for (const s of l.steps) {
  s.step = s.step.replace(own, "");
  if (adds[s.id]) s.step = `${s.step} ${adds[s.id]}`;
}
for (const id of Object.keys(adds)) if (!l.steps.find((s) => s.id === id)) throw new Error(`no step ${id}`);

// Session lead decisions.
p.session_lead_decisions = p.session_lead_decisions.filter((x) => !String(x).startsWith("(C3)"));
p.session_lead_decisions.push(
  "(C3) S-8: a session's plan keeps the estimate the person was shown at Start; an edit to a planned task refreshes its title and specialist but its estimate is not priced again mid-session (the promise and the session review's measure stay what the person saw). Accepted (on the spec's cut line).",
  "(C3) L3-left-9 for a spoken turn: a voice turn has already spoken a claim before the guard catches it; the speaker cannot take words back, and holding each sentence for a check would slow the voice loop. Accepted as a known limit (runtime.md, ADR 0114); typed and Talk bubbles are reset.",
  "(C3) packages/commands/src/commands/settings.ts's start_by_itself comment quotes the owner's own message of 2026-11-09 word for word ('Only when you say so is the default with the hands-off setting optional. Yes, that sounds good.'); the merge step's note calling it a misquote is wrong, and nothing changes.",
  "(C3) conversation-agent 1.4.0 waits for the forerunner-registry repository like 1.3.0 (see the C2 decision).",
);

const c3 = p.sub_runs.find((s) => s.name === "C3");
c3.merged = {
  head: HEAD,
  ci: "pending at placement (CI run 43804425585, Desktop app run 43804425507)",
  leftovers_placed: Object.fromEntries(Object.entries(toAreas).map(([k, v]) => [k, v.map((i) => i[0])])),
  leftovers_for_triage: "/tmp/frbench/leftovers-C3.json",
};

fs.writeFileSync(E, JSON.stringify(e, null, 1));
fs.writeFileSync(P, JSON.stringify(p, null, 1));
console.log("placed", Object.values(toAreas).flat().length, "in", Object.keys(toAreas).length, "areas; triage", triage.length, "; live steps amended", Object.keys(adds).join(","), "; cap", l.cap_usd);
