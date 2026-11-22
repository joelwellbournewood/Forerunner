// Places run L4 sub-run L4a's leftovers (l4-cred-engine merged at ecd437a) into the later run L4 areas of
// /tmp/frbench/runL4-plan.json and /tmp/frbench/phaseE.json, and the rest into /tmp/frbench/leftovers-L4a.json.
// Idempotent: problems and triage items tagged "(L4a leftovers)" are replaced.
const fs = require("fs");
const TAG = "(L4a leftovers)";
const SRC = "Sources: /tmp/frbench/runL4-L4a-{fix,review,fixup}-l4-cred-engine.json and runL4-L4a-merge.json (problems_left, notes_for_other_areas).";
const place = {
  "l4-cred-screens": [
    "[minor] L4a-left-1: POST /sessions checks continuations.waiting before startBlocked, so a start from the API, the phone or the session page's Continue made while a refused credential's session is kept gets 'Your session of 10:00 goes on by itself once its Claude credential is back.' instead of the Start dialog's 'Nothing can run until you save a new API key in Settings.' Fix: the refused-credential check first, the same sentence as the dialog and chat (L4-creds-8).",
    "[words] L4a-left-2: keptWait's 'once its Claude credential is back' names no step for a refused credential (design section 5 rule 8); the session page's ended-to-wait block and the running bar read it. Name the step (save a new key / sign in again).",
    "[words] L4a-left-3: the running bar shows 'Nothing starts when Claude is back; its tasks wait for your Start.' beside 'waiting until 10:26, then it goes on' (contradiction); the session page's header and log times use the browser's zone while the waits use the person's zone.",
    "[minor] L4a-left-4: L4-creds-9 part 3 (not on the cut line): a project whose continuation is queued behind another project's session has no own status line ('Goes on after the session on \"Map notes\".'); the run bar names it as next (built in L4a), project-status/run-wait-words.ts does not.",
  ],
  "l4-starts-sessions": [
    "[minor] L4a-left-5: L4-creds-8 part 3 (not on the cut line): chat's 'run it now' during a rest is not kept for the reset: the read-back says 'Start a session on Map notes (up to CHF 5)?' and the session then ends at once to wait (nothing moves or is spent). Build: session.start calls continuations.keepStart with its own read-back ('Start a session on ... at 15:40') and Undo dropping it; the hold reply's 'a Start now runs at 15:40' clause then comes back.",
  ],
  "l4-chat-answers": [
    "[tests] L4a-left-6: L4-creds-6's composed test covers only the not-offered case: assert the plan-form footer and the ask line on an answered chat on the subscription, and the ledger row (kind subscription, planUsageShare).",
  ],
  "l4-money-pause": [
    "[minor] L4a-left-7: a critic review that meets the subscription's plan share is still a budget pause, not the credential stop 'share' that L4a made for task runs (L4-creds-1); route it the same way under the person's policy.",
  ],
};
const rest = [
  { id: "L4a-left-8", severity: "cut line", text: "C3-left-5 cases (the handover test's continuation, Stop now during a continuation, project removal dropping its continuation, a readmit case where B is not already promised), L4-creds-12 (background jobs marked 'not done for the period' after a held call, with a log line), the L4-creds-13 bench half (a Claude Code stand-in on the bench that does work and reports the limit) and L4-creds-14 (BA-7's composed restart cases and BA-3's effort-max case in task-budget-all.test.ts)." },
  { id: "L4a-left-9", severity: "minor, security", text: "scrubEnv (packages/runtime/src/agent/sdk.ts) passes the host's CLAUDE* and CCR_* variables to the Claude Code subprocess; pass only what the run needs." },
  { id: "L4a-left-10", severity: "minor", text: "validZone still falls back to UTC for other callers; scheduled jobs read the person's zone at start (L4a made the credential paths read it at each use)." },
  { id: "L4a-left-11", severity: "minor, tests", text: "The bench recorder writes the bench token into requestfailed URLs in problems.jsonl." },
  { id: "L4a-decision-1", severity: "decision", text: "Session lead decision (L4a merge, 2026-11-22): the share ask card's title stays 'Use your API key until Tue 1 Dec?' (the existing share form, as the triage said); the time of day adds nothing at a month boundary." },
];
for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  for (const [key, probs] of Object.entries(place)) {
    const a = d.areas.find((x) => x.key === key);
    if (!a) throw new Error(`${P}: no area ${key}`);
    a.problems = (a.problems || []).filter((x) => !String(x).includes(TAG));
    for (const p of probs) a.problems.push(`${p} ${TAG} ${SRC}`);
  }
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
    for (const [key, probs] of Object.entries(place))
      for (const p of probs) d.triage.push({ n: p.match(/L4a-left-\d+/)[0], item: p.replace(/^\[[^\]]+\] /, ""), decision: "fix", area: key, evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4a.json", JSON.stringify({ why: "Run L4 sub-run L4a's leftovers that no later run L4 area owns (cut-line items and small findings): for the final check F or a polish area.", base: "ecd437a", items: rest }, null, 1));
console.log("placed", Object.values(place).flat().length, "into", Object.keys(place).join(", "), "; rest", rest.length);
