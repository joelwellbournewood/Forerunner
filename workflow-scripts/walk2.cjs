// Reviewer walk 2 (w8-together): Bob's Changes row for Work together, Undo after two daemon
// restarts, through the Changes page.
const WT = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-5";
const R = require(`${WT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const B = "review-w8-together-bob";
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/walk";
const ids = JSON.parse(fs.readFileSync(`${OUT}/ids.json`, "utf8"));
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(`${OUT}/walk2.log`, `${line}\n`);
};
const restart = () =>
  execFileSync("node", [`${WT}/scripts/bench/restart-daemon.mjs`, "--name", B], { stdio: "pipe" }).toString();
const bobWrites = () =>
  fs
    .readFileSync("/tmp/frbench/review-w8-together/githost-requests.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.login === "bob" && !["GET", "HEAD"].includes(r.method) && !/git-upload-pack/.test(r.path));

(async () => {
  const step = process.argv[2] ?? "changes";
  if (step === "changes") {
    const changes = await R.api(B, "GET", "/changes?limit=10");
    log("changes", changes.map((c) => ({ s: c.sentence, undoable: c.undoable, by: c.source })));
    log(restart().split("\n").slice(-2).join(" "));
    log(restart().split("\n").slice(-2).join(" "));
    const before = bobWrites().length;
    const { browser, page } = await R.openApp(B, { path: "/changes" });
    await page.waitForTimeout(3000);
    let t = await R.step(page, "bob changes after two restarts", { waitMs: 500 });
    log("CHANGES PAGE", t.slice(0, 2500));
    // The Undo on the Work together row.
    const row = page.locator("li, tr, div").filter({ hasText: 'joined "Team site"' }).last();
    const undo = row.getByRole("button", { name: /Undo/ });
    log("undo buttons on row", await undo.count());
    await undo.first().click();
    await page.waitForTimeout(1500);
    // A confirm, if the page asks.
    const confirm = page.getByRole("button", { name: /^Undo$/ });
    if ((await confirm.count()) > 0 && (await confirm.last().isVisible())) {
      t = await R.step(page, "bob undo confirm", { waitMs: 300 });
      log("UNDO CONFIRM", t.slice(-800));
    }
    await page.waitForTimeout(3000);
    t = await R.step(page, "bob after undo", { waitMs: 500 });
    log("AFTER UNDO", t.slice(0, 2500));
    await page.goto(`${R.bench(B).uiUrl}/projects/${ids.site}/summary`);
    await page.waitForTimeout(4000);
    t = await R.step(page, "bob site back", { waitMs: 500 });
    log("SITE BACK", t.slice(0, 2500));
    log("bob writes at undo", bobWrites().length - before);
    const projects = await R.api(B, "GET", "/projects");
    log("projects", projects.map((p) => [p.name, p.status ?? "", p.id === ids.kite]));
    await browser.close();
  }
})().catch((e) => {
  log("ERROR", String(e?.stack ?? e));
  process.exit(1);
});
