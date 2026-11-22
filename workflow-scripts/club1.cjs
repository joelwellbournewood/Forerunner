// Club project (no brief): three page tasks through New task; C2 Start dialog sentences.
"use strict";
const fs = require("node:fs");
const L = require("./lc.cjs");
const { R, N, sleep } = L;
const log = L.logTo("club1-log.txt");

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    const pid = await L.newProject(page, { name: "Garden club", goal: "A small website for the Bern garden club" });
    log("project", pid);
    fs.writeFileSync(`${L.STEPS}/club-pid.txt`, pid);
    await R.step(page, "club-01-created");
    await L.newTask(page, pid, {
      title: "Home page in index.html",
      outcome:
        "index.html: the garden club's home page (who we are, when we meet: Saturdays 10:00 at the Rosengarten) with a stylesheet styles.css",
      criteria: "index.html opens in a browser and shows the club's name and meeting time\nstyles.css is linked from index.html",
      who: "coder",
      priority: "high",
    });
    await L.submitTask(page);
    await L.newTask(page, pid, {
      title: "About page in about.html",
      outcome: "about.html tells the club's story in two short paragraphs, and index.html links to it",
      criteria: "about.html exists and links back to index.html\nindex.html has a link to about.html",
      who: "coder",
      priority: "medium",
      budget: "0.80",
    });
    await L.submitTask(page);
    await L.newTask(page, pid, {
      title: "Contact page in contact.html",
      outcome: "contact.html says how to reach the club (an email address and the meeting place), and index.html links to it",
      criteria: "contact.html exists and links back to index.html\nindex.html has a link to contact.html",
      who: "coder",
      priority: "low",
      budget: "0.01",
    });
    const dlgText = await R.step(page, "club-02-contact-dialog-filled");
    await L.submitTask(page);
    await page.reload();
    await sleep(2000);
    await R.step(page, "club-03-tasks-ready");
    const tasks = await L.tasksOf(pid);
    for (const t of tasks) log("task", t.title, t.status, "tier", t.riskTier, "budget", JSON.stringify(t.budget ?? t.budgetUsdMicro ?? null), "est", JSON.stringify(t.estimate ?? null));
    // C2: the Start dialog with the default budget, then budgets so not all fit.
    for (const b of [undefined, "0.60", "0.40", "0.25"]) {
      const dlg = await L.openStart(page, pid, b);
      const text = await dlg.innerText();
      await R.step(page, `club-04-start-dialog-${b ?? "default"}`);
      log(`start dialog (budget ${b ?? "default"}):`, text.replace(/\n/g, " | ").slice(0, 1500));
      const check = await R.api(N, "GET", `/projects/${pid}/start-check?budgetUsdMicro=${Math.round((Number(b ?? 0) / 0.8) * 1e6)}`).catch((e) => ({ err: e.message }));
      log("start-check (evidence):", JSON.stringify(check).slice(0, 1500));
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await sleep(800);
    }
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "club-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
