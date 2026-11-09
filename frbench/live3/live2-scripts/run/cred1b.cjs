const L = require("./lib.cjs");
const { R, log, goto, text, save, enc } = L;
const NAME = "run-cred";
(async () => {
  const out = JSON.parse(require("fs").readFileSync("/tmp/frbench/live2/run/run-cred/steps/cred1.json","utf8"));
  const pid = out.projectId;
  const { browser, page } = await R.openApp(NAME);
  try {
    // R-runsonrefused: New task with the researcher
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`);
    await page.getByTestId("new-task").click();
    const d = page.getByTestId("new-task-dialog");
    await d.getByTestId("task-title").fill("Look up the club's founding year");
    await d.getByTestId("task-outcome").fill("notes/history.md gives the year the club was founded, with its source");
    const opts = await d.getByTestId("task-who").locator("option").allInnerTexts();
    out.whoOptions = opts;
    const researcher = opts.find((o) => /^researcher/.test(o));
    if (researcher) await d.getByTestId("task-who").selectOption({ label: researcher });
    await page.waitForTimeout(1500);
    const n = d.getByTestId("task-who-note");
    out.newTaskResearcherNote0 = (await n.count()) ? await n.first().innerText() : null;
    const writer = opts.find((o) => /^writer-marketing/.test(o));
    await d.getByTestId("task-who").selectOption({ label: writer });
    await page.waitForTimeout(1200);
    out.newTaskWriterNote = (await n.count()) ? await n.first().innerText() : null;
    await R.step(page, "c16a new task writer refused");
    await d.getByTestId("task-who").selectOption({ label: researcher });
    await page.waitForTimeout(1200);
    out.newTaskResearcherNote = (await n.count()) ? await n.first().innerText() : null;
    await R.step(page, "c16 new task researcher refused");
    await d.getByRole("button", { name: "Cancel" }).first().click();
    // research brief: planning waits
    const p2 = await L.newProject(page, NAME, { project: "Static hosts", brief: "Compare the free tiers of three static site hosts, with sources, in research/hosts.md." });
    out.researchProjectId = p2;
    await page.waitForTimeout(8000);
    out.researchProjectPage = await R.step(page, "c17 research project planning waits");
    out.intake = await R.api(NAME, "GET", `/projects/${enc(p2)}/intake`);
    const card = await R.api(NAME, "GET", `/projects/${enc(p2)}`);
    out.researchStatusLine = card.statusLine;
    await goto(page, NAME, "/inbox", 2500);
    out.inbox2 = await R.step(page, "c18 inbox after research brief");
    const inbox2 = await R.api(NAME, "GET", "/inbox");
    out.inboxApi2 = (inbox2.requests ?? []).filter(r=>r.status==="open").map((r) => ({ title: r.title, kind: r.kind }));
  } finally {
    save(NAME, "cred1b.json", out);
    await browser.close();
  }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
