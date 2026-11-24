// Review walk A: Standard project, the session's task check splits a planned task (SC-13 line,
// session page change line). Usage: node walkA.cjs <repo> <bench> <label> <projectName> <styleTitle>
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label, projectName, styleTitle] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label, checks: {}, texts: {} };

(async () => {
  const project = await R.api(n, "POST", "/projects", {
    name: projectName,
    goal: "A page that sells things",
    autonomyLevel: 2,
  });
  const pid = project.id ?? project.project?.id;
  const task = (body) => R.api(n, "POST", `/projects/${pid}/tasks`, body);
  const create = await task({
    title: "Create the page in index.html",
    outcome: "The page exists",
    acceptanceCriteria: ["index.html exists"],
    riskTier: 1,
    specialist: "coder",
  });
  await task({
    title: styleTitle,
    outcome: "The page has its layout and colours",
    acceptanceCriteria: ["the layout is a grid", "the colours match the logo"],
    riskTier: 1,
    specialist: "coder",
    dependsOn: [create.id],
  });
  const started = await R.startSession(n, pid);
  const sid = started.session?.id ?? started.id;
  out.sessionId = sid;
  await R.waitForSession(n, sid, 300_000);
  await sleep(4000);
  out.tasks = (await R.api(n, "GET", `/projects/${pid}/tasks`)).map((t) => [t.title, t.status]);
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/sessions/${sid}`);
    await sleep(3000);
    out.texts.session = await R.step(page, `${label}-session`);
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    await sleep(2000);
    out.texts.tasks = await R.step(page, `${label}-tasks`);
    await page.goto(`${R.bench(n).uiUrl}/changes`);
    await sleep(2000);
    out.texts.changes = await R.step(page, `${label}-changes`);
  } finally {
    await browser.close();
  }
  out.reviewLines = out.texts.session
    .split("\n")
    .filter((l) => /review|replaced|planned|finding|grade/i.test(l));
  out.projectId = pid;
  out.problems = R.problems(n).slice(-10);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tasks: out.tasks, reviewLines: out.reviewLines, sid }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
