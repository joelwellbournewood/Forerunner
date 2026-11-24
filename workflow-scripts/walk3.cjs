// Review walk 3: Ada's guide kept current. Merge the plan's docs PR, change who merges, run a
// session while Bob's unmarked PR sits on fr/docs-scaffold; then close Bob's PR, run again; then
// restart Ada's daemon and run once more.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const A = "review-w8-repo-guide";
const WT = "/home/user/Forerunner/.claude/worktrees/wf_245aa20b-b1c-7";
const GH = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const gh = async (login, method, route, body) => {
  const res = await fetch(`${GH.url}${route}`, {
    method,
    headers: {
      authorization: `token ${GH.users[login].token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const raw = async (ref, path) => {
  const res = await fetch(
    `${GH.url}/repos/team/shared/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { headers: { authorization: `token ${GH.users.ada.token}`, accept: "application/vnd.github.raw" } },
  );
  return res.status === 200 ? res.text() : null;
};
const docsPrs = async () =>
  (await gh("ada", "GET", "/repos/team/shared/pulls?state=all&per_page=100"))
    .filter((p) => /^fr\/docs-scaffold/.test(p.head.ref))
    .map((p) => [p.number, p.head.ref, p.user.login, p.state]);
const writesTo = (n) =>
  fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.login === "ada" && r.method !== "GET" && new RegExp(`/(pulls|issues)/${n}(/|$)`).test(r.path));

async function oneSession(id, title) {
  const me = await R.api(A, "GET", "/me");
  await R.api(A, "POST", `/projects/${id}/tasks`, {
    title,
    outcome: `${title} is done`,
    riskTier: 1,
    specialist: "coder",
  });
  const started = await R.api(A, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: id,
    trigger: "manual",
    reason: "review walk",
  });
  const sid = started.session?.id ?? started.sessionId;
  const s = await R.waitForSession(A, sid, 300_000);
  console.log(`session for "${title}": ${s.status}`);
}

(async () => {
  const { number: bobPr, team } = JSON.parse(
    fs.readFileSync("/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/bobpr.json", "utf8"),
  );
  console.log("docs PRs at start", JSON.stringify(await docsPrs()));
  // 1. Merge the plan's docs pull request (#1) as Ada presses Merge.
  const m = await R.api(A, "POST", `/projects/${team}/pull-requests/1/merge`, {});
  console.log("merge #1:", JSON.stringify(m).slice(0, 300));
  await R.until(async () => (await gh("ada", "GET", "/repos/team/shared/pulls/1")).merged, 120_000, 2000, "#1 merged");
  console.log("main AGENTS.md has Work together:", ((await raw("main", "AGENTS.md")) ?? "").includes("choose Work together"));
  // 2. Ada changes who merges.
  const proj = await R.api(A, "GET", `/projects/${team}`);
  const set = await R.apiRaw(A, "PUT", `/projects/${team}/settings`, {
    version: proj.version,
    settings: { merge_mode: "after_review" },
  });
  console.log("settings:", set.status);
  // 3. A session while Bob's unmarked PR is on fr/docs-scaffold.
  await oneSession(team, "Write the team page in team.md");
  console.log("docs PRs after session 1", JSON.stringify(await docsPrs()));
  console.log("ada's writes to bob's #", bobPr, JSON.stringify(writesTo(bobPr)));
  // 4. Bob closes his pull request; another session.
  await gh("bob", "PATCH", `/repos/team/shared/pulls/${bobPr}`, { state: "closed" });
  await oneSession(team, "Write the news page in news.md");
  const after2 = await docsPrs();
  console.log("docs PRs after session 2", JSON.stringify(after2));
  const own = after2.find((p) => p[2] === "ada" && p[3] === "open");
  if (own) {
    const agents = (await raw(own[1], "AGENTS.md")) ?? "";
    console.log(
      "guide PR says after_review:",
      agents.includes("merges its pull requests itself once its critic accepted them"),
    );
    const pr = await gh("ada", "GET", `/repos/team/shared/pulls/${own[0]}`);
    console.log("---- guide PR body\n", pr.body);
    const files = await gh("ada", "GET", `/repos/team/shared/pulls/${own[0]}/files`);
    console.log("files:", files.map((f) => f.filename).join(", "));
  }
  console.log("ada's writes to bob's #", bobPr, JSON.stringify(writesTo(bobPr)));
  // 5. Restart Ada's daemon; one more session: no second guide PR.
  execFileSync("node", [`${WT}/scripts/bench/restart-daemon.mjs`, "--name", A], { stdio: "inherit" });
  await oneSession(team, "Write the about page in about.md");
  console.log("docs PRs after restart + session 3", JSON.stringify(await docsPrs()));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
