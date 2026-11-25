// fixup-w8-status-write re-walk of the reviewer's first blocking item on the bench:
// Bob's GitHub cut, a session for a new task, his daemon restarted while still cut, GitHub on
// again, and no screen and no Settings or Docs read: his pending status text must reach the
// stand-in by itself (resumeAll at the start, then the minute's retry).
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-3";
const A = "fixup-w8-status-write";
const B = "fixup-w8-status-write-bob";
const benchJson = (n) => JSON.parse(fs.readFileSync(`/tmp/frbench/${n}/bench.json`, "utf8"));
const out = (s) => console.log(`[rewalk] ${new Date().toISOString().slice(11, 19)} ${s}`);
const log = () =>
  fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const statusWritesOf = (login) =>
  log().filter(
    (r) =>
      r.login === login &&
      r.method !== "GET" &&
      /\/issues(\/comments)?(\/\d+)?$/.test(r.path) &&
      !/\/pulls\//.test(r.path),
  );
async function api(name, method, route, body) {
  const b = benchJson(name);
  const res = await fetch(`${b.daemonUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const projects = await api(B, "GET", "/projects");
  const project = projects.find((p) => p.name === "Team site") ?? projects[0];
  const projectId = project.id;
  out(`Bob's project ${project.name}`);
  const before = statusWritesOf("bob").length;
  out(`cut: ${node([path.join(REPO, "scripts/bench/cut.mjs"), B, "github", "off"]).stdout.trim()}`);
  const agent = (await api(B, "GET", "/agents"))[0]?.id;
  await api(B, "POST", `/projects/${encodeURIComponent(projectId)}/tasks`, {
    title: "Write the restart note in restart.md",
    outcome: "restart.md holds one line",
    riskTier: 1,
    specialist: "coder",
  });
  const started = await api(B, "POST", "/sessions", { agentId: agent, projectId });
  const sid = started?.session?.id;
  for (let i = 0; i < 240; i++) {
    const s = await api(B, "GET", `/sessions/${sid}`);
    if (s.status !== "running") break;
    await sleep(1000);
  }
  out(`session ended; bob status writes while cut: ${statusWritesOf("bob").length - before}`);
  const r = node([path.join(REPO, "scripts/bench/restart-daemon.mjs"), "--name", B]);
  out(`restart: exit ${r.status} ${r.stdout.trim().split("\n").pop()}`);
  const atRestart = statusWritesOf("bob").length;
  out(`on: ${node([path.join(REPO, "scripts/bench/cut.mjs"), B, "github", "on"]).stdout.trim()}`);
  const t0 = Date.now();
  let sent = [];
  while (Date.now() - t0 < 100_000) {
    sent = statusWritesOf("bob").slice(atRestart);
    if (sent.some((w) => /\/issues\/comments\/\d+$/.test(w.path))) break;
    await sleep(1000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  out(`no screen open; after ${secs} s bob's status writes: ${JSON.stringify(sent.map((w) => `${w.method} ${w.path} ${w.at ?? ""}`))}`);
  const result = {
    at: new Date().toISOString(),
    secondsToFirstWrite: sent.length ? secs : null,
    writes: sent.map((w) => ({ method: w.method, path: w.path })),
  };
  fs.writeFileSync(`/tmp/frbench/${A}/steps/rewalk-restart-result.json`, JSON.stringify(result, null, 1));
  process.exit(sent.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
