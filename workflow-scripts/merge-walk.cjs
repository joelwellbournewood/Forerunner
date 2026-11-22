// Bench walk for the merge record (ADR 0111). Usage:
//   node merge-walk.cjs <bench name> <repo root> <label> chain|restart
// chain:   a repository project on the stand-in GitHub, "Add page" accepted at Standard (left
//          open), then autonomy Trusted and "Add footer" that depends on it; main moves on the
//          host as soon as the footer's pull request opens, so between the accept and the merge.
// restart: one task at Trusted whose check is still running when it is accepted; the daemon is
//          stopped while it runs, the check turns green, the daemon starts again.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const [name, repoRoot, label, mode] = process.argv.slice(2);
const R = require(path.join(repoRoot, "scripts/bench/recorder.cjs"));
const dir = path.join("/tmp/frbench", name);
const gh = JSON.parse(fs.readFileSync(path.join(dir, "githost.json"), "utf8"));
const bare = path.join(dir, "githost", "bench", "seeded.git");
const out = path.join(dir, `merge-walk-${label}.json`);
const log = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  log.push(line);
  console.log(line);
};

async function host(method, route, body) {
  const res = await fetch(`${gh.url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${gh.token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${route} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const git = (...args) => execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" }).trim();
const graph = () => git("log", "--graph", "--format=%h %p %s", "main");
const pulls = async () =>
  (await host("GET", "/repos/bench/seeded/pulls?state=all&per_page=100")).map((p) => ({
    number: p.number,
    head: p.head.ref,
    headSha: p.head.sha.slice(0, 7),
    state: p.state,
    merged: p.merged ?? !!p.merged_at,
    mergeCommit: p.merged ? (p.merge_commit_sha ?? "").slice(0, 7) : null,
  }));
const moveMain = async (file) =>
  host("PUT", `/repos/bench/seeded/contents/${file}`, {
    message: `someone changed main: ${file}`,
    content: Buffer.from(`${file} changed on main\n`).toString("base64"),
    branch: "main",
  });
const check = async (sha, status, conclusion) =>
  host("POST", "/repos/bench/seeded/check-runs", {
    name: "ci/test",
    head_sha: sha,
    status,
    ...(conclusion ? { conclusion } : {}),
  });
async function setLevel(projectId, level) {
  const r = await R.api(name, "POST", "/commands/execute", {
    commands: [{ name: "autonomy.set", params: { level, project: projectId } }],
    projectId,
    source: "ui",
    confirm: "tap",
  });
  say("autonomy.set ->", { status: r.status ?? r.results?.[0]?.status, sentence: r.sentence ?? r.results?.[0]?.sentence });
  const p = await R.api(name, "GET", `/projects/${projectId}`);
  say("project autonomy now", p.autonomyLevel ?? p.autonomy_level);
}
async function addTask(projectId, title, dependsOn = []) {
  const t = await R.api(name, "POST", `/projects/${projectId}/tasks`, {
    title,
    outcome: `${title}, as a small file of the site`,
    acceptanceCriteria: [],
    riskTier: 1,
    dependsOn,
    budgetUsdMicro: 2_000_000,
    specialist: "coder",
  });
  return t.taskId ?? t.id ?? t.task?.id;
}
async function runSession(projectId) {
  const s = await R.startSession(name, projectId);
  const id = s.sessionId ?? s.id ?? s.session?.id;
  say("session started", id);
  const done = await R.waitForSession(name, id, 600_000);
  say("session ended", done.status);
  return done;
}
const trace = [];
async function watchHeads(stopAt) {
  // Every PR head as the host shows it over time: a head replaced by one that does not
  // contain it is a force-push.
  const seen = new Map();
  while (!stopAt()) {
    try {
      for (const p of await host("GET", "/repos/bench/seeded/pulls?state=all&per_page=100")) {
        const prev = seen.get(p.number);
        if (prev && prev !== p.head.sha) {
          let forced = false;
          try {
            execFileSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", prev, p.head.sha]);
          } catch {
            forced = true;
          }
          trace.push({ pr: p.number, from: prev.slice(0, 7), to: p.head.sha.slice(0, 7), forced });
        }
        seen.set(p.number, p.head.sha);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

(async () => {
  const { browser, page } = await R.openApp(name);
  await R.skipSetup(page).catch(() => false);
  try {
    const project = await R.api(name, "POST", "/projects", {
      name: `Merge walk ${label} ${mode}`,
      goal: "A small site whose work is merged on GitHub",
      repos: ["bench/seeded"],
      autonomyLevel: mode === "chain" ? 2 : 3,
    });
    const projectId = project.id;
    say("project", projectId);
    let stop = false;
    const watcher = watchHeads(() => stop);
    if (mode === "chain") {
      const a = await addTask(projectId, "Add the page");
      await runSession(projectId);
      say("after the first session", await pulls());
      await setLevel(projectId, 3);
      const b = await addTask(projectId, "Add the footer", [a]);
      // Main moves as soon as the footer's pull request opens: between its accept and its merge.
      let moved = false;
      const mover = (async () => {
        for (let i = 0; i < 3000 && !moved; i++) {
          const open = (await host("GET", "/repos/bench/seeded/pulls?state=open")).filter((p) =>
            /footer/i.test(p.title),
          );
          if (open.length) {
            await moveMain("docs/notes.md");
            moved = true;
            say("main moved while", `#${open[0].number}`, "was being reviewed");
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      await runSession(projectId);
      await mover;
      void b;
    } else {
      await addTask(projectId, "Add the contact page");
      // A check on the head as soon as the pull request opens, still running at the accept.
      let checked = null;
      const checker = (async () => {
        for (let i = 0; i < 3000 && !checked; i++) {
          const open = await host("GET", "/repos/bench/seeded/pulls?state=open");
          const mine = open.find((p) => p.title.includes("Add the contact page"));
          if (mine) {
            await check(mine.head.sha, "in_progress");
            checked = mine;
            say("check running on", `#${mine.number}`, mine.head.sha.slice(0, 7));
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      await runSession(projectId);
      await checker;
      say("after the session", await pulls());
      say("daemon log (merge lines)", R.daemonLog(name, 400).split("\n").filter((l) => /merge record|merge/.test(l)).slice(-6));
      // The app closes while the check runs.
      say("stopping the daemon (hard)");
      spawnSync("node", [path.join(repoRoot, "scripts/bench/restart-daemon.mjs"), "--name", name, "--hard"], {
        stdio: "inherit",
      });
      await check(checked.head.sha, "completed", "success");
      say("check green on", checked.head.sha.slice(0, 7));
      await R.until(
        async () => (await pulls()).find((p) => p.number === checked.number)?.merged || null,
        180_000,
        2000,
        "the retry to merge it after the restart",
      ).catch((e) => say("not merged:", e.message));
      say("daemon log (merge lines)", R.daemonLog(name, 600).split("\n").filter((l) => /merge record|pull request merged|merge records/.test(l)).slice(-8));
    }
    stop = true;
    await watcher;
    const result = { label, mode, pulls: await pulls(), graph: graph(), headChanges: trace, log };
    say("pull requests", result.pulls);
    say("main\n" + result.graph);
    say("head changes", trace);
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    await page
      .goto(`${R.bench(name).uiUrl}/projects/${encodeURIComponent(projectId)}`)
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2500));
    await R.step(page, `${label}-${mode}-overview`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
