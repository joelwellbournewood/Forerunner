// fixup-w8-together, review blocking 3: Add to it, then Quit while its plan is drafted; what the
// project page says after the restart (twice), and Try again from it. Usage:
//   node fixup-b3-walk.cjs <label> [--try-again]
const WT = "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-6";
const R = require(`${WT}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const N = "fixup-w8-together";
const OUT = "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/b3walk";
fs.mkdirSync(OUT, { recursive: true });
const label = process.argv[2] ?? "after";
const tryAgain = process.argv.includes("--try-again");
const hard = process.argv.includes("--hard");
const log = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  fs.appendFileSync(`${OUT}/${label}.log`, `${line}\n`);
};
const restart = () =>
  execFileSync("node", [`${WT}/scripts/bench/restart-daemon.mjs`, "--name", N, ...(hard ? ["--hard"] : [])], { stdio: "pipe" })
    .toString()
    .trim()
    .split("\n")
    .at(-1);
const ADDED = `Add a members page listing the club's ${label} meeting times.`;

(async () => {
  // A project here on bench/empty (made once, without a plan), so New project offers Add to it.
  const projects = await R.api(N, "GET", "/projects");
  let club = projects.find((p) => p.name === (process.env.CLUB ?? "Club"));
  if (!club)
    club = await R.api(N, "POST", "/projects", {
      name: process.env.CLUB ?? "Club",
      goal: "The club's site",
      repos: [process.env.REPO_NAME ?? "bench/empty"],
    });
  log("club", club.id);
  const { browser, page } = await R.openApp(N, { path: "/" });
  await R.skipSetup(page);
  await page.goto(`${R.bench(N).uiUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.locator('input[name="name"]').fill("Members");
  await page.locator('textarea[name="brief"], input[name="brief"]').first().fill(ADDED);
  await page.locator('input[name="repo"]').fill(`https://github.com/${process.env.REPO_NAME ?? "bench/empty"}`);
  await page.getByTestId("create-project").click();
  await page.getByTestId("offer-add").waitFor({ timeout: 15000 });
  await R.step(page, `${label} 1 add to offer`, { waitMs: 300 });
  await page.getByTestId("offer-add").click();
  await page.waitForURL(/\/projects\//, { timeout: 15000 });
  await page.waitForTimeout(700);
  let t = await R.step(page, `${label} 2 landed drafting`, { settleMs: 0 });
  log("LANDED", t.match(/(Drafting|Planning|Waiting for you)[^\n]*/)?.[0] ?? "(no plan line)");
  log("intake now", (await R.api(N, "GET", `/projects/${club.id}/intake`)).state);
  // Quit while it drafts: the daemon asked to stop, then started again.
  log(restart());
  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  t = await R.step(page, `${label} 3 after restart`, { waitMs: 500 });
  const st1 = await R.api(N, "GET", `/projects/${club.id}/intake`);
  log("AFTER RESTART intake", st1.state, st1.error ?? "");
  log("AFTER RESTART banner", t.match(/(Planning failed|Drafting|Waiting for you)[^\n]*/)?.[0] ?? "(no plan line)");
  log("Try again shown", await page.getByTestId("intake-retry").count());
  log(restart());
  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  t = await R.step(page, `${label} 4 after second restart`, { waitMs: 500 });
  const st2 = await R.api(N, "GET", `/projects/${club.id}/intake`);
  log("AFTER 2ND RESTART intake", st2.state, st2.error ?? "");
  if (tryAgain && (await page.getByTestId("intake-retry").count())) {
    await page.getByTestId("intake-retry").click();
    await page.waitForTimeout(800);
    t = await R.step(page, `${label} 5 try again drafting`, { settleMs: 0 });
    log("TRY AGAIN", t.match(/(Planning failed|Drafting|Waiting for you)[^\n]*/)?.[0] ?? "");
    for (let i = 0; i < 40; i++) {
      const s = await R.api(N, "GET", `/projects/${club.id}/intake`);
      if (s.state !== "drafting") break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(3500);
    t = await R.step(page, `${label} 6 plan waits`, { waitMs: 500 });
    const st3 = await R.api(N, "GET", `/projects/${club.id}/intake`);
    log("AFTER TRY AGAIN intake", st3.state, st3.error ?? "");
    log("banner", t.match(/(Planning failed|Drafting|Waiting for you)[^\n]*/)?.[0] ?? "");
    // The planning call Try again made: does it carry Add to it's brief?
    const calls = fs
      .readFileSync(R.bench(N).modelCallLog ?? `${R.bench(N).home}/bench/model-calls.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((c) => c.role === "intake");
    const last = JSON.stringify(calls.at(-1) ?? {});
    log("intake calls", calls.length, "last carries the Add to brief:", last.includes(ADDED));
    await page.goto(`${R.bench(N).uiUrl}/inbox`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    t = await R.step(page, `${label} 7 inbox plan card`, { waitMs: 500 });
    log("INBOX", t.slice(0, 700).replace(/\n/g, " | "));
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
