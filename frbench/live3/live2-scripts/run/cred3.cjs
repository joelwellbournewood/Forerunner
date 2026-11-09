const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-cred";
(async () => {
  const prev = JSON.parse(require("fs").readFileSync("/tmp/frbench/live2/run/run-cred/steps/cred2.json", "utf8"));
  const { browser, page } = await R.openApp(NAME);
  const out = {};
  try {
    await goto(page, NAME, `/projects/${enc(prev.pid)}/costs`, 3000);
    out.costsTab = await R.step(page, "k11 club notes costs tab");
    await goto(page, NAME, `/projects/${enc(prev.pid)}/tasks`, 2500);
    await page.getByTestId("task-row").first().getByTestId("task-title").click();
    await page.waitForTimeout(2500);
    out.drawer = await R.step(page, "k12 club notes drawer full");
    const t = (await L.tasks(NAME, prev.pid))[0];
    out.taskApi = await R.api(NAME, "GET", `/tasks/${enc(t.id)}`);
  } finally { save(NAME, "cred3.json", out); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
