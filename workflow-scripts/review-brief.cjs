// Start a session on a project and look for a note in the specialist's brief (model-call log).
// Usage: node review-brief.cjs <bench name> <repo root> <walk json> <note words>
const [name, repo, walkJson, words] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
(async () => {
  const projectId = JSON.parse(fs.readFileSync(walkJson, "utf8")).project;
  const before = (await R.modelCalls(name)).length;
  const s = await R.startSession(name, projectId);
  const id = s?.session?.id;
  await R.waitForSession(name, id, 120000).catch((e) => console.log("wait:", String(e).slice(0, 200)));
  const calls = (await R.modelCalls(name)).slice(before);
  const hit = calls.filter((c) => JSON.stringify(c.messages ?? "").includes(words));
  console.log(
    JSON.stringify({ started: s?.result, calls: calls.length, roles: calls.map((c) => c.role), withNote: hit.length }),
  );
  if (hit[0]) {
    const text = JSON.stringify(hit[0].messages);
    const i = text.indexOf(words);
    console.log(text.slice(Math.max(0, i - 700), i + 200));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
