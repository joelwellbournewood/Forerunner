// Bakery phase A: New project from a brief that needs the owner's content; the plan card;
// Approve and start. Records the plan's tasks and what the session does first.
"use strict";
const fs = require("node:fs");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("bakeryA-log.txt");
const NAME = "Bakery Bern";
const BRIEF =
  "A one-page website for a small bakery in Bern; I will give you the real menu, hours and address";

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    const pid = await L.newProject(page, { name: NAME, brief: BRIEF });
    fs.writeFileSync(`${L.STEPS}/bakery-pid.txt`, pid);
    log("project", pid);
    await R.step(page, "bakery-01-created");
    await R.until(
      async () => {
        const s = await R.api(N, "GET", `/projects/${pid}/intake`);
        if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
        return s.state === "pending" ? s : null;
      },
      600000,
      2000,
      "the plan",
    );
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const card = page.getByTestId("request").filter({ hasText: `Plan for "${NAME}"` });
    const cardText = await card.innerText();
    await R.step(page, "bakery-02-plan-card");
    log("plan card:", cardText.replace(/\n/g, " | "));
    await card.getByRole("button", { name: "Approve and start", exact: true }).click();
    await sleep(3000);
    await R.step(page, "bakery-03-approved");
    const tasks = await L.tasksOf(pid);
    for (const t of tasks)
      log("task:", t.id, t.title, "|", t.specialist, "|", t.status, "| deps", JSON.stringify(t.dependsOn ?? t.depends_on ?? null), "| criteria", JSON.stringify(t.acceptanceCriteria ?? null));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "bakery-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
