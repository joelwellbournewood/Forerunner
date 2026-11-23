// Places run L4 sub-run L4d's leftovers (l4-cred-screens merged at 0288a46) into the later run L4 areas, and the
// rest into /tmp/frbench/leftovers-L4d.json. Idempotent: items tagged "(L4d leftovers)" are replaced.
const fs = require("fs");
const TAG = "(L4d leftovers)";
const SRC = "Sources: /tmp/frbench/runL4-L4d-{fix,review,fixup}-l4-cred-screens.json and runL4-L4d-merge.json.";
const place = {
  "l4-starts-sessions": [
    "[minor, words] L4d-left-1: under 'API key first, then subscription' with the key resting and mixed work, the Start dialog still says the work runs on the subscription and its figure covers work only the key can do; the plan card's foot line also says the subscription does the work meanwhile for tasks only the key can do. Name what waits for the key.",
    "[minor, decision] L4d-left-2: session lead decision (L4d merge, 2026-11-23): a start under a refused credential is refused in words outright, also with no session kept (POST /sessions, the phone, Continue), with the Start dialog's sentence; today it starts a session that meets the refusal, and the user guide already promises 'every Start says the same'. Keep ONE_OFF_UNDER_WAIT as built. The owner can overrule.",
    "[words] L4d-left-3: the Start dialog in the kept state ('Starts at 03:36 ...' with Cancel the wait) still offers Use API key with its CHF figure while the plan sentence is gone, so the figure names no task.",
    "[minor] L4d-left-4: L4-creds-21 part 1: an open Settings read-back stays in the Inbox as an approval card after the person leaves Settings; L4-creds-24: no Playwright cases for the credential section and the Start dialog at phone and desktop widths.",
  ],
  "l4-chat-carried": [
    "[minor] L4d-left-5: isHoldReply misses hold replies stored before L4d without the one-off press, so those still reach the model's history as assistant turns; drop every app hold reply from historyMessages, old ones included (a stored-row case).",
  ],
};
const rest = {
  why: "Run L4 sub-run L4d's leftovers that no later run L4 area owns.",
  base: "0288a46",
  items: [
    { id: "L4d-left-6", severity: "minor, performance", text: "GET /inbox calls rt.startCheck once for each open plan card only to read workBudgetUsdMicro (a route R-inboxperf optimised)." },
    { id: "L4d-left-7", severity: "minor", text: "setPersonZone runs inside the store reducer (a side effect): a screen rendered before /me answers is not re-rendered when the zone arrives, and a zone saved in Settings is read again only after a restart or a project switch." },
    { id: "L4d-left-8", severity: "tests", text: "L4a-left-4's queued-continuation status line has no real-daemon case; other '(s)' literals remain outside intake.ts and calibration.ts; the plan card foot line is about 104-117 characters under ask." },
    { id: "L4d-left-9", severity: "pre-existing", text: "Task rows show 'CHF 0.00' for unspent tasks." },
  ],
  for_session_lead: { live_checks_for_F: "Under 'ask' with the real subscription at its limit mid-session: compare the ask card's 'about CHF N' with the Start dialog's Use API key figure, then the actual spend after the yes." },
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
      for (const p of probs) d.triage.push({ n: p.match(/L4d-left-\d+/)[0], item: p.replace(/^\[[^\]]+\] /, ""), decision: "fix", area: key, evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4d.json", JSON.stringify(rest, null, 1));
console.log("placed", Object.values(place).flat().length, "; rest", rest.items.length);
