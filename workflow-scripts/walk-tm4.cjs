// TM-4 walk (leftovers7-tailmerge): Merge pressed while B's rebuild is owed because its task
// folder holds a change nobody committed: the rows say why it waits and what to do.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-1/scripts/bench/recorder.cjs");
const n = "fix-leftovers7-tailmerge";
const benchDir = "/tmp/frbench/fix-leftovers7-tailmerge";
const gh = JSON.parse(fs.readFileSync(path.join(benchDir, "githost.json"), "utf8"));

function findDir(root, name, depth = 6) {
  if (depth < 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name === name && fs.existsSync(path.join(p, ".git"))) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
    const found = findDir(path.join(root, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

(async () => {
  const out = {};
  const { browser, page } = await R.openApp(n);
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(n, "POST", "/projects", {
      name: "Page and footer",
      goal: "A page with a footer",
      repos: ["bench/seeded"],
    });
    out.project = project.id;
    const a = await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the page in page.html",
      outcome: "page.html shows the page",
      riskTier: 1,
      specialist: "coder",
    });
    const b = await R.api(n, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the footer in footer.html",
      outcome: "footer.html shows a footer",
      riskTier: 1,
      specialist: "coder",
      dependsOn: [a.id],
    });
    const started = await R.startSession(n, project.id);
    const sessionId = started.session?.id ?? started.id;
    await R.waitForSession(n, sessionId, 300_000);
    const prs = await R.api(n, "GET", `/projects/${project.id}/pull-requests`);
    const rowOf = (view, title) => view.waiting.find((w) => w.title === title);
    const prA = rowOf(prs, a.title)?.number;
    const prB = rowOf(prs, b.title)?.number;
    out.prs = { prA, prB };
    // A change nobody committed, in B's task folder.
    const home = R.bench(n).home;
    const folder = findDir(home, b.id);
    out.folder = folder;
    fs.writeFileSync(path.join(folder, "notes.txt"), "my notes\n");
    // A's pull request is closed on GitHub: B must be rebuilt without it, and cannot be.
    const res = await fetch(`${gh.url}/repos/bench/seeded/pulls/${prA}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "closed" }),
    });
    out.closeStatus = res.status;
    await new Promise((r) => setTimeout(r, 15_000));
    // The person presses Merge on B's row.
    const ui = R.bench(n).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${project.id}/summary`);
    const row = page.locator(`[data-testid="pr-waiting"][data-number="${prB}"]`);
    await row.waitFor({ timeout: 30_000 });
    await R.step(page, "tm4-overview-before-merge");
    await row.getByTestId("pr-merge").click();
    await new Promise((r) => setTimeout(r, 8_000));
    await page.reload();
    await row.waitFor({ timeout: 30_000 });
    out.overview = await R.step(page, "tm4-overview-merge-waits-for-folder");
    out.rowAfter = rowOf(await R.api(n, "GET", `/projects/${project.id}/pull-requests`), b.title)?.merge;
    await page.goto(`${ui}/projects/${project.id}/tasks`);
    await page.waitForTimeout(2000);
    out.tasks = await R.step(page, "tm4-tasks-merge-waits-for-folder");
    // A few more polls: the warning stays one line in daemon.log.
    await new Promise((r) => setTimeout(r, 20_000));
    const log = fs.readFileSync(path.join(benchDir, "daemon.log"), "utf8");
    out.warnings = log.split("\n").filter((l) => l.includes("its worktree has uncommitted changes")).length;
    // The change put away: the rebuild runs, the wait's words go.
    fs.rmSync(path.join(folder, "notes.txt"));
    await new Promise((r) => setTimeout(r, 20_000));
    await page.goto(`${ui}/projects/${project.id}/summary`);
    await page.waitForTimeout(2000);
    await R.step(page, "tm4-overview-after-the-folder-is-clean");
    out.rowClean = rowOf(await R.api(n, "GET", `/projects/${project.id}/pull-requests`), b.title)?.merge;
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, "tm4-error").catch(() => undefined);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
})();
