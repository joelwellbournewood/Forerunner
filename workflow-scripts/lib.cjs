// Shared helpers for the merged-actions review walk.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_b3c7133a-8f5-3";
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const n = "review-merged-actions";
const benchDir = `/tmp/frbench/${n}`;
const stateFile = `${benchDir}/review-state.json`;
const gh = JSON.parse(fs.readFileSync(`${benchDir}/githost.json`, "utf8"));
const bench = () => JSON.parse(fs.readFileSync(`${benchDir}/bench.json`, "utf8"));

async function ghApi(method, route, body) {
  const res = await fetch(`${gh.url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${gh.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const bare = (full) => path.join(benchDir, "githost", `${full}.git`);
function hostGit(full, ...args) {
  const dirs = [bare(full), path.join(benchDir, "githost", full)];
  const dir = dirs.find((d) => fs.existsSync(d));
  return execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" }).trim();
}

/** Push a commit onto main of the host repo (a "later change" made elsewhere). */
function pushToMain(full, files, message) {
  const tmp = fs.mkdtempSync(path.join(benchDir, "push-"));
  const url = `${gh.url.replace("http://", `http://x-access-token:${gh.token}@`)}/${full}.git`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: "someone@example.test",
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: "someone@example.test",
  };
  execFileSync("git", ["clone", "-q", url, tmp], { env });
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), c);
  }
  execFileSync("git", ["-C", tmp, "add", "-A"], { env });
  execFileSync("git", ["-C", tmp, "commit", "-q", "-m", message], { env });
  execFileSync("git", ["-C", tmp, "push", "-q", "origin", "HEAD:main"], { env });
  const sha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.rmSync(tmp, { recursive: true, force: true });
  return sha;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

async function idle(projectId, ms = 600_000) {
  await R.until(
    async () => {
      const card = await R.api(n, "GET", `/projects/${projectId}`);
      const tasks = await R.api(n, "GET", `/projects/${projectId}/tasks`);
      const moving = tasks.some((t) => ["claimed", "in_progress", "in_review"].includes(t.status));
      return !card.working && !moving && tasks.length > 0;
    },
    ms,
    3000,
    "the session to end",
  );
}

const tasksOf = (id) => R.api(n, "GET", `/projects/${id}/tasks`);
const prsOf = (id) => R.api(n, "GET", `/projects/${id}/pull-requests`);

module.exports = { R, n, gh, ghApi, hostGit, pushToMain, loadState, saveState, idle, tasksOf, prsOf, bench, benchDir, fs, path };
