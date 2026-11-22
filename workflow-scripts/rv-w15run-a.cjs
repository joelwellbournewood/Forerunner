// Reviewer walk A for w15-run: New task x2 through the UI, the Start dialog's figures before and
// after a daemon restart (W15-18), Start through the dialog, the Tasks row and drawer while the
// task runs (W15-21) and after (W15-20) against Costs, and the session page (review line).
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPO = process.argv[2];
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const NAME = "review-w15-run";
const enc = encodeURIComponent;
const result = { during: [] };
const out = (s) => console.log(`[A] ${s}`);

const SWISS = {
  title: "Write the Swiss pairing tool with tests",
  outcome:
    "A Node.js command line tool for the club's Swiss-system tournaments, in four files plus a README: src/elo.js (Elo ratings, K=20), src/swiss.js (pairs players by score then rating, no rematches, a bye for an odd count), test/elo.test.js and test/swiss.test.js (node:test, at least six cases each), and README.md with usage examples.",
  criteria:
    "src/elo.js, src/swiss.js, test/elo.test.js and test/swiss.test.js exist\nnode --test passes\nREADME.md shows how to run it",
};
const FOOTER = {
  title: "Add a footer with the club address to index.html",
  outcome: "index.html ends with a footer: Chess club, Marktgasse 1, 3011 Bern",
  criteria: "",
};

async function newTask(page, t) {
  await page.getByRole("button", { name: "New task" }).first().click();
  await page.waitForTimeout(800);
  const d = page.getByRole("dialog");
  await d.getByLabel("Title").fill(t.title);
  await d.getByLabel("What done looks like").fill(t.outcome);
  if (t.criteria) await d.getByLabel("Criteria (optional)").fill(t.criteria);
  const who = page.getByTestId("task-who");
  const opts = await who.locator("option").allTextContents();
  const coder = opts.find((o) => /coder/i.test(o));
  if (coder) await who.selectOption({ label: coder });
  await R.step(page, `A new task form ${t.title.slice(0, 20)}`);
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^(Create|Add|Save)/ }).first().click();
  await page.waitForTimeout(1500);
}

async function startDialog(page, label) {
  await page.getByRole("button", { name: "Start session" }).first().click();
  await page.waitForTimeout(2500);
  const text = await R.step(page, label);
  return text;
}

async function main() {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", {
    name: "Club tools 2",
    goal: "Tools for the chess club",
  });
  result.projectId = project.id;
  let { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await newTask(page, SWISS);
    await newTask(page, FOOTER);
    await R.step(page, "A tasks before");
    result.dialogBefore = await startDialog(page, "A start dialog");
    result.checkBefore = await R.api(NAME, "GET", `/projects/${enc(project.id)}/start-check`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await browser.close();
    out("restart daemon");
    execFileSync("node", [path.join(REPO, "scripts/bench/restart-daemon.mjs"), "--name", NAME], {
      stdio: "inherit",
    });
    ({ browser, page } = await R.openApp(NAME));
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(3000);
    result.dialogAfterRestart = await startDialog(page, "A start dialog after restart");
    result.checkAfterRestart = await R.api(NAME, "GET", `/projects/${enc(project.id)}/start-check`);
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(1500);
    await R.step(page, "A after start");
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    // While it runs: the Tasks row every 2 s, the API's view, the drawer once.
    let drawerTaken = false;
    for (let i = 0; i < 60; i++) {
      const views = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
      const running = views.find((t) => t.status === "in_progress");
      result.during.push(
        views.map((t) => ({
          title: t.title.slice(0, 14),
          status: t.status,
          actual: t.actual?.usdMicro,
          spent: t.spent?.usdMicro,
        })),
      );
      if (running && (running.spent?.usdMicro ?? 0) > 0 && !drawerTaken) {
        await page.waitForTimeout(500);
        result.rowDuring = await R.step(page, "A tasks during the run");
        await page.getByText(running.title).first().click();
        await page.waitForTimeout(1500);
        result.drawerDuring = await R.step(page, "A drawer during the run");
        result.detailDuring = await R.api(NAME, "GET", `/tasks/${enc(running.id)}`);
        await page.keyboard.press("Escape");
        drawerTaken = true;
      }
      const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`).catch(
        () => [],
      );
      const list = Array.isArray(sessions) ? sessions : (sessions.sessions ?? []);
      if (list.length && list.every((s) => !["running", "planned", "paused"].includes(s.status)))
        break;
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(3000);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    result.rowsAfter = await R.step(page, "A tasks after the run");
    const views = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
    result.viewsAfter = views.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      actual: t.actual,
      spent: t.spent,
      estimate: t.estimate,
    }));
    for (const t of views) {
      await page.getByText(t.title).first().click();
      await page.waitForTimeout(1500);
      result[`drawerAfter ${t.title.slice(0, 12)}`] = await R.step(page, `A drawer after ${t.title.slice(0, 12)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/costs`);
    await page.waitForTimeout(2500);
    result.costs = await R.step(page, "A costs");
    result.costsApi = await R.api(NAME, "GET", `/costs?projectId=${enc(project.id)}`).catch((e) => String(e));
    const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`).catch(() => []);
    const list = Array.isArray(sessions) ? sessions : (sessions.sessions ?? []);
    result.sessions = list.map((s) => ({ id: s.id, status: s.status, summary: s.summary }));
    if (list[0]) {
      await page.goto(`${b.uiUrl}/sessions/${enc(list[0].id)}`);
      await page.waitForTimeout(2500);
      result.sessionPage = await R.step(page, "A session");
      const det = page.getByText("Details").first();
      if (await det.count()) {
        await det.click();
        await page.waitForTimeout(1000);
        result.sessionDetails = await R.step(page, "A session details");
      }
      result.events = (await R.api(NAME, "GET", `/sessions/${enc(list[0].id)}/events`).catch(() => [])).map?.((e) => e.text);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(path.dirname(b.home), "steps", "A-result.json"), JSON.stringify(result, null, 2));
  out("done");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
