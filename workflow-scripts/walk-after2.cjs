// AFTER walk, part 2: after the take-over (bench fix-d1109-onerepo-link).
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-1/scripts/bench/recorder.cjs");
const N = "fix-d1109-onerepo-link";
const DIR = "/tmp/frbench/fix-d1109-onerepo-link";
const out = JSON.parse(fs.readFileSync(`${DIR}/after-walk.json`, "utf8"));
delete out.error;
const save = () => fs.writeFileSync(`${DIR}/after-walk.json`, JSON.stringify(out, null, 2));
const bare = `${DIR}/githost/bench/empty.git`;
const sh = (args) => {
  try {
    return execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" });
  } catch (e) {
    return null;
  }
};

(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl.replace(/\?.*$/, "").replace(/\/$/, "");
  try {
    out.branches = sh(["branch", "--list"]);
    out.mainMarker = sh(["show", "main:.forerunner/project.json"]);
    out.scaffoldMarker = sh(["show", "fr/docs-scaffold:.forerunner/project.json"]);
    out.checks.scaffoldNamesThisProject = !!out.scaffoldMarker && out.scaffoldMarker.includes(out.empty);
    out.checks.mainUntouched = !!out.mainMarker && out.mainMarker.includes("Kite club");
    await page.goto(`${ui}/projects/${out.empty}/summary`);
    await page.waitForTimeout(3000);
    const overview = await R.step(page, "after-08-overview-after-take-over");
    out.checks.lineGone = !overview.includes("is also the Forerunner project");
    await page.goto(`${ui}/changes`);
    await page.waitForTimeout(2500);
    const changes = await R.step(page, "after-07-changes");
    out.checks.changesRow = changes.includes('Took over bench/empty from "Kite club".');
    const rows = await R.api(N, "GET", "/changes");
    const list = Array.isArray(rows) ? rows : (rows.changes ?? rows.rows ?? []);
    const row = list.find((r) => String(r.sentence).startsWith("Took over"));
    out.changeRow = row ? { sentence: row.sentence, undoable: row.undoable, undoBlockedReason: row.undoBlockedReason ?? null } : null;
    if (row) {
      const undo = await R.apiRaw(N, "POST", `/changes/${row.id}/undo`, {});
      out.undo = { status: undo.status, result: undo.body?.status, reason: undo.body?.reason ?? null };
    }
    out.problems = R.problems(N).slice(-10);
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  out.error = String(e?.stack ?? e);
  save();
  console.error(e);
  process.exit(1);
});
