// Places run L4 sub-run L4c's leftovers (l4-money-pause and l4-chat-answers merged at d526f40) into the later run L4
// areas, and the rest into /tmp/frbench/leftovers-L4c.json. Idempotent: items tagged "(L4c leftovers)" are replaced.
const fs = require("fs");
const TAG = "(L4c leftovers)";
const SRC = "Sources: /tmp/frbench/runL4-L4c-{fix,review,fixup}-<key>.json and runL4-L4c-merge.json (not_done, non_blocking, notes_for_other_areas).";
const place = {
  "l4-starts-sessions": [
    "[minor, words] L4c-left-1: under an outer limit (the project's budget or the month's cap) the session status and result read 'Stopped at the project's budget' / '... Stopped at the project's budget of CHF 0.06. CHF 0.02.' while a third of that budget is spent, and the Sessions row reads '1 paused · Stopped at the ...'; say what happened (the run paused before the limit). stop-words.ts.",
    "[minor, words] L4c-left-2: result.ts' 'Left for next time: ...; this session's CHF X was used.' branch (~:502-512) can still fire for after_others items when a larger task's pause ends the session with room left; the 'budget used' sibling of L4-money-102.",
    "[minor, words] L4c-left-3: L4-money-111 sibling: the session status reads 'Ended: 1 paused' and the log 'paused before its review' while the row says 'Done; its review waits'; one state, one wording.",
  ],
  "l4-github-merge": [
    "[minor] L4c-left-4: L4-github-110's Overview half: 'Waiting for you: approve the plan' shows twice after Add to (ProjectPage.tsx planBanner and IntakeBanner.tsx).",
  ],
  "l4-chat-carried": [
    "[minor] L4c-left-5: project-facts.ts' chat block says 'Paused: \"X\" at its budget' for a task whose review waits (L4-money-111); bump the conversation-agent principal from 1.5.1 to 1.5.2.",
    "[minor, security] L4c-left-6: the forged-line guard: withoutAppMarkers is case-sensitive ('the app did: …' passes through) and CHANGED's '^The app did:' does not allow a leading bracket prefix; only the app writes that line (add injection cases).",
    "[words] L4c-left-7: 'Nothing changed, and nothing waits for your yes. Say it again to try once more.' reads oddly when the person asked for no change (a status question the model answered with 'Shall I …?'); and the user guide promises 'a change you ask for always comes back as the app's question with Yes and No' while a second ask in words gets that sentence: make guide and code agree.",
    "[minor] L4c-left-8: 'absent' false positives ('I don't see any failed tasks.' in a 'what is left?' answer) cost an extra nudge and a recall call; narrow the absence claim.",
    "[words] L4c-left-9: parser questions repeat their options in the text and as buttons ('Which project: Notes or Site? Options: Notes, Site.'); the user guide does not mention 'add a task to <project>: …', 'open <project>' or 'This chat stays about <tab>'.",
    "[minor] L4c-left-10: namedProjectId is the registry's active project whenever any earlier turn switched; after a later header switch, 'there' should mean the project the conversation named. The fake daemon's chat does not play 'add a task to Site: …' or recall sources (stand-in gap).",
  ],
};
const rest = {
  why: "Run L4 sub-run L4c's leftovers that no later run L4 area owns: cut-line items, test-quality items, live checks and design-doc lines for the session lead. The money-pause correctness items (WORK_STATE guard etc.) go to the separate l4c-workstate fix.",
  base: "d526f40",
  items: [
    { id: "L4c-left-11", severity: "cut line", text: "l4-money-pause: L4-money-105 (a review-only pass priced at the whole remaining estimate), -107 (node --test helper that never exits blocks the review), -108 (settleSessions/removeHomes in older cases), -110 (a run again's spend missing from person lines), -113 (Left-to-do cut at 200 chars inside a word; emptyChangeSummary quote split), L4-money-106's card clause and the bench stand-in's max_tokens mode, L4-selftasks-107's composed case with a learned EstimatePort." },
    { id: "L4c-left-12", severity: "minor (carried twice)", text: "L4a-left-7: a critic review that meets the subscription's plan share is still a budget pause, not the credential stop 'share'." },
    { id: "L4c-left-13", severity: "cut line", text: "l4-chat-answers: L4-chat-105 (a closed project's lessons reach the kept project), -109 (recall ranking golden set), the L4-chat-113 reply check (scrub or flag tool names), the L4-chat-101 code-run recall fallback, the L4-chat-104 'switch' Open link; L4a-left-6 (L4-creds-6 composed test), L4b-left-9 (dependenciesNextLine with the hands-off setting)." },
  ],
  for_session_lead: {
    update_log: "U-089 (a), (b) and its 104/107 additions, U-042's review-waits and session-review lines, U-097 (outer limits: new, file it) from l4-money-pause's fixed[].check_in_the_app; l4-chat-answers' suggested line in its notes_for_other_areas.",
    design_doc_changes: "core-experience.md section 3.9: 'Yes to what? Nothing is waiting for your yes. Say what you want done, for example \"run it now\" to start a session.'; the From line lists the records the reply names among this turn's lookups.",
    live_checks_for_F: "F-9: a researcher report ending 'Left to do: nothing the criteria require.' finishes in the same session; a real fast model's clarifying request (e.g. 'add a note to the task') is not replaced; 'add a task to re-check the prices'; LC-C10 recall again (needs 10 of 12 with date).",
  },
};
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
      for (const p of probs) d.triage.push({ n: p.match(/L4c-left-\d+/)[0], item: p.replace(/^\[[^\]]+\] /, ""), decision: "fix", area: key, evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4c.json", JSON.stringify(rest, null, 1));
console.log("placed", Object.values(place).flat().length, "into", Object.keys(place).join(", "), "; rest", rest.items.length);
