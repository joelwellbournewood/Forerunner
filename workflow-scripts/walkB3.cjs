// Review walk B3: after the split, the person makes "Publish the page" wait for one more task; the
// split's Undo on Changes is refused in words; the wait's own Undo first, then the split's Undo.
// Usage: node walkB3.cjs <repo> <bench> <label> <projectId>
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label, pid] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label, texts: {}, checks: {} };
(async () => {
  const tasks = await R.api(n, "GET", `/projects/${pid}/tasks`);
  const publish = tasks.find((t) => t.title === "Publish the page");
  const logo = tasks.find((t) => t.title === "Send the logo");
  const check = await R.api(n, "POST", `/projects/${pid}/tasks`, {
    title: "Check that the links work",
    outcome: "Every link opens",
    acceptanceCriteria: ["no link is broken"],
    riskTier: 1,
    specialist: "coder",
    dependsOn: [logo.id],
  });
  const set = await R.apiRaw(n, "POST", `/tasks/${publish.id}/dependencies`, {
    version: publish.version,
    dependsOn: [...publish.dependsOn, check.id],
  });
  out.checks.dependencies = set.status;
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/changes`);
    await sleep(3000);
    out.texts.changesRefused = await R.step(page, `${label}-changes-refused`);
    // The wait's own row: its Undo first.
    const rows = page.locator("li, article, [data-testid='change-row']");
    const waitRow = page.getByText(/wait for "Check that the links work"|waits for "Check that the links work"|now waits for/).first();
    out.checks.waitRowText = await waitRow.textContent().catch(() => null);
    const waitItem = waitRow.locator("xpath=ancestor::*[.//button[normalize-space()='Undo']][1]");
    await waitItem.getByRole("button", { name: "Undo" }).first().click();
    await sleep(2500);
    out.texts.afterWaitUndo = await R.step(page, `${label}-after-wait-undo`);
    const splitRow = page.getByText(/^Split "Style the page" into/).first();
    const splitItem = splitRow.locator("xpath=ancestor::*[.//button[normalize-space()='Undo']][1]");
    out.checks.splitUndoOffered = (await splitItem.getByRole("button", { name: "Undo" }).count()) > 0;
    if (out.checks.splitUndoOffered) {
      await splitItem.getByRole("button", { name: "Undo" }).first().click();
      await sleep(2500);
      out.texts.afterSplitUndo = await R.step(page, `${label}-after-split-undo`);
    }
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    await sleep(2500);
    out.texts.tasksAfter = await R.step(page, `${label}-tasks-after`);
    void rows;
  } finally {
    await browser.close();
  }
  out.tasksAfter = (await R.api(n, "GET", `/projects/${pid}/tasks`)).map((t) => [t.title, t.status, t.dependsOn.length]);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ checks: out.checks, tasksAfter: out.tasksAfter }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
