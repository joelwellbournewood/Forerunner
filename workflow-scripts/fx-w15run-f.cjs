// Reviewer walk E for w15-run (W15-21): a task whose calls cost centimes, the Tasks row and the
// drawer while it runs, then the person's Cancel during the run (no "This task changed").
const fs = require("node:fs");
const path = require("node:path");
const REPO = process.argv[2];
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const NAME = "fixup-w15-run";
const enc = encodeURIComponent;
const result = { rows: [] };

(async () => {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", { name: "Guide", goal: "A guide" });
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the guide for the club",
    outcome: "guide.md explains the club",
    acceptanceCriteria: ["guide.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 1,
  });
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Start session" }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(1000);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(1500);
    await page.waitForTimeout(500);
    const cell = page.locator("tr", { hasText: "Write the guide for the club" }).first();
    for (let i = 0; i < 12; i++) {
      const view = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`))[0];
      const text = (await cell.innerText().catch(() => "")).replace(/\s+/g, " ");
      result.rows.push({ t: i, status: view.status, actual: view.actual.usdMicro, spent: view.spent?.usdMicro, row: text });
      if (view.status !== "in_progress") break;
      if (view.actual.usdMicro > 0 && i >= 1) {
        await page.waitForTimeout(5500);
        result.rowShot = (await cell.innerText().catch(() => "")).replace(/\s+/g, " ");
        await R.step(page, "F tasks row while running");
        break;
      }
      await page.waitForTimeout(2000);
    }
    await cell.getByText("Write the guide for the club", { exact: true }).click();
    await page.waitForTimeout(1500);
    result.drawer = (await R.step(page, "F drawer while running")).split("Cancelled").pop();
    result.detail = await R.api(NAME, "GET", `/tasks/${enc(task.id)}`);
    result.versionBefore = result.detail.task.version;
    await page.waitForTimeout(13000);
    const d2 = await R.api(NAME, "GET", `/tasks/${enc(task.id)}`);
    result.versionAfterCalls = d2.task.version;
    result.spentAfterCalls = d2.task.spent;
    const drawer = page.getByTestId("task-drawer");
    const btns = await drawer.getByRole("button").allInnerTexts();
    result.drawerButtons = btns;
    result.statusBeforeStop = (await R.api(NAME, "GET", `/tasks/${enc(task.id)}`)).task.status;
    await drawer.getByRole("button", { name: "Stop", exact: true }).first().click();
    await page.waitForTimeout(800);
    result.stopDialog = (await R.step(page, "F stop dialog while running")).slice(-800);
    const dl = page.getByRole("dialog").last();
    result.stopDialogButtons = await dl.getByRole("button").allInnerTexts();
    const go = result.stopDialogButtons.map((x) => x.trim()).find((x) => /^Stop/.test(x));
    await dl.getByRole("button", { name: go, exact: true }).click();
    await page.waitForTimeout(2500);
    result.afterCancel = (await R.step(page, "F after stop")).slice(-1500);
    result.conflictShown = /This task changed/.test(result.afterCancel);
    result.final = (await R.api(NAME, "GET", `/tasks/${enc(task.id)}`)).task;
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(path.dirname(b.home), "steps", "F-result.json"), JSON.stringify(result, null, 2));
  console.log("[F] done");
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(path.join(path.dirname(R.bench(NAME).home), "steps", "F-result.json"), JSON.stringify(result, null, 2));
  process.exit(1);
});
