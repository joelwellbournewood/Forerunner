// usage: node add-task.cjs <projectId> <json: {title,outcome,deps:[titles],budget,who,criteria}>  (several JSON args allowed)
const { R, N, log, text, goto } = require("./h.cjs");
const [P, ...specs] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    for (const raw of specs) {
      const s = JSON.parse(raw);
      await goto(page, "/projects/" + P + "/tasks");
      await page.getByRole("button", { name: "New task" }).first().click();
      await page.waitForTimeout(800);
      const d = page.getByTestId("new-task-dialog");
      await d.getByTestId("task-title").fill(s.title);
      await d.getByTestId("task-outcome").fill(s.outcome);
      if (s.criteria) await d.getByTestId("task-criteria").fill(s.criteria);
      if (s.who) await d.getByTestId("task-who").selectOption({ label: s.who }).catch(async () => d.getByTestId("task-who").selectOption(s.who));
      if (s.budget) await d.getByTestId("task-budget").fill(String(s.budget));
      for (const dep of s.deps || []) {
        const lbl = d.locator("label").filter({ hasText: dep }).filter({ has: page.getByTestId("dependency-option") }).first();
        await lbl.getByTestId("dependency-option").check();
      }
      await R.step(page, "new-task-" + s.title.slice(0, 30));
      await d.getByTestId("create-task").click();
      await page.waitForTimeout(1500);
      log("created", s.title);
    }
    const t = await R.step(page, "tasks-after-adding");
    const i = t.indexOf("Task\tStatus");
    log(t.slice(i, i + 2500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
