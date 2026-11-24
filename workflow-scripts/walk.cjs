// l4-starts-carried after walk: L4g-left-4 (header while the project's own start waits) and
// L4a-left-5 (chat's start during a rest kept for the reset), at 1280 and 375 px.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_9dc331fe-c87-1/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const name = "fix-l4-starts-carried";
const out = { checks: [] };
const check = (what, ok, seen) => out.checks.push({ what, ok: !!ok, seen });
(async () => {
  const me = await R.api(name, "GET", "/me");
  const agents = await R.api(name, "GET", "/agents");
  const agentId = agents[0].id;
  const project = await R.api(name, "POST", "/projects", { name: "Map notes", goal: "A note" });
  await R.api(name, "POST", `/projects/${project.id}/tasks`, {
    title: "Write notes/map.md",
    outcome: "notes/map.md lists three places",
    acceptanceCriteria: ["it lists three places"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 0,
  });
  // The first Start meets the key's limit (the stand-in's 429) and ends to wait.
  const started = await R.api(name, "POST", "/sessions", { agentId, projectId: project.id });
  out.first = started.result;
  await R.until(async () => {
    const s = await R.api(name, "GET", `/sessions?projectId=${project.id}`);
    return s.length > 0 && s.every((x) => !["running", "paused", "planned"].includes(x.status));
  }, 60_000).catch(() => undefined);
  const card = await R.api(name, "GET", `/projects/${project.id}`);
  out.startWait = card.startWait ?? null;
  check("the card says the project's own session waits to go on", card.startWait === "goes_on", card.startWait);
  for (const vp of [
    { width: 1280, height: 800, tag: "1280" },
    { width: 375, height: 800, tag: "375" },
  ]) {
    const { browser, page } = await R.openApp(name, {
      viewport: { width: vp.width, height: vp.height },
      path: `/projects/${project.id}/summary`,
    });
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/summary`);
    await page.waitForTimeout(1500);
    await R.step(page, `after-l4g-left-4-waiting-header-${vp.tag}`);
    const start = await page.getByTestId("start-session").count();
    check(`no Start session in the header while the session waits to go on (${vp.tag} px)`, start === 0, start);
    await browser.close();
  }
  // Cancel the wait: Start comes back; the credential still rests, nothing is kept.
  await R.api(name, "POST", `/projects/${project.id}/continuation/cancel`);
  const { browser, page } = await R.openApp(name, {
    viewport: { width: 1280, height: 800 },
    path: `/projects/${project.id}/chat`,
  });
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/summary`);
  await page.waitForTimeout(1200);
  await R.step(page, "after-l4g-left-4-cancelled-header-1280");
  check("Start session is back after Cancel", (await page.getByTestId("start-session").count()) === 1, null);
  // L4a-left-5: chat's "run it now" during the rest.
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/chat`);
  await page.waitForTimeout(1200);
  const input = page.getByTestId("chat-input");
  await input.fill("run it now");
  await page.getByTestId("chat-send").click();
  const confirmation = page.getByTestId("pending-confirmation");
  await confirmation.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const readback = (await confirmation.textContent().catch(() => "")) ?? "";
  out.readback = readback;
  check("chat's read-back names when the kept start runs", /Start a session on Map notes at \d\d:\d\d/.test(readback), readback);
  await R.step(page, "after-l4a-left-5-readback-1280");
  await confirmation.getByTestId("confirm-yes").click().catch(() => undefined);
  await page.waitForTimeout(2000);
  const said = await R.step(page, "after-l4a-left-5-kept-1280");
  check("Yes keeps the start for the reset", /A session of Map notes starts at \d\d:\d\d\./.test(said), said.slice(-400));
  const sessions = await R.api(name, "GET", `/sessions?projectId=${project.id}`);
  check("no new session started", sessions.length === 1, sessions.length);
  const after = await R.api(name, "GET", `/projects/${project.id}`);
  check("the card says a Start is kept", after.startWait === "kept", after.startWait);
  await page.goto(`${R.bench(name).uiUrl}/projects/${project.id}/summary`);
  await page.waitForTimeout(1200);
  await R.step(page, "after-l4a-left-5-kept-header-1280");
  await browser.close();
  out.problems = R.problems ? R.problems(name) : null;
  fs.writeFileSync(`/tmp/frbench/${name}/steps/after-walk.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.checks, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
