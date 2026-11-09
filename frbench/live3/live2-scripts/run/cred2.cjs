// Step 1 part 2: type the real key into Settings (setup assistant's Claude step) from the environment.
// NO screenshot while the field holds the key; the key is never logged.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-cred";
(async () => {
  const key = process.env.FORERUNNER_ANTHROPIC_API_KEY;
  if (!key) throw new Error("no key in the environment");
  const prev = JSON.parse(require("fs").readFileSync("/tmp/frbench/live2/run/run-cred/steps/cred1b.json", "utf8"));
  const pid = prev.projectId, p2 = prev.researchProjectId;
  const out = { pid, p2, timeline: [] };
  const mark = (what, extra) => { const e = { t: new Date().toISOString(), what, ...(extra||{}) }; out.timeline.push(e); log(what, extra ? JSON.stringify(extra).slice(0, 300) : ""); };
  const { browser, page } = await R.openApp(NAME);
  try {
    await goto(page, NAME, "/settings", 2500);
    // Settings -> Accounts and keys -> Save a new key
    await page.getByTestId("settings-accounts").getByRole("link", { name: "Save a new key" }).first().click();
    await page.waitForTimeout(2500);
    out.setupBefore = await R.step(page, "k01 setup claude step before typing");
    const input = page.getByTestId("setup-anthropic-input");
    await input.fill(key);           // no screenshot from here ...
    await page.getByTestId("setup-anthropic-check").click();
    mark("clicked Check and save");
    // wait until the field is empty again (the box clears on submit) before any screenshot
    await R.until(async () => (await input.inputValue().catch(() => "")) === "", 10000, 200, "the key field to be empty");
    await R.until(async () => !/Checking…/.test(await page.evaluate(() => document.body.innerText)), 60000, 500, "the check to end");
    await page.waitForTimeout(2000);
    if ((await input.inputValue().catch(() => "")) !== "") throw new Error("field not empty; refusing to screenshot");
    out.setupAfter = await R.step(page, "k02 setup after check and save");
    mark("saved", { setup: await R.api(NAME, "GET", "/setup").then((s) => ({ credentials: s.credentials, restartNeeded: s.restartNeeded, complete: s.complete })) });
    // Refused mark?
    await goto(page, NAME, "/settings", 2500);
    out.settingsAfter = await R.step(page, "k03 settings basics after save");
    const order = await R.api(NAME, "GET", "/settings/billing-order").catch((e) => ({ error: String(e.message) }));
    out.orderAfter = order;
    // Start dialog on Club notes right away (TR-12 partial: planning may hold the agent)
    await goto(page, NAME, `/projects/${enc(pid)}`, 1000);
    out.statusRightAfter = await R.step(page, "k04 club notes right after save");
    const startBtn = page.getByRole("button", { name: /Start session|Open running session/ }).first();
    if (await startBtn.count()) {
      const label = await startBtn.innerText();
      mark("header button", { label });
      if (/Start session/.test(label)) {
        await startBtn.click(); await page.waitForTimeout(2000);
        out.startDialogRightAfter = await R.step(page, "k05 start dialog right after save");
        await page.keyboard.press("Escape");
      }
    }
    // watch both: task done, plan drafted
    let taskDone = null, planPending = null;
    const end = Date.now() + 420000;
    while (Date.now() < end && !(taskDone && planPending)) {
      const rows = await L.tasks(NAME, pid);
      const t = rows[0];
      if (!taskDone && t.status === "done") { taskDone = t; mark("task done", { display: t.display }); }
      if (!taskDone) mark("task", { status: t.status, display: t.display?.label });
      const ik = await R.api(NAME, "GET", `/projects/${enc(p2)}/intake`);
      if (!planPending && ik.state === "pending") { planPending = ik; mark("plan pending"); }
      else if (!planPending) mark("intake", { state: ik.state });
      await L.sleep(10000);
    }
    out.taskDone = !!taskDone; out.planPending = !!planPending;
    out.sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`);
    await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
    out.tasksAfter = await R.step(page, "k06 club notes tasks after key");
    await page.getByTestId("task-row").first().getByTestId("task-title").click();
    await page.waitForTimeout(2000);
    out.drawerAfter = await R.step(page, "k07 club notes drawer after key");
    await page.keyboard.press("Escape");
    await goto(page, NAME, "/inbox", 3000);
    out.inboxAfter = await R.step(page, "k08 inbox after key with plan card");
    const plan = page.locator("text=Approve and start").first();
    if (await plan.count()) await plan.scrollIntoViewIfNeeded();
    await goto(page, NAME, `/projects/${enc(p2)}`, 3000);
    out.researchPlan = await R.step(page, "k09 research plan card on project");
    const inbox = await R.api(NAME, "GET", "/inbox");
    out.inboxApi = inbox.requests?.filter((r) => r.status === "open").map((r) => ({ id: r.id, title: r.title, kind: r.kind, body: r.body, options: r.options, payloadKeys: Object.keys(r.payload ?? {}) }));
    out.inboxMessages = (inbox.messages ?? []).map((m) => m.body ?? m.title);
    await goto(page, NAME, "/settings", 2500);
    const adv = page.getByTestId("settings-advanced-summary");
    if (await adv.count()) { await adv.first().click(); await page.waitForTimeout(1000); }
    const ord = page.getByTestId("billing-order-section");
    if (await ord.count()) await ord.first().scrollIntoViewIfNeeded();
    out.settingsAdvancedAfter = await R.step(page, "k10 settings advanced after key");
  } finally {
    save(NAME, "cred2.json", out);
    await browser.close();
  }
  log("done");
})().catch((e) => { console.error(String(e.message || e).slice(0, 500)); process.exit(1); });
