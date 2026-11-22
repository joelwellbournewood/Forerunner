// Screens area walk (d): without Claude (--provider none) a project with a ready task; then
// with Stop all on. Usage: node screens-walk-d.cjs <repo> <bench> <tag>
"use strict";
const [repo, N, tag] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);

(async () => {
  const project = await R.api(N, "POST", "/projects", { name: `No key ${tag}`, goal: "Say so" });
  await R.api(N, "POST", `/projects/${project.id}/tasks`, {
    title: "Write the README",
    outcome: "README.md says what this is",
  });
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const ui = R.bench(N).uiUrl;
  await page.goto(`${ui}/`);
  await page.waitForTimeout(2500);
  const home = await R.step(page, `${tag} d home without Claude`);
  await page.goto(`${ui}/projects/${project.id}`);
  await page.waitForTimeout(2000);
  await R.step(page, `${tag} d project without Claude`);
  const card = (await R.api(N, "GET", "/projects")).find((p) => p.id === project.id);
  await R.api(N, "POST", "/kill", { scope: "all", reason: "stop all from the UI" });
  await page.goto(`${ui}/`);
  await page.waitForTimeout(2000);
  await R.step(page, `${tag} d home under Stop all`);
  const stopped = (await R.api(N, "GET", "/projects")).find((p) => p.id === project.id);
  await R.api(N, "POST", "/kill/resume", {});
  console.log(
    JSON.stringify(
      { tag, noKey: card.statusLine, stopAll: stopped.statusLine, homeHasContinue: /Continue/.test(home) },
      null,
      1,
    ),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
