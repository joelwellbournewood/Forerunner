// leftovers7-merge2 bench walk: the conflict notice (R-conflict) and the Files line of a copy
// that stopped following (R-copystuck). Two tasks on bench/seeded write index.html differently;
// the person merges the first in the app; the watcher's next poll reads the second as no longer
// mergeable. Then the person edits README.md in this computer's copy, and README.md changes on
// main: the Files tab's line.
//   node walk-l7m2.cjs <bench name> <label> <repo checkout with scripts/bench>
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const NAME = process.argv[2];
const LABEL = process.argv[3];
const ROOT = process.argv[4];
const R = require(path.join(ROOT, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const result = { label: LABEL, checks: [], rows: {}, cards: [], files: {} };
const out = (s) => console.log(`[l7m2 ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Person",
  GIT_AUTHOR_EMAIL: "person@example.test",
  GIT_COMMITTER_NAME: "Person",
  GIT_COMMITTER_EMAIL: "person@example.test",
};
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

async function waitIdle(projectId, ms = 300_000) {
  await R.until(
    async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`);
      const all = Array.isArray(list) ? list : (list.sessions ?? []);
      return all.length > 0 && all.every((s) => !["running", "planned", "paused"].includes(s.status));
    },
    ms,
    1000,
    "the project's sessions to end",
  );
}

(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(NAME, "POST", "/projects", {
      name: `Two pages (${LABEL})`,
      goal: "Two home pages",
      repos: ["bench/seeded"],
    });
    const create = (title) =>
      R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
        title,
        outcome: "index.html is written",
        acceptanceCriteria: ["index.html exists"],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        specialist: "coder",
        riskTier: 1,
      });
    const one = await create("Write the home page in index.html");
    const two = await create("Write another home page in index.html");
    out(`project ${project.id}`);
    await R.startSession(NAME, project.id, "leftovers7-merge2 walk");
    await waitIdle(project.id);
    const rowsOf = async () =>
      (await R.api(NAME, "GET", `/projects/${enc(project.id)}/pull-requests`)).waiting;
    let rows = await rowsOf();
    result.rows.afterSession = rows.map((r) => ({ title: r.title, number: r.number, merge: r.merge }));
    check("two pull requests wait for the person", rows.length === 2, JSON.stringify(result.rows.afterSession));
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} overview two waiting`);
    const first = rows.find((r) => r.title.includes("Write the home page"));
    const second = rows.find((r) => r.title.includes("another"));
    // On GitHub's website the person edits the first pull request's index.html and merges it
    // there: the second one, which writes index.html too, no longer merges cleanly.
    const gh = JSON.parse(fs.readFileSync(path.join(path.dirname(b.home), "githost.json"), "utf8"));
    const bareRepo = path.join(path.dirname(b.home), "githost", "bench", "seeded");
    const bareAt = fs.existsSync(bareRepo) ? bareRepo : `${bareRepo}.git`;
    const tmpEdit = fs.mkdtempSync(path.join(os.tmpdir(), "l7m2-edit-"));
    git(tmpEdit, ["clone", "-q", bareAt, "c"]);
    const ce = path.join(tmpEdit, "c");
    const branch = first.branch;
    git(ce, ["checkout", "-q", branch]);
    fs.writeFileSync(path.join(ce, "index.html"), "<!doctype html>\n<title>Edited on GitHub</title>\n<h1>The person's own heading</h1>\n");
    git(ce, ["commit", "-qam", "Edit index.html on GitHub"]);
    git(ce, ["push", "-q", "origin", `HEAD:${branch}`]);
    fs.rmSync(tmpEdit, { recursive: true, force: true });
    const merged = await fetch(`${gh.url}/repos/bench/seeded/pulls/${first.number}/merge`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${gh.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: "merge" }),
    });
    check("the person merged the first pull request on GitHub", merged.status === 200, String(merged.status));
    const pr2 = await (await fetch(`${gh.url}/repos/bench/seeded/pulls/${second.number}`, {
      headers: { Authorization: `Bearer ${gh.token}` },
    })).json();
    check("GitHub says the second no longer merges", pr2.mergeable === false, `${pr2.mergeable} ${pr2.mergeable_state}`);
    await R.until(
      async () => !(await rowsOf()).some((r) => r.number === first.number),
      60_000,
      1000,
      "the first pull request to merge",
    );
    // The watcher's next poll (FORERUNNER_GITHOST_POLL_MS=3000) reads the second.
    await sleep(9000);
    rows = await rowsOf();
    const row2 = rows.find((r) => r.number === second.number);
    result.rows.afterMerge = rows.map((r) => ({ title: r.title, number: r.number, merge: r.merge }));
    check(
      "the conflicted row no longer offers Merge and says why",
      row2 && row2.merge && row2.merge.canMerge === false && /conflicts with main/.test(row2.merge.sentence ?? ""),
      JSON.stringify(row2?.merge),
    );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} overview after the merge`);
    const inbox = await R.api(NAME, "GET", "/inbox");
    const cards = inbox.requests.filter((r) => r.taskId === two.id && r.status === "open");
    result.cards = cards.map((c) => ({ title: c.title, body: c.body, choices: (c.choices ?? []).map((x) => [x.label, x.explain]) }));
    check("one conflict card for the second task", cards.length === 1, JSON.stringify(result.cards));
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} inbox after the merge`);
    await sleep(7000);
    const again = (await R.api(NAME, "GET", "/inbox")).requests.filter(
      (r) => r.taskId === two.id && r.status === "open",
    );
    check("no second card after more polls", again.length === cards.length, String(again.length));

    // Files: the person edits README.md in this computer's copy; README.md changes on main.
    const files = await R.api(NAME, "GET", `/projects/${enc(project.id)}/files`);
    result.files.before = files.copy;
    const folder = files.folder;
    fs.writeFileSync(path.join(folder, "README.md"), "# my own notes\n");
    const bare = path.join(path.dirname(b.home), "githost", "bench", "seeded");
    const bareDir = fs.existsSync(bare) ? bare : `${bare}.git`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l7m2-push-"));
    git(tmp, ["clone", "-q", bareDir, "c"]);
    const c = path.join(tmp, "c");
    fs.writeFileSync(path.join(c, "README.md"), "# seeded, changed on main\n");
    git(c, ["commit", "-qam", "Change the readme on main"]);
    git(c, ["push", "-q", "origin", "HEAD:main"]);
    fs.rmSync(tmp, { recursive: true, force: true });
    await sleep(9000);
    const stuck = await R.api(NAME, "GET", `/projects/${enc(project.id)}/files`);
    result.files.after = stuck.copy;
    check(
      "GET /projects/:id/files says the copy stopped following, and why",
      stuck.copy?.stopped?.reason === "changed" && (stuck.copy?.stopped?.files ?? []).includes("README.md"),
      JSON.stringify(stuck.copy),
    );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/files`);
    await page.waitForTimeout(2500);
    const text = await R.step(page, `${LABEL} files copy stopped`);
    result.files.line = (text.split("\n").find((l) => l.startsWith("This computer's copy")) ?? "").trim();
    check(
      "the Files tab says so, never 'As merged'",
      /not updated since/.test(result.files.line) && !/As merged/.test(result.files.line),
      result.files.line,
    );
  } catch (e) {
    result.error = String(e?.stack ?? e);
    out(`error: ${result.error}`);
  } finally {
    fs.writeFileSync(path.join(R.bench(NAME).home, "..", "steps", `${LABEL}-l7m2.json`), JSON.stringify(result, null, 2));
    await browser.close();
  }
})();
