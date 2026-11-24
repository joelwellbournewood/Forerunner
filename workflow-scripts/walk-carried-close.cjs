// Bench walk for l4-github-carried: a task titled "Update yarn.lock" pushes its branch and opens
// its pull request (L4e-left-2); a cancelled task's pull request still open on GitHub is closed
// with the Overview's Close (L4-github-130), one PATCH and no branch deleted.
// Usage: node walk-carried-close.cjs <bench name> <label> <repo root>
const [name, label, repo] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const benchDir = `/tmp/frbench/${name}`;
const requests = () =>
  fs
    .readFileSync(`${benchDir}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const refs = () =>
  execFileSync(
    "git",
    ["--git-dir", `${benchDir}/githost/bench/seeded.git`, "for-each-ref", "--format=%(refname)"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

(async () => {
  const out = { label, checks: {} };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(name, "POST", "/projects", {
      name: "Kite club",
      goal: "The club's pages",
      repos: ["bench/seeded"],
    });
    out.project = project.id;
    const mk = (title, outcome, file) =>
      R.api(name, "POST", `/projects/${project.id}/tasks`, {
        title,
        outcome,
        acceptanceCriteria: [`${file} exists`],
        riskTier: 1,
        specialist: "coder",
        status: "ready",
      });
    const a = await mk("Update yarn.lock", "yarn.lock lists the club's packages", "yarn.lock");
    const b = await mk("Write rules.txt with the rules", "rules.txt lists the rules", "rules.txt");
    const aId = a.id ?? a.task?.id;
    const bId = b.id ?? b.task?.id;
    out.tasks = { a: aId, b: bId };
    const started = await R.startSession(name, project.id);
    const sessionId = started?.session?.id ?? started?.sessionId ?? started?.id;
    out.session = sessionId;
    await R.waitForSession(name, sessionId, 300_000);
    const tasks = await R.api(name, "GET", `/projects/${project.id}/tasks`);
    out.tasksAfter = tasks.map((t) => ({
      title: t.title,
      status: t.status,
      branch: t.branch,
      prUrl: t.prUrl ?? t.pr_url,
    }));
    out.refsAfterSession = refs();
    const ta = tasks.find((t) => t.id === aId);
    out.checks.branchOfYarnLock = ta?.branch ?? null;
    out.checks.branchPushed = !!ta?.branch && out.refsAfterSession.includes(`refs/heads/${ta.branch}`);
    out.checks.prOpened = !!(ta?.prUrl ?? ta?.pr_url);
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${project.id}/summary`);
    await page.waitForTimeout(3000);
    out.overviewAfterSession = (await R.step(page, `${label}-1-overview-prs`)).slice(0, 2500);
    // The person redoes A and cancels it: its pull request stays open on GitHub.
    const exec = (commands, words) =>
      R.api(name, "POST", "/commands/execute", {
        commands,
        wordsUsed: words,
        source: "ui",
        projectId: project.id,
        confirm: "tap",
      });
    out.reopen = await exec([{ name: "task.reopen", params: { task: aId } }], "Redo");
    out.cancel = await exec(
      [{ name: "task.transition", params: { task: aId, to: "cancelled" } }],
      "Cancel task",
    );
    await page.goto(`${ui}/projects/${project.id}/summary`);
    await page.waitForSelector('[data-testid="pr-cancelled-close"]', { timeout: 30_000 });
    out.overviewCancelled = (await R.step(page, `${label}-2-overview-cancelled-close`)).slice(0, 2500);
    const before = requests().length;
    await page.click('[data-testid="pr-cancelled-close"]');
    await page.waitForSelector('[data-testid="pr-close-answer"]', { timeout: 30_000 });
    out.overviewClosed = (await R.step(page, `${label}-3-overview-closed`)).slice(0, 2500);
    const writes = requests()
      .slice(before)
      .filter((r) => r.method !== "GET" && !String(r.path).endsWith("/git-upload-pack"));
    out.githubWritesOfClose = writes.map((r) => `${r.method} ${r.path} ${r.status}`);
    out.refsAfterClose = refs();
    out.checks.onePatch =
      writes.length === 1 && writes[0].method === "PATCH" && /\/pulls\/\d+$/.test(writes[0].path);
    out.checks.branchKept = !!ta?.branch && out.refsAfterClose.includes(`refs/heads/${ta.branch}`);
    const view = await R.api(name, "GET", `/projects/${project.id}/pull-requests`);
    out.checks.cancelledRowGone = !(view.waiting ?? []).some((r) => r.kind === "cancelled");
  } catch (e) {
    out.error = String(e?.stack ?? e);
  } finally {
    fs.writeFileSync(`${benchDir}/steps/${label}-close.json`, JSON.stringify(out, null, 2));
    await browser.close();
    console.log(JSON.stringify(out.checks), out.error ?? "");
  }
})();
