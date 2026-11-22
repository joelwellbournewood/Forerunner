// Screens area walk (a): a running task's drawer, twice a few seconds apart.
// Usage: node screens-walk-a.cjs <repo> <bench> <tag>
"use strict";
const [repo, N, tag] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);

(async () => {
  const me = await R.api(N, "GET", "/me");
  const project = await R.api(N, "POST", "/projects", { name: `Running ${tag}`, goal: "Watch" });
  await R.api(N, "POST", `/projects/${project.id}/tasks`, {
    title: "Build the quote page in index.html, styles.css and script.js",
    outcome: "index.html loads styles.css and script.js and shows a random quote",
    specialist: "coder",
  });
  await R.api(N, "POST", "/sessions", { agentId: me.agent.id, projectId: project.id, trigger: "manual" });
  const t = await R.until(
    async () =>
      (await R.api(N, "GET", `/projects/${project.id}/tasks`)).find((x) => x.status === "in_progress") ||
      null,
    60_000,
    200,
    "a running task",
  );
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  await page.goto(`${R.bench(N).uiUrl}/projects/${project.id}/tasks?task=${t.id}`);
  await page.waitForTimeout(2500);
  const first = await R.step(page, `${tag} a running drawer`);
  await page.waitForTimeout(3000);
  const later = await R.step(page, `${tag} a running drawer later`);
  console.log(JSON.stringify({ tag, first: first.slice(0, 1500), later: later.slice(0, 1500) }, null, 1));
  await browser.close();
  await R.until(
    async () =>
      (await R.api(N, "GET", "/sessions")).some((s) => ["running", "paused"].includes(s.status))
        ? null
        : true,
    300_000,
    1000,
    "the session to end",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
