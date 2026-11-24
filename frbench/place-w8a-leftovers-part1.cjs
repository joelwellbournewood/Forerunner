// Places the two W8a leftovers that w8-status-write (first area of W8b) must see at its start, into wave8-plan.json and
// phaseE.json (area problems, items, triage). Idempotent: tagged "(W8a leftovers)".
const fs = require("fs");
const TAG = "(W8a leftovers)";
const SRC = "Sources: /tmp/frbench/runW8-W8a-{fix,review,fixup}-w8-repo-guide.json and -w8-issue-host.json, runW8-W8a-merge.json (problems_left).";
const KEY = "w8-status-write";
const items = [
  ["W8a-left-1", "major, never cut", "The repository guide claims a status issue that does not exist yet: guideStatusIssueState(project) in packages/runtime/src/loop/guide.ts always returns 'on' (w8-repo-guide), so every AGENTS.md written since W8a tells agents to read and announce in a pinned 'Forerunner status: <name>' issue that this base never creates. With the status issue built here, guideStatusIssueState returns the real state ('on', 'switched_off' or 'issues_off') and a change of state refreshes the guide in one docs pull request (W8-guide-1's untested half: the status issue's creation gives none, a change of its state one docs pull request; test it end to end on two homes)."],
  ["W8a-left-2", "minor, stand-in fidelity", "Two pre-existing stand-in GitHub bugs the status tests will meet (w8-issue-host new_problems): GET /repos/:o/:r/issues/comments (the repository-wide comment list) is registered after GET /issues/:number, so Hono runs the :number handler first; and repoJson's permissions.admin is true for any collaborator with push access and a repo-scoped classic token (checkRepoAccess(administration, write) passes). Fix both in packages/testenv with a contract case each."],
];
const lines = items.map(([id, sev, text]) => `[${sev}] ${id}: ${text} ${TAG} ${SRC}`);
for (const P of ["/tmp/frbench/wave8-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  const a = d.areas.find((x) => x.key === KEY);
  a.problems = a.problems.filter((p) => !String(p).includes(TAG)).concat(lines);
  a.items = a.items.filter((i) => !String(i).startsWith("W8a-left-")).concat(items.map(([id]) => id));
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !(String(t.note || "").includes(TAG) && t.area === KEY));
    for (const [id, sev, text] of items) d.triage.push({ n: id, item: `${id}: ${text}`, decision: "fix", area: KEY, evidence: SRC, note: `${TAG}${/never cut/.test(sev) ? " never cut" : ""}` });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
console.log("placed", items.length, "into", KEY);
