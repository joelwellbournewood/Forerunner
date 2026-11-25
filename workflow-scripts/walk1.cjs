// Reviewer walk 1 (w8-together): Ada's "Team site" on team/shared (docs merged), Bob's "Site"
// made while GitHub was off for him, with two tasks and an old status pull request; Bob's
// Overview line, the together dialog with GitHub off, then on, the press, the landing.
const WT = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-5";
const R = require(`${WT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const A = "review-w8-together";
const B = "review-w8-together-bob";
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/walk";
fs.mkdirSync(OUT, { recursive: true });
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${A}/githost.json`, "utf8"));
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(`${OUT}/walk1.log`, `${line}\n`);
};
async function ghApi(login, method, path, body) {
  const res = await fetch(`${gh.url}${path}`, {
    method,
    headers: {
      authorization: `token ${gh.users[login].token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
const cut = (bench, state) =>
  execFileSync("node", [`${WT}/scripts/bench/cut.mjs`, bench, "github", state], { stdio: "pipe" }).toString();
const writesBy = (login) =>
  fs
    .readFileSync(`/tmp/frbench/${A}/githost-requests.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.login === login && !["GET", "HEAD"].includes(r.method) && !/git-upload-pack/.test(r.path ?? r.url ?? ""));

(async () => {
  const step = process.argv[2] ?? "setup";
  if (step === "setup") {
    // Ada's project; her scaffold's docs pull request; merged by Ada through her app's route.
    const kite = await R.api(A, "POST", "/projects", {
      name: "Team site",
      goal: "The team's site",
      repos: ["team/shared"],
    });
    log("ada project", kite.id, kite.name);
    const pr = await R.until(async () => {
      const r = await ghApi("ada", "GET", "/repos/team/shared/pulls?state=open");
      return (r.body || []).find((p) => p.head.ref === "fr/docs-scaffold");
    }, 60_000, 1000, "Ada's docs pull request");
    log("ada docs pr", pr.number, pr.user?.login);
    const merged = await R.api(A, "POST", `/projects/${kite.id}/pull-requests/${pr.number}/merge`, {});
    log("merge answer", merged);
    await R.until(async () => {
      const r = await ghApi("ada", "GET", `/repos/team/shared/pulls/${pr.number}`);
      return r.body.merged || r.body.state === "closed";
    }, 90_000, 1000, "merge");
    const marker = await ghApi("ada", "GET", "/repos/team/shared/contents/.forerunner/project.json?ref=main");
    log("main marker", marker.status, marker.body?.content ? Buffer.from(marker.body.content, "base64").toString() : marker.body);
    // Bob's Site, made while GitHub did not answer him.
    log(cut(B, "off"));
    const site = await R.api(B, "POST", "/projects", { name: "Site", goal: "Another site", repos: ["team/shared"] });
    log("bob site", site.id, site.name);
    log(cut(B, "on"));
    for (const title of ["Write the home page in index.html", "Write the contact page"]) {
      const t = await R.api(B, "POST", `/projects/${site.id}/tasks`, {
        title,
        outcome: `${title} is done`,
        riskTier: 1,
        specialist: "coder",
      });
      log("bob task", t.task?.title ?? t.title ?? JSON.stringify(t).slice(0, 200));
    }
    fs.writeFileSync(`${OUT}/ids.json`, JSON.stringify({ kite: kite.id, site: site.id, docsPr: pr.number }));
    log("bob writes so far", writesBy("bob").map((w) => `${w.method} ${w.path ?? w.url}`));
    return;
  }
  const ids = JSON.parse(fs.readFileSync(`${OUT}/ids.json`, "utf8"));
  if (step === "overview") {
    const { browser, page } = await R.openApp(B, { path: `/projects/${ids.site}/summary` });
    await R.skipSetup(page);
    await page.goto(`${R.bench(B).uiUrl}/projects/${ids.site}/summary`);
    await page.waitForTimeout(4000);
    const t = await R.step(page, "bob site overview", { waitMs: 1000 });
    log("OVERVIEW TEXT", t.slice(0, 3000));
    await browser.close();
    return;
  }
  if (step === "off-press") {
    log(cut(B, "off"));
    const before = writesBy("bob").length;
    const { browser, page } = await R.openApp(B, { path: `/projects/${ids.site}/summary` });
    await page.waitForTimeout(3000);
    const btn = page.getByTestId("repository-work-together");
    log("button count", await btn.count());
    await btn.first().click();
    await page.getByTestId("join-together-dialog").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(3000);
    const t = await R.step(page, "bob together dialog github off", { waitMs: 500 });
    log("DIALOG OFF", t.slice(-1500));
    log("confirm disabled", await page.getByTestId("join-together-confirm").isDisabled());
    // The press through the client while off (the dialog keeps the button off).
    const r = await R.apiRaw(B, "POST", "/commands/execute", {
      commands: [{ name: "project.join", params: { keep: { together: true }, close: [ids.site] } }],
      wordsUsed: "Work together (Overview)",
      source: "ui",
      projectId: ids.site,
      confirm: "tap",
    });
    log("press while off", r.status, r.body?.status, r.body?.reason);
    log("bob writes while off", writesBy("bob").length - before);
    await browser.close();
    log(cut(B, "on"));
    return;
  }
  if (step === "press") {
    const before = writesBy("bob").length;
    const prsBefore = (await ghApi("ada", "GET", "/repos/team/shared/pulls?state=all")).body.map((p) => [p.number, p.state, p.head.ref, p.updated_at]);
    const { browser, page } = await R.openApp(B, { path: `/projects/${ids.site}/summary` });
    await page.waitForTimeout(3000);
    await page.getByTestId("repository-work-together").first().click();
    const t0 = Date.now();
    await page.getByTestId("join-together-dialog").waitFor({ timeout: 20_000 });
    await page.getByTestId("join-together-sentence").waitFor({ timeout: 30_000 });
    log("dialog loaded in ms", Date.now() - t0);
    const t = await R.step(page, "bob together dialog", { waitMs: 300 });
    log("DIALOG", t.slice(-1500));
    await page.getByTestId("join-together-confirm").click();
    await page.waitForURL((u) => !u.toString().includes(ids.site), { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    const after = await R.step(page, "bob after work together", { waitMs: 500 });
    log("URL", page.url());
    log("AFTER", after.slice(0, 3000));
    const w = writesBy("bob").slice(before);
    log("bob writes at press", w.map((x) => `${x.method} ${x.path ?? x.url}`));
    const prsAfter = (await ghApi("ada", "GET", "/repos/team/shared/pulls?state=all")).body.map((p) => [p.number, p.state, p.head.ref, p.updated_at]);
    log("prs before", prsBefore);
    log("prs after", prsAfter);
    await browser.close();
    return;
  }
})().catch((e) => {
  log("ERROR", String(e?.stack ?? e));
  process.exit(1);
});
