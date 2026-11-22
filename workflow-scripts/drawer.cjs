// Open a task's drawer and its "See what was checked" as a person does, and save the step.
// node drawer.cjs <repo> <bench> <label> <project name substring> <task title substring>
"use strict";
const path = require("node:path");
const [REPO, NAME, LABEL, PROJECT, TASK] = process.argv.slice(2);
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const projects = await R.api(NAME, "GET", "/projects");
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  const p = list.find((x) => x.name.includes(PROJECT));
  const tasks = await R.api(NAME, "GET", `/projects/${enc(p.id)}/tasks`);
  const t = tasks.find((x) => x.title.includes(TASK));
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(p.id)}/tasks?task=${enc(t.id)}`);
    await page.waitForTimeout(2500);
    const ev = page.getByTestId("review-evidence").first();
    if (await ev.count()) {
      await ev.locator("summary").first().click();
      await page.waitForTimeout(800);
      await ev.scrollIntoViewIfNeeded();
    } else console.log("no review evidence shown");
    const text = await R.step(page, `${LABEL} drawer checked`);
    console.log(text.slice(text.indexOf("See what was checked"), text.indexOf("See what was checked") + 900));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
