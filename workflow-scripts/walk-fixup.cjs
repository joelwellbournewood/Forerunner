// Fix-up walk for leftovers7-merge2 (the review's two blocking findings), after the reviewer's
// walk1.cjs: three tasks that each write index.html on bench/seeded (a plain home page, a quote
// page and a quotes page); the person presses Merge on the home page in the app; the two quote
// pages no longer merge cleanly into main. Then: Redo on the quote page's card in the Inbox (the
// session it starts must end with the pull request merging cleanly, the task's own commit on
// main, no second card), and the quotes page's conflict resolved on GitHub with a commit of the
// person's own (the row must offer no Merge and say it changed after the review; the one card
// says so too). Last, the person's Merge on the redone pull request merges it.
//   node walk-fixup.cjs <bench name> <repo root> <label>
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const NAME = process.argv[2];
const ROOT = process.argv[3];
const LABEL = process.argv[4] ?? "after";
const R = require(path.join(ROOT, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const result = { label: LABEL, checks: [], notes: [] };
const out = (s) => console.log(`[fixup-l7m2] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const note = (s) => {
  result.notes.push(s);
  out(`note ${s}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Person",
  GIT_AUTHOR_EMAIL: "person@example.test",
  GIT_COMMITTER_NAME: "Person",
  GIT_COMMITTER_EMAIL: "person@example.test",
};
const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
const runTry = (cwd, args) => {
  try {
    return { ok: true, out: run(cwd, args) };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
};

async function waitIdle(projectId, ms = 300_000) {
  await R.until(
    async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`);
      const all = Array.isArray(list) ? list : (list.sessions ?? []);
      return all.length > 0 && all.every((s) => !["running", "planned", "paused"].includes(s.status));
    },
    ms,
    1000,
    "the project's sessions to end",
  );
}

(async () => {
  const b = R.bench(NAME);
  const gh = JSON.parse(fs.readFileSync(path.join(path.dirname(b.home), "githost.json"), "utf8"));
  const bare0 = path.join(path.dirname(b.home), "githost", "bench", "seeded");
  const bare = fs.existsSync(bare0) ? bare0 : `${bare0}.git`;
  const ghGet = async (p) =>
    (await fetch(`${gh.url}${p}`, { headers: { Authorization: `Bearer ${gh.token}` } })).json();
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(NAME, "POST", "/projects", {
      name: "Three pages",
      goal: "A home page",
      repos: ["bench/seeded"],
    });
    result.projectId = project.id;
    const create = (title) =>
      R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
        title,
        outcome: "index.html is written",
        acceptanceCriteria: ["index.html exists"],
        priority: "medium",
        status: "ready",
        dependsOn: [],
        specialist: "coder",
        riskTier: 1,
      });
    // The stand-in writes a quote page when the title or a file it read names quotes, else a
    // plain page: the plain page is merged first, so both quote pages conflict with main, and
    // the Redo of one (from main, whose page is plain) still writes a quote page of its own.
    const q = await create("Write the home page in index.html");
    const h = await create("Write the quotes page in index.html");
    const w = await create("Write the quote page in index.html");
    result.tasks = { q: q.id, h: h.id, w: w.id };
    await R.startSession(NAME, project.id, "fix-up walk");
    await waitIdle(project.id);
    const rowsOf = async () =>
      (await R.api(NAME, "GET", `/projects/${enc(project.id)}/pull-requests`)).waiting;
    const taskRows = async () => (await rowsOf()).filter((r) => r.title.includes("index.html"));
    let rows = await taskRows();
    const docsRow = (await rowsOf()).find((r) => !r.title.includes("index.html"));
    check("three task pull requests wait for the person (and the docs one)", rows.length === 3, String(rows.length));
    const rowQ = rows.find((r) => r.title.includes("home page"));
    const rowH = rows.find((r) => r.title.includes("quotes page"));
    const rowW = rows.find((r) => r.title.includes("quote page"));
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-01 overview three waiting`);

    // The person presses Merge on the plain home page's row in the app.
    const liQ = page.locator(`[data-testid="pr-waiting"][data-number="${rowQ.number}"]`);
    await liQ.getByTestId("pr-merge").click();
    await R.until(
      async () => !(await rowsOf()).some((r) => r.number === rowQ.number),
      90_000,
      1000,
      "the home page's pull request to merge",
    );
    await R.until(
      async () => (await rowsOf()).filter((r) => r.merge?.canMerge === false).length === 2,
      30_000,
      1000,
      "both rows to stop offering Merge",
    ).catch((e) => note(`rows did not both block: ${e.message}`));
    rows = await taskRows();
    const docsAfter = (await rowsOf()).find((r) => r.number === docsRow?.number);
    check("the docs pull request keeps its Merge", !docsRow || docsAfter?.merge?.canMerge === true, JSON.stringify(docsAfter?.merge));
    for (const r of rows)
      check(
        `row #${r.number} offers no Merge and says it conflicts`,
        r.merge?.canMerge === false && /conflicts with main/.test(r.merge?.sentence ?? ""),
        JSON.stringify(r.merge),
      );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-02 overview after merging the home page`);
    const cardsOf = async (taskId) =>
      (await R.api(NAME, "GET", "/inbox")).requests.filter(
        (r) => r.taskId === taskId && r.status === "open",
      );
    check("one card for each conflicted pull request", (await cardsOf(h.id)).length === 1 && (await cardsOf(w.id)).length === 1);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-03 inbox two conflict cards`);

    // Finding 1: Redo on the quote page's card, in the Inbox.
    const [cardW] = await cardsOf(w.id);
    const cardEl = page.locator(`[data-testid="request"][data-request-id="${cardW.id}"]`);
    result.cardW = { title: cardW.title, choices: (cardW.choices ?? []).map((x) => [x.label, x.explain]) };
    await cardEl.getByRole("button", { name: "Redo" }).click();
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-04 inbox after Redo on the quote page`);
    await sleep(3000);
    await waitIdle(project.id, 300_000).catch((e) => note(`redo session: ${e.message}`));
    const taskW = await R.api(NAME, "GET", `/tasks/${enc(w.id)}`);
    const statusW = taskW.status ?? taskW.task?.status;
    result.afterRedo = { status: statusW, reason: taskW.reason ?? taskW.task?.reason };
    check("the redone task is done", statusW === "done", JSON.stringify(result.afterRedo));
    const wCards = await cardsOf(w.id);
    result.afterRedoCards = wCards.map((c) => ({ title: c.title, body: c.body }));
    check("no second card for the redone task (no rebase card)", wCards.length === 0, JSON.stringify(result.afterRedoCards));
    const prW = await ghGet(`/repos/bench/seeded/pulls/${rowW.number}`);
    result.prW = { state: prW.state, merged: prW.merged, mergeable: prW.mergeable };
    check("the same pull request is open and merges cleanly", prW.state === "open" && prW.mergeable === true, JSON.stringify(result.prW));
    result.prWCommits = run(bare, ["log", "--format=%s", `main..${rowW.branch}`]).split("\n");
    result.prWParentIsMain =
      run(bare, ["rev-parse", `${rowW.branch}^`]) === run(bare, ["rev-parse", "main"]);
    check(
      "the redone branch is the task's own commit on top of main",
      result.prWCommits.length === 1 && result.prWParentIsMain,
      JSON.stringify(result.prWCommits),
    );
    await R.until(
      async () => (await rowsOf()).find((r) => r.number === rowW.number)?.merge?.canMerge === true,
      30_000,
      1000,
      "the quote page's row to offer Merge",
    ).catch((e) => note(e.message));
    const rowW2 = (await rowsOf()).find((r) => r.number === rowW.number);
    check("the redone pull request's row offers Merge", rowW2?.merge?.canMerge === true, JSON.stringify(rowW2?.merge));
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-05 inbox after the redo session`);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-06 overview after the redo session`);

    // Finding 2: the person resolves the quotes page's conflict on GitHub (merges main in, keeps
    // main's page): a commit after the review.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fx-l7m2-"));
    run(tmp, ["clone", "-q", bare, "c"]);
    const c = path.join(tmp, "c");
    run(c, ["checkout", "-q", rowH.branch]);
    const m = runTry(c, ["merge", "--no-edit", "origin/main"]);
    note(`merge of main into the quotes page branch: ${m.ok ? "clean" : "conflict"}`);
    fs.writeFileSync(
      path.join(c, "index.html"),
      fs
        .readFileSync(path.join(c, "index.html"), "utf8")
        .replace(/<<<<<<<[\s\S]*?=======\n([\s\S]*?)>>>>>>>[^\n]*\n/g, "$1"),
    );
    run(c, ["add", "index.html"]);
    runTry(c, ["commit", "-q", "--no-edit"]);
    run(c, ["push", "-q", "origin", `HEAD:${rowH.branch}`]);
    fs.rmSync(tmp, { recursive: true, force: true });
    const prH2 = await ghGet(`/repos/bench/seeded/pulls/${rowH.number}`);
    check("GitHub says the quotes page merges again", prH2.mergeable === true, `${prH2.mergeable}`);
    await R.until(
      async () =>
        /changed after the review/.test(
          (await rowsOf()).find((r) => r.number === rowH.number)?.merge?.sentence ?? "",
        ),
      30_000,
      1000,
      "the quotes page's row to say it changed after the review",
    ).catch((e) => note(e.message));
    const rowH2 = (await rowsOf()).find((r) => r.number === rowH.number);
    result.rowH2 = rowH2?.merge ?? null;
    check(
      "the resolved row offers no Merge and says it changed after the review",
      rowH2?.merge?.canMerge === false && /changed after the review/.test(rowH2?.merge?.sentence ?? ""),
      JSON.stringify(rowH2?.merge),
    );
    await sleep(7000);
    const hCards = await cardsOf(h.id);
    result.hCards = hCards.map((x) => ({ title: x.title, body: x.body, details: x.details ?? null, choices: (x.choices ?? []).map((y) => y.label) }));
    check(
      "its Details say what to do now, not how to resolve the conflict",
      JSON.stringify(hCards[0]?.details ?? null) ===
        JSON.stringify(["Look at the commits pushed after the review", "Merge it yourself or ask for a new review"]),
      JSON.stringify(hCards[0]?.details ?? null),
    );
    check(
      "one card for it, saying it changed after the review",
      hCards.length === 1 && /changed after the review/.test(hCards[0]?.body ?? ""),
      JSON.stringify(result.hCards),
    );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    const ov = await R.step(page, `${LABEL}-07 overview after resolving on GitHub`);
    const liH = page.locator(`[data-testid="pr-waiting"][data-number="${rowH.number}"]`);
    check("no Merge button on the resolved row", (await liH.getByTestId("pr-merge").count()) === 0);
    result.overviewText = ov;
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await page.getByText("Details", { exact: true }).first().click().catch(() => undefined);
    await page.waitForTimeout(500);
    await R.step(page, `${LABEL}-08 inbox after resolving on GitHub`);
    // The redone quote page: the person presses Merge in the app, and it merges.
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`);
    await page.waitForTimeout(2500);
    const liW = page.locator(`[data-testid="pr-waiting"][data-number="${rowW.number}"]`);
    if ((await liW.getByTestId("pr-merge").count()) > 0) {
      await liW.getByTestId("pr-merge").click();
      await R.until(
        async () => (await ghGet(`/repos/bench/seeded/pulls/${rowW.number}`)).merged === true,
        60_000,
        1000,
        "the redone quote page to merge",
      ).catch((e) => note(e.message));
      const prW3 = await ghGet(`/repos/bench/seeded/pulls/${rowW.number}`);
      check("Merge on the redone pull request merges it", prW3.merged === true, `${prW3.merged}`);
      await page.waitForTimeout(1500);
      await R.step(page, `${LABEL}-09 overview after merging the redone page`);
    } else check("Merge on the redone pull request merges it", false, "no Merge button");
    result.problems = R.problems(NAME);
  } catch (e) {
    result.error = String(e?.stack ?? e);
    out(`error: ${result.error}`);
  } finally {
    fs.writeFileSync(
      path.join(path.dirname(b.home), "steps", `${LABEL}-walk.json`),
      JSON.stringify(result, null, 2),
    );
    await browser.close();
  }
})();
