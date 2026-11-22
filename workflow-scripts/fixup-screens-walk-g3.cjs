// fixup-screens (g'): FORERUNNER_BENCH_FAIL=Third ladder, FAIL_TIMES=3: the stand-in's own attempt
// fails too. Every person line names the specialist that ran it.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-9/scripts/bench/recorder.cjs");
const N = "fixup-screens";
const tag = process.argv[2] || "after";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const me = await R.api(N, "GET", "/me");
  const p = await R.api(N, "POST", "/projects", { name: `Third ladder ${tag}`, goal: "Notes" });
  const t = await R.api(N, "POST", `/projects/${p.id}/tasks`, {
    title: "Third ladder: write notes/third.md",
    outcome: "notes/third.md lists the steps",
    riskTier: 1,
    specialist: "coder",
  });
  // Started from the Start dialog, as a person does.
  await page.goto(`${ui}/projects/${p.id}`);
  await page.waitForTimeout(1500);
  await page.getByTestId("start-session").click();
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await dialog.getByTestId("confirm-start-session").click();
  const s = await R.until(
    async () => (await R.api(N, "GET", `/sessions?projectId=${p.id}`))[0] || null,
    30000,
    300,
    "the session",
  );
  await R.waitForSession(N, s.id, 300000);
  await page.goto(`${ui}/sessions/${s.id}`);
  await page.waitForTimeout(2500);
  out.sessionPage = await R.step(page, `fx-g3-${tag}-session-page`);
  const ev = await R.api(N, "GET", `/sessions/${s.id}/events`);
  out.personLines = ev
    .filter((e) => e.audience === "person")
    .map((e) => [e.type, e.payload && e.payload.specialist, e.text]);
  const d = await R.api(N, "GET", `/tasks/${t.id}`);
  out.runs = d.runs.map((r) => [r.kind, r.specialist, r.outcome]);
  await page.goto(`${ui}/projects/${p.id}/tasks?task=${t.id}`);
  await page.getByTestId("task-drawer").waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  out.drawerRuns = await page.getByTestId("drawer-run").allInnerTexts();
  await R.step(page, `fx-g3-${tag}-drawer`);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
