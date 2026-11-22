// Bench walk for the w15-run area: the Start dialog's figures for a large and a small task
// (W15-18), the Tasks row and drawer during and after the run against Costs (W15-20, W15-21),
// and the session's review line (W15-18). Stand-in only (`--provider bench`).
const fs = require("node:fs");
const path = require("node:path");
const R = require(path.join(process.argv[2], "scripts/bench/recorder.cjs"));

const NAME = "fix-w15-run";
const LABEL = process.argv[3] ?? "walk";
const enc = encodeURIComponent;
const result = { label: LABEL };
const out = (s) => console.log(`[w15-run ${LABEL}] ${s}`);

const SWISS = {
  title: "Write the Swiss pairing tool with tests",
  outcome:
    "A Node.js command line tool for the club's Swiss-system tournaments, in four files plus a README: src/elo.js (Elo ratings, K=20), src/swiss.js (pairs players by score then rating, no rematches, a bye for an odd count), test/elo.test.js and test/swiss.test.js (node:test, at least six cases each), and README.md with usage examples. Usage: node src/swiss.js players.json",
  acceptanceCriteria: [
    "src/elo.js, src/swiss.js, test/elo.test.js and test/swiss.test.js exist",
    "node --test passes",
    "README.md shows how to run it with an example players.json",
  ],
};
const FOOTER = {
  title: "Add a footer with the club address to index.html",
  outcome: "index.html ends with a footer: Chess club, Marktgasse 1, 3011 Bern",
  acceptanceCriteria: [],
};

async function main() {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Club tools (${LABEL})`,
    goal: "Tools for the chess club",
  });
  const create = (t, priority) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      ...t,
      priority,
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "coder",
      riskTier: 1,
    });
  const big = await create(SWISS, "high");
  const small = await create(FOOTER, "medium");
  result.startCheck = await R.api(NAME, "GET", `/projects/${enc(project.id)}/start-check`);
  const figure = (id) =>
    [...result.startCheck.runnable, ...result.startCheck.later].find((t) => t.taskId === id)
      ?.estimate;
  result.estimates = { big: figure(big.id), small: figure(small.id) };
  out(`Start check: big ${JSON.stringify(result.estimates.big)}, small ${JSON.stringify(result.estimates.small)}`);

  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    const start = page.getByRole("button", { name: "Start session" }).first();
    if (await start.count()) {
      await start.click();
      await page.waitForTimeout(2500);
      result.startDialog = (await R.step(page, `${LABEL} start dialog`)).slice(0, 2000);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    const started = await R.api(NAME, "POST", "/sessions", {
      agentId: me.agent.id,
      projectId: project.id,
      trigger: "manual",
      reason: "w15-run walk",
    });
    // During the run: the Tasks row follows each call (W15-21).
    await page.waitForTimeout(5000);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2000);
    result.tasksDuring = (await R.step(page, `${LABEL} tasks during the run`)).slice(0, 2000);
    result.taskViewsDuring = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
    const session = await R.waitForSession(NAME, started.session.id, 300_000);
    result.session = { status: session.status, summary: session.summary };
    out(`session ${session.status}`);
    await page.waitForTimeout(3000);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    result.tasksAfter = (await R.step(page, `${LABEL} tasks after the run`)).slice(0, 2000);
    const row = page.getByText(SWISS.title).first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(1500);
      result.drawer = (await R.step(page, `${LABEL} drawer big task`)).slice(0, 2500);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/costs`);
    await page.waitForTimeout(2500);
    result.costs = (await R.step(page, `${LABEL} costs`)).slice(0, 2500);
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2500);
    result.sessionPage = (await R.step(page, `${LABEL} session`)).slice(0, 3000);
    result.taskViews = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).map((t) => ({
      title: t.title,
      status: t.status,
      actual: t.actual,
      spent: t.spent,
    }));
    const events = await R.api(NAME, "GET", `/sessions/${enc(session.id)}/events`).catch(() => null);
    result.reviewLines = JSON.stringify(events ?? "")
      .match(/Session review[^"]*/g)
      ?.slice(0, 4);
  } finally {
    await browser.close();
  }
  const file = path.join(R.bench(NAME).home, "..", "steps", `${LABEL}-w15run.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  out(`result in ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
