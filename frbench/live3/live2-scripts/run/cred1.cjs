// Step 1 part 1: refused key in the vault (routed provider). One-task project; Start; what the person sees.
const L = require("./lib.cjs");
const { R, log, goto, text, save, enc } = L;
const NAME = "run-cred";
(async () => {
  const out = { steps: [] };
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    out.home = await R.step(page, "c01 home after set up later");
    const existing = (await R.api(NAME, "GET", "/projects")).find((p) => p.name === "Club notes");
    const pid = existing ? existing.id : await L.newProject(page, NAME, { project: "Club notes", goal: "A welcome note for the club" });
    out.projectId = pid;
    log("project", pid);
    await R.step(page, "c02 project created");
    const t = await L.newTask(page, NAME, pid, {
      title: "Write the welcome note in notes/welcome.md",
      outcome: "notes/welcome.md welcomes new members of the chess club in three short sentences",
      criteria: ["notes/welcome.md exists", "It has three sentences"],
      who: "writer-marketing",
      shotLabel: "c03 new task dialog refused key",
    });
    out.newTaskRunsOn = t.note;
    log("new task runs-on note:", t.note);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`);
    out.tasksBefore = await R.step(page, "c04 tasks before start");
    // Start session from the header
    await goto(page, NAME, `/projects/${enc(pid)}`);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog1 = await R.step(page, "c05 start dialog first");
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(3000);
    out.afterStart = await R.step(page, "c06 after start");
    // wait for the session to end
    const sessions = await R.until(async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`);
      const arr = Array.isArray(list) ? list : list.sessions ?? [];
      return arr.length ? arr : null;
    }, 30000, 1000, "a session");
    const sid = sessions[0].id;
    out.sessionId = sid;
    const s = await R.waitForSession(NAME, sid, 180000);
    out.session = { status: s.status, statusText: s.statusText, summary: s.summary, stopReason: s.stopReason };
    log("session", JSON.stringify(out.session));
    await page.waitForTimeout(3000);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 3000);
    out.tasksAfter = await R.step(page, "c07 tasks after refused");
    out.taskRows = (await L.tasks(NAME, pid)).map((x) => ({ title: x.title, status: x.status, display: x.display, reason: x.reason }));
    // drawer
    await page.getByText("Write the welcome note in notes/welcome.md").first().click();
    await page.waitForTimeout(2000);
    out.drawer = await R.step(page, "c08 task drawer refused");
    await page.keyboard.press("Escape");
    await goto(page, NAME, "/inbox", 3000);
    out.inbox = await R.step(page, "c09 inbox refused");
    const inbox = await R.api(NAME, "GET", "/inbox");
    out.inboxApi = { requests: (inbox.requests ?? []).filter(r=>r.status==="open").map((r) => ({ title: r.title, kind: r.kind, body: r.body })), messages: (inbox.messages ?? []).map((m) => m.body ?? m.title) };
    await goto(page, NAME, `/sessions/${enc(sid)}`, 2500);
    out.sessionPage = await R.step(page, "c10 session page refused");
    await goto(page, NAME, `/projects/${enc(pid)}`, 2500);
    out.overview = await R.step(page, "c11 overview refused");
    await goto(page, NAME, "/", 2500);
    out.homeAfter = await R.step(page, "c12 home refused");
    await goto(page, NAME, "/settings", 2500);
    out.settingsBasics = await R.step(page, "c13 settings basics refused");
    const adv = page.getByTestId("settings-advanced-summary");
    if (await adv.count()) { await adv.first().click(); await page.waitForTimeout(1000); }
    const order = page.getByTestId("billing-order-section");
    if (await order.count()) await order.first().scrollIntoViewIfNeeded();
    out.settingsAdvanced = await R.step(page, "c14 settings advanced refused");
    // R-startcred: Start dialog again
    await goto(page, NAME, `/projects/${enc(pid)}`);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(2500);
    out.startDialog2 = await R.step(page, "c15 start dialog after refused");
    const confirm = page.getByTestId("confirm-start-session");
    out.startDisabled = (await confirm.count()) ? await confirm.first().isDisabled() : "no start button";
    await page.keyboard.press("Escape");
    // R-runsonrefused: New task with the researcher
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`);
    await page.getByTestId("new-task").click();
    await page.getByTestId("task-title").fill("Look up the club's founding year");
    await page.getByTestId("task-outcome").fill("notes/history.md gives the year the club was founded, with its source");
    const opts = await page.getByTestId("task-who").locator("option").allInnerTexts();
    out.whoOptions = opts;
    const researcher = opts.find((o) => /^researcher/.test(o));
    if (researcher) await page.getByTestId("task-who").selectOption({ label: researcher });
    await page.waitForTimeout(1500);
    const n = page.getByTestId("task-who-note");
    out.newTaskResearcherNote = (await n.count()) ? await n.first().innerText() : null;
    await R.step(page, "c16 new task researcher refused");
    await page.getByRole("button", { name: "Cancel" }).first().click();
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
    save(NAME, "cred1.json", out);
    await browser.close();
  }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
