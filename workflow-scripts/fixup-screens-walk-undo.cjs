// fixup-screens (c) and its variant: the chat starts a session on "Undone start", Changes → Undo
// stops it; then "Victor notes" runs, Stop all in the header, Continue where it stopped. Only
// Victor gets a new session. Also: the Undo's own row in Changes has no badge.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-9/scripts/bench/recorder.cjs");
const N = "fixup-screens";
const tag = process.argv[2] || "after";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const mk = async (name, file) => {
    const p = await R.api(N, "POST", "/projects", { name, goal: "Notes" });
    await R.api(N, "POST", `/projects/${p.id}/tasks`, {
      title: `Write notes/${file}.md`,
      outcome: "the note lists three things",
      riskTier: 1,
      specialist: "coder",
    });
    return p;
  };
  const u = await mk(`Undone start ${tag}`, "undone");
  const v = await mk(`Victor notes ${tag}`, "victor");
  const quiet = await mk(`Quiet one ${tag}`, "quiet");
  // The chat's start, in the project's Chat tab.
  await page.goto(`${ui}/projects/${u.id}/chat`);
  await page.waitForTimeout(1500);
  const box = page.locator('[data-testid$="-input"]').first();
  await box.fill("start a session");
  await page.locator('[data-testid$="-send"]').first().click();
  const yes = page.getByTestId("confirm-yes").last();
  await yes.waitFor({ timeout: 30000 });
  await R.step(page, `fx-undo-${tag}-chat-readback`);
  await yes.click();
  const sU = await R.until(
    async () =>
      (await R.api(N, "GET", `/sessions?projectId=${u.id}`)).find((x) => x.status === "running") ||
      null,
    30000,
    200,
    "the chat's session to run",
  );
  out.undoneSession = sU.id;
  await page.goto(`${ui}/changes`);
  await page.waitForTimeout(1500);
  const row = page.getByTestId("change").filter({ hasText: `Started a session on Undone start ${tag}` }).first();
  out.rowWhileRunning = await row.innerText();
  await row.getByTestId("change-undo").click();
  await page.waitForTimeout(2500);
  out.note = await page.getByTestId("changes-note").innerText().catch(() => null);
  await R.waitForSession(N, sU.id, 60000);
  out.undoneStop = (await R.api(N, "GET", `/sessions/${sU.id}`)).stopReason;
  await page.reload();
  await page.waitForTimeout(2000);
  out.changesAfterUndo = (await page.getByTestId("change").allInnerTexts()).slice(0, 3);
  await R.step(page, `fx-undo-${tag}-changes-after-undo`);

  // Victor runs from its Start button; Stop all in the header; Continue where it stopped.
  await page.goto(`${ui}/projects/${v.id}`);
  await page.waitForTimeout(1500);
  await page.getByTestId("start-session").click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await dialog.getByTestId("confirm-start-session").click();
  const sV = await R.until(
    async () =>
      (await R.api(N, "GET", `/sessions?projectId=${v.id}`)).find((x) => x.status === "running") ||
      null,
    30000,
    200,
    "Victor's session to run",
  );
  await page.goto(`${ui}/`);
  await page.waitForTimeout(1000);
  await page.getByTestId("kill-switch").click();
  await page.getByTestId("kill-confirm-stop").click();
  await page.getByTestId("kill-banner").waitFor({ timeout: 15000 });
  await R.waitForSession(N, sV.id, 60000);
  out.victorStop = (await R.api(N, "GET", `/sessions/${sV.id}`)).stopReason;
  await page.waitForTimeout(1500);
  out.homeStopped = await R.step(page, `fx-undo-${tag}-home-under-stop-all`);
  const before = (await R.api(N, "GET", "/sessions")).map((s) => s.id);
  out.continueTitle = await page.getByTestId("kill-continue").getAttribute("title");
  await page.getByTestId("kill-continue").click();
  await page.waitForTimeout(6000);
  const after = await R.api(N, "GET", "/sessions");
  const name = (id) =>
    id === u.id ? "Undone start" : id === v.id ? "Victor notes" : id === quiet.id ? "Quiet one" : id;
  out.newSessions = after
    .filter((s) => !before.includes(s.id))
    .map((s) => [name(s.projectId), s.status]);
  out.homeAfter = await R.step(page, `fx-undo-${tag}-home-after-continue`);
  await page.goto(`${ui}/sessions`);
  await page.waitForTimeout(1500);
  await R.step(page, `fx-undo-${tag}-session-list-after-continue`);
  // Let what started end before the next walk.
  for (const s of after.filter((x) => !before.includes(x.id)))
    await R.waitForSession(N, s.id, 120000).catch(() => undefined);
  out.tasks = {
    undone: (await R.api(N, "GET", `/projects/${u.id}/tasks`)).map((t) => t.status),
    victor: (await R.api(N, "GET", `/projects/${v.id}/tasks`)).map((t) => t.status),
    quiet: (await R.api(N, "GET", `/projects/${quiet.id}/tasks`)).map((t) => t.status),
  };
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
