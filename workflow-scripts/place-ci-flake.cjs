// Places a Windows CI flake seen on Desktop app run 86 (0288a46) into run L4's l4-starts-sessions area.
// Idempotent: items tagged "(CI flake 86)" are replaced.
const fs = require("fs");
const TAG = "(CI flake 86)";
const SRC = "Source: Desktop app run 86 (job 137473459968, windows-latest, UI unit tests), 0288a46; the same case passed on run 87 at 77bb4fa and on Linux.";
const item = "[minor, tests, flaky] CI-flake-1: apps/ui/test/real-daemon.test.ts 'start session with a note: the session keeps it for every task's brief (design §4.6)' failed on Windows with ApiError 404 at line 290 (client.session(id)). The wait for the case before's session to end is bounded at 200 x 25 ms and its outcome is never checked; on a slow runner that session is still running, startSession answers without a session, id is '' and GET /sessions/ answers 404. Make the wait sure (wait on the session's end through the client or the daemon's own signal, with a bound that fails with its own message) and assert started.result is 'started' before reading the session; never weaken what the case checks. Look for the same bounded-poll-then-proceed shape in the other real-daemon cases and fix those that can race the same way.";
for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  const a = d.areas.find((x) => x.key === "l4-starts-sessions");
  if (!a) throw new Error(`${P}: no area l4-starts-sessions`);
  a.problems = (a.problems || []).filter((x) => !String(x).includes(TAG));
  a.problems.push(`${item} ${TAG} ${SRC}`);
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
    d.triage.push({ n: "CI-flake-1", item: item.replace(/^\[[^\]]+\] /, ""), decision: "fix", area: "l4-starts-sessions", evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
console.log("placed CI-flake-1 into l4-starts-sessions");
