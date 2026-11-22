// AFTER walk, part 3: the take-over with this computer's copy following main by itself.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_6589accd-16a-1/scripts/bench/recorder.cjs");
const N = "fix-d1109-onerepo-link";
const DIR = "/tmp/frbench/fix-d1109-onerepo-link";
const out = JSON.parse(fs.readFileSync(`${DIR}/after-walk.json`, "utf8"));
const save = () => fs.writeFileSync(`${DIR}/after-walk.json`, JSON.stringify(out, null, 2));
const bare = `${DIR}/githost/bench/empty.git`;
const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl.replace(/\?.*$/, "").replace(/\/$/, "");
  const part = (out.part3 = {});
  try {
    // The walk's hand-edited marker in the copy is put back; the copy follows main by itself.
    git(["-C", out.copy, "checkout", "--", ".forerunner/project.json"]);
    const main = git(["--git-dir", bare, "rev-parse", "main"]);
    part.followed = await R.until(
      async () => (git(["-C", out.copy, "rev-parse", "HEAD"]) === main ? true : null),
      240_000,
      2000,
      "this computer's copy to follow main",
    ).catch(() => false);
    part.copyMarker = fs.readFileSync(`${out.copy}/.forerunner/project.json`, "utf8");
    await page.goto(`${ui}/projects/${out.empty}/summary`);
    await page.getByTestId("repository-elsewhere").waitFor({ timeout: 20000 });
    const line = await R.step(page, "after-09-overview-line-copy-followed");
    part.line = line.split("\n").find((l) => l.includes("is also")) ?? null;
    await page.getByTestId("repository-take-over").click();
    await page.getByTestId("repository-took-over").waitFor({ timeout: 60000 });
    await R.step(page, "after-10-took-over");
    part.branches = git(["--git-dir", bare, "branch", "--list"]);
    part.scaffoldMarker = git(["--git-dir", bare, "show", "fr/docs-scaffold:.forerunner/project.json"]);
    part.mainMarker = git(["--git-dir", bare, "show", "main:.forerunner/project.json"]);
    const gh = R.bench(N).githost.url;
    const prs = await fetch(`${gh}/repos/bench/empty/pulls?state=all`, {
      headers: { authorization: `token ${R.bench(N).githost.token ?? ""}` },
    })
      .then((r) => r.json())
      .catch((e) => String(e));
    part.prs = Array.isArray(prs)
      ? prs.map((p) => ({ number: p.number, head: p.head?.ref, state: p.state, body: String(p.body).slice(0, 400) }))
      : prs;
    const rows = await R.api(N, "GET", "/changes");
    const list = Array.isArray(rows) ? rows : (rows.changes ?? rows.rows ?? []);
    const row = list.find((r) => String(r.sentence).startsWith("Took over") && r.undoState !== "undone");
    part.row = row ? { sentence: row.sentence, undoable: row.undoable, undoBlockedReason: row.undoBlockedReason ?? null } : null;
    if (row) {
      const undo = await R.apiRaw(N, "POST", `/changes/${row.id}/undo`, {});
      part.undo = { status: undo.status, result: undo.body?.status, reason: undo.body?.reason ?? null };
    }
    await page.goto(`${ui}/changes`);
    await page.waitForTimeout(2500);
    await R.step(page, "after-11-changes-undo-refused");
    part.problems = R.problems(N).slice(-6);
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  out.part3error = String(e?.stack ?? e);
  save();
  console.error(e);
  process.exit(1);
});
