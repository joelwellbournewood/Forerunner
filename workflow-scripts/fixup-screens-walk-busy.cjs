// fixup-screens (f) while busy: a session runs on "Busy one"; "Empty one" has nothing to run.
// Its Start dialog, POST /sessions and the chat refuse in the start check's words, and no
// session ever appears for it. Run with FORERUNNER_BENCH_DELAY_MS=4000 so the busy session lasts.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-9/scripts/bench/recorder.cjs");
const N = "fixup-screens";
const tag = process.argv[2] || "after";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const busy = await R.api(N, "POST", "/projects", { name: `Busy one ${tag}`, goal: "Notes" });
  await R.api(N, "POST", `/projects/${busy.id}/tasks`, {
    title: "Write notes/busy.md",
    outcome: "the note lists three things",
    riskTier: 1,
    specialist: "coder",
  });
  const empty = await R.api(N, "POST", "/projects", { name: `Empty one ${tag}`, goal: "Nothing yet" });
  await R.api(N, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: busy.id,
    trigger: "manual",
    reason: "walk",
  });
  const sB = await R.until(
    async () =>
      (await R.api(N, "GET", `/sessions?projectId=${busy.id}`)).find((x) => x.status === "running") ||
      null,
    30000,
    200,
    "the busy session to run",
  );
  // The empty project's Start dialog while the other session runs.
  await page.goto(`${ui}/projects/${empty.id}`);
  await page.waitForTimeout(1500);
  await page.getByTestId("start-session").click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  out.dialog = await dialog.innerText();
  out.startDisabled = await dialog.getByTestId("confirm-start-session").isDisabled();
  await R.step(page, `fx-busy-${tag}-empty-start-dialog`);
  await page.keyboard.press("Escape");
  out.check = await R.api(N, "GET", `/projects/${empty.id}/start-check`);
  out.check = { busy: out.check.busy, blocked: out.check.blocked };
  // The API and the phone's path.
  out.post = await R.apiRaw(N, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: empty.id,
    trigger: "manual",
    reason: "api",
  });
  // The chat.
  await page.goto(`${ui}/projects/${empty.id}/chat`);
  await page.waitForTimeout(1500);
  await page.locator('[data-testid$="-input"]').first().fill("start a session");
  await page.locator('[data-testid$="-send"]').first().click();
  await page.waitForTimeout(4000);
  out.chat = await R.step(page, `fx-busy-${tag}-empty-chat`);
  out.stillRunning = (await R.api(N, "GET", `/sessions/${sB.id}`)).status;
  await R.waitForSession(N, sB.id, 300000);
  await page.waitForTimeout(3000);
  out.emptySessions = (await R.api(N, "GET", `/sessions?projectId=${empty.id}`)).map((s) => [
    s.status,
    s.statusText,
  ]);
  await page.goto(`${ui}/sessions`);
  await page.waitForTimeout(1500);
  await R.step(page, `fx-busy-${tag}-session-list`);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
