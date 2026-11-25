// Places W8b-left-1 (privacy, never cut) into w8-shared-repo: the repository guide's status-issue title is written
// without the board's redaction. Idempotent: tagged "(W8b leftovers)".
const fs = require("fs");
const TAG = "(W8b leftovers)";
const KEY = "w8-shared-repo";
const id = "W8b-left-1";
const text = "The repository guide writes the status issue's title (statusIssueTitle in packages/runtime/src/loop/guide.ts, 'Forerunner status: <name>') with the project name as typed, while the status board redacts the same name with safeLine/redactQuoted (w8-status-write fix report, new_problems). A project name holding an email address, a figure or a token-like string reaches AGENTS.md on GitHub. Use the board's redaction for every project name the guide writes (title, headings, the together line), with a case per kind (email, CHF figure, token-like) on the guide's text and on the docs pull request's body.";
const line = `[major, never cut, privacy] ${id}: ${text} ${TAG} Sources: /tmp/frbench/runW8-W8b-fix-w8-status-write.json (new_problems); the session lead's check.`;
for (const P of ["/tmp/frbench/wave8-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  const a = d.areas.find((x) => x.key === KEY);
  a.problems = a.problems.filter((p) => !String(p).includes(`${id}:`)).concat([line]);
  a.items = a.items.filter((x) => x !== id).concat([id]);
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => t.n !== id);
    d.triage.push({ n: id, item: `${id}: ${text}`, decision: "fix", area: KEY, evidence: "runW8-W8b-fix-w8-status-write.json", note: `${TAG} never cut` });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
console.log("placed", id, "in", KEY);
