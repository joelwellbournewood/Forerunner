// Start-dialog walk for the cost area: a project without a brief, three tasks a person makes in
// the New task dialog (no estimate of their own), then the Start session dialog with a CHF 0.50
// budget: which tasks it says it runs and which it leaves out. Nothing is started.
//   node start-dialog.cjs <bench> <label>
"use strict";
const path = require("node:path");
const repo = process.env.FR_REPO;
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));

const NAME = process.argv[2];
const LABEL = process.argv[3] ?? "walk";

(async () => {
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Notes site ${LABEL}`,
    goal: "A small notes site",
  });
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${R.bench(NAME).uiUrl}/projects/${encodeURIComponent(project.id)}/tasks`);
    await page.waitForTimeout(1500);
    for (const title of ["Write the home page", "Write the about page", "Write the contact page"]) {
      await page.getByRole("button", { name: "New task", exact: true }).first().click();
      await page.waitForTimeout(400);
      await page.getByLabel("Title").fill(title);
      await page.getByLabel("What done looks like").fill(`${title} in plain HTML`);
      await page.getByTestId("create-task").click();
      await page.waitForTimeout(800);
    }
    await R.step(page, `${LABEL} tasks made by a person`);
    await page.goto(`${R.bench(NAME).uiUrl}/projects/${encodeURIComponent(project.id)}`);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Start session", exact: true }).first().click();
    await page.waitForTimeout(800);
    const input = page.locator('input[name="budget"]');
    await input.fill("0.50");
    await page.waitForTimeout(1500);
    const text = await R.step(page, `${LABEL} start dialog at CHF 0.50`);
    const check = await R.api(
      NAME,
      "GET",
      `/projects/${encodeURIComponent(project.id)}/start-check?budgetUsdMicro=${Math.round(0.5 / 0.8 * 1e6)}`,
    );
    console.log(JSON.stringify({ runnable: check.runnable, overBudget: check.overBudget }, null, 1));
    console.log(text.slice(0, 1500));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
