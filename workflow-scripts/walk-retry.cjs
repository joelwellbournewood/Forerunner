// Review walk for l4-github-carried: Try again on the take-over's no-pull-request line (L4e-left-1),
// Docs shows only that outcome (L4e-left-4). Phase "refused" (hook installed) or "open" (hook removed).
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[3];
const phase = process.argv[4] ?? "first";
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const n = process.argv[2];
const benchDir = `/tmp/frbench/${n}`;
const stateFile = path.join(benchDir, "walk-retry-state.json");
const out = { phase };
const reqLog = path.join(benchDir, "githost-requests.jsonl");
const readReqs = () =>
  fs.existsSync(reqLog)
    ? fs.readFileSync(reqLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

(async () => {
  const { browser, page } = await R.openApp(n);
  const ui = R.bench(n).uiUrl;
  try {
    let pid;
    if (phase === "first") {
      // New project with the repository another Forerunner project names: the offer, Take it over.
      await page.goto(`${ui}/`);
      await page.getByTestId("new-project").click();
      await page.locator('input[name="name"]').fill("Kite flyers");
      await page.locator('[name="goal"]').fill("Fly kites together");
      await page.locator('input[name="repo"]').fill("https://github.com/bench/empty");
      await R.step(page, "retry-01-new-project");
      await page.getByTestId("create-project").click();
      await page.getByTestId("link-offer").waitFor({ timeout: 30_000 });
      out.offer = await R.step(page, "retry-02-offer");
      const before = readReqs().length;
      await page.getByTestId("offer-take-over").click();
      await page.waitForURL(/\/projects\//, { timeout: 60_000 });
      pid = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
      fs.writeFileSync(stateFile, JSON.stringify({ pid }));
      await page.goto(`${ui}/projects/${pid}/summary`);
      await page.getByTestId("repository-elsewhere").waitFor({ timeout: 60_000 });
      await page.waitForTimeout(2000);
      out.overviewLine = await R.step(page, "retry-03-overview-no-pr-line");
      out.takeOverWrites = readReqs()
        .slice(before)
        .filter((r) => r.method !== "GET" && !String(r.path).endsWith("git-upload-pack"))
        .map((r) => `${r.method} ${r.path} ${r.status}`);
      // Press Try again while GitHub still refuses the push.
      await page.getByTestId("repository-try-again-button").click();
      await page.getByTestId("repository-try-again-refused").waitFor({ timeout: 60_000 });
      out.refused = await page.getByTestId("repository-try-again-refused").innerText();
      out.afterRefused = await R.step(page, "retry-04-overview-still-refused");
      // Docs shows the same line with its Try again.
      await page.goto(`${ui}/projects/${pid}/docs`);
      await page.getByTestId("docs").waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      out.docs = await R.step(page, "retry-05-docs-line");
      out.docsHasTryAgain = await page.getByTestId("docs-try-again-button").count();
    } else {
      pid = JSON.parse(fs.readFileSync(stateFile, "utf8")).pid;
      await page.goto(`${ui}/projects/${pid}/summary`);
      await page.getByTestId("repository-elsewhere").waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      out.beforePress = await R.step(page, "retry-06-overview-before-second-press");
      const before = readReqs().length;
      await page.getByTestId("repository-try-again-button").click();
      await page.getByTestId("repository-try-again-opened").waitFor({ timeout: 90_000 });
      out.opened = await page.getByTestId("repository-try-again-opened").innerText();
      await page.waitForTimeout(2500);
      out.afterOpened = await R.step(page, "retry-07-overview-opened");
      out.writes = readReqs()
        .slice(before)
        .filter((r) => r.method !== "GET" && !String(r.path).endsWith("git-upload-pack"))
        .map((r) => `${r.method} ${r.path} ${r.status}`);
      out.lineGone = (await page.getByTestId("repository-elsewhere-line").count()) === 0;
      await page.goto(`${ui}/projects/${pid}/docs`);
      await page.getByTestId("docs").waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      out.docsAfter = await R.step(page, "retry-08-docs-after");
    }
    fs.writeFileSync(
      path.join(benchDir, "steps", `walk-retry-${phase}.json`),
      JSON.stringify(out, null, 2),
    );
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  try {
    fs.writeFileSync(
      path.join(benchDir, "steps", `walk-retry-${phase}.json`),
      JSON.stringify(out, null, 2),
    );
  } catch {}
  process.exit(1);
});
