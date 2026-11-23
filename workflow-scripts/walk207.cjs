// Bench walk for the review's blocking item 2 (L4-money-207 sibling): crash, Continue, Stop now
// on the continuation, then the Update offers no Continue and a stale Continue gets only the rest.
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const repo = process.argv[2];
const name = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const out = { steps: [] };
const note = (k, v) => {
  out.steps.push({ k, v });
  console.log(k, typeof v === "string" ? v : JSON.stringify(v));
};

(async () => {
  const me = await R.api(name, "GET", "/me");
  const project = await R.api(name, "POST", "/projects", { name: "Bakery site", goal: "Pages" });
  const task = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
    title: "Welcome page in welcome.html",
    outcome: "welcome.html greets the bakery's visitors",
    riskTier: 1,
    specialist: "coder",
  });
  const started = await R.api(name, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    budgetUsdMicro: 1_250_000,
  });
  note("first start", { result: started.result, cap: started.session?.budgetCap });
  const label = async () =>
    (await R.api(name, "GET", `/projects/${project.id}/tasks`)).find((t) => t.id === task.id)
      ?.display?.label;
  await R.until(async () => (await label()) === "Being reviewed", 90_000, 500, "Being reviewed");
  note("before crash", await label());
  execFileSync("node", [path.join(repo, "scripts/bench/restart-daemon.mjs"), "--name", name, "--hard"], {
    stdio: "inherit",
  });
  const crashUpdate = async () =>
    (await R.api(name, "GET", "/inbox")).messages.find((m) =>
      m.body.startsWith("Your last session was interrupted when Forerunner closed."),
    );
  await R.until(async () => !!(await crashUpdate()), 60_000, 500, "the crash Update");
  const u1 = await crashUpdate();
  note("Update after the crash", { body: u1.body, action: u1.action, readAt: u1.readAt });

  const { browser, page } = await R.openApp(name, { path: "/inbox", freshProfile: true });
  await R.skipSetup(page);
  await page.goto(`${R.bench(name).uiUrl}/inbox`);
  await page.getByTestId("message-continue").first().waitFor({ timeout: 20_000 });
  note("inbox text (Update)", (await R.step(page, "after-crash-update-continue")).split("\n").filter((l) => /interrupted|Continue|Opens Start|Mark read/.test(l)));
  await page.getByTestId("message-continue").first().click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor({ timeout: 10_000 });
  note("dialog", (await R.step(page, "after-continue-press-dialog")).split("\n").filter((l) => /budget|left|Start/.test(l)).slice(0, 8));
  const u2 = await crashUpdate();
  note("Update read after the press", { readAt: u2.readAt, action: !!u2.action });
  await dialog.getByTestId("confirm-start-session").click();
  const interruptedId = u1.action.sessionId;
  const goesOn = await R.until(
    async () =>
      (await R.api(name, "GET", `/projects/${project.id}/sessions`)).working?.find(
        (r) => r.id !== interruptedId,
      ) ?? null,
    30_000,
    500,
    "the continuation",
  );
  note("continuation", { id: goesOn.id, gist: goesOn.gist, startedBy: goesOn.startedBy });
  await R.until(async () => (await label()) === "Being reviewed", 90_000, 500, "Being reviewed again");
  const stopped = await R.api(name, "POST", `/sessions/${goesOn.id}/stop`, { reason: "stopped from the live view" });
  note("Stop now", stopped.status);
  const ended = await R.waitForSession(name, goesOn.id, 60_000);
  note("continuation ended", { status: ended.status, statusText: ended.statusText, spent: ended.spent, summary: ended.summary });
  note("task after Stop now", await label());
  const u3 = await crashUpdate();
  note("Update after a later session began", { action: u3.action ?? null, readAt: u3.readAt });
  await page.goto(`${R.bench(name).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  const inboxText = await R.step(page, "after-stop-update-no-continue");
  note("inbox after", inboxText.split("\n").filter((l) => /interrupted|Continue|Opens Start|Mark read/.test(l)));
  note("Continue buttons on the page", await page.getByTestId("message-continue").count());
  // A Continue of the interrupted session sent after that (a Start dialog left open, the phone).
  const interrupted = await R.api(name, "GET", `/sessions/${interruptedId}`);
  const left = interrupted.budgetCap.usdMicro - interrupted.spent.usdMicro;
  const again = await R.api(name, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    continues: interruptedId,
  });
  note("stale Continue", {
    result: again.result,
    cap: again.session?.budgetCap,
    leftOfInterrupted: left,
    spentByContinuation: ended.spent,
    expected: left - ended.spent.usdMicro,
  });
  if (again.session?.id) {
    await R.api(name, "POST", `/sessions/${again.session.id}/stop`, { reason: "walk cleanup" });
    await R.waitForSession(name, again.session.id, 60_000);
  }
  await browser.close();
  fs.writeFileSync(path.join(R.bench(name).home, "..", "walk207.json"), JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
