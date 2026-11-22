"use strict";
const path = require("node:path");
const R = require(path.join(process.env.REPO_DIR, "scripts/bench/recorder.cjs"));
const N = "fix-github-result";
(async () => {
  const { browser, page } = await R.openApp(N);
  const projects = await R.api(N, "GET", "/projects");
  const seeded = projects.find((p) => p.name === "Seeded repo after");
  const empty = projects.find((p) => p.name === "Empty repo after");
  const sessions = await R.api(N, "GET", `/sessions?projectId=${seeded.id}`);
  const list = Array.isArray(sessions) ? sessions : sessions.sessions;
  await page.goto(`${R.bench(N).uiUrl}/sessions/${list[0].id}`);
  await page.waitForTimeout(2500);
  await R.step(page, "final-seeded-session");
  await page.goto(`${R.bench(N).uiUrl}/projects/${empty.id}/files`);
  await page.waitForTimeout(2500);
  await R.step(page, "final-empty-files");
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(2500);
  await R.step(page, "final-inbox");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
