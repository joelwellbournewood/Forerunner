const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const n = "verify-run4";
(async () => {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try { await R.skipSetup(page); } catch {}
  const { projectId, tasks } = await R.createPlannedProject(n, {
    project: "Quote page two",
    goal: "A quote page",
    brief: "Build a page that shows a random quote each time it is opened.",
  });
  const build = tasks.find((t) => /Build/.test(t.title));
  const ui = R.bench(n).uiUrl;
  await page.goto(`${ui}/projects/${projectId}/tasks?task=${build.id}`);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 3500));
    const ts = await R.api(n, "GET", `/projects/${projectId}/tasks`);
    const sess = await R.api(n, "GET", `/sessions?projectId=${projectId}`).catch(() => null);
    const txt = await page.locator('[data-testid="task-drawer"]').innerText().catch(() => "");
    const head = (txt.match(/· spent [^\n]*/) || [""])[0];
    const run = (txt.match(/coder · [^\n]*/) || [""])[0];
    const calls = R.modelCalls(n, "specialist").length;
    console.log(new Date().toISOString().slice(11, 19), ts.find((t) => t.id === build.id).status, "| drawer:", head, "| run:", run, "| specialist calls so far:", calls);
    await R.step(page, `run4-drawer-${i}`);
  }
  const list = await R.api(n, "GET", `/sessions?projectId=${projectId}`).catch(() => null);
  console.log(JSON.stringify(list).slice(0, 400));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
