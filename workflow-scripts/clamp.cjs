// Walk C (V4b + fixup blocking 1): a project whose test always fails; a coder task adds clamp.
// Expected: not Done; every critic request for it carries the failing test output; the drawer's
// 'See what was checked' shows 'test: failed'; if the specialist says the test failed before its
// change, the Inbox has one question card.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("clamp-log.txt");
const TITLE = "Add clamp(x, lo, hi) in src/clamp.js";

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession(2400000);
    const pid = await L.newProject(page, { name: "Clamp lib", goal: "A tiny maths library for our scripts" });
    fs.writeFileSync(`${L.STEPS}/clamp-pid.txt`, pid);
    log("project", pid);
    // The person's folder already has a package.json whose test fails (planted, as walk C).
    const ws = R.workspaceOf(N, pid);
    await R.until(() => fs.existsSync(ws), 30000, 500, "the project folder");
    fs.writeFileSync(
      path.join(ws, "package.json"),
      `${JSON.stringify({ name: "clamp-lib", private: true, scripts: { test: "node -e \"console.log('not ok 1 - clamp keeps 5 inside 0..3'); process.exit(1)\"" } }, null, 2)}\n`,
    );
    log("planted package.json with a test that always fails");
    await L.newTask(page, pid, {
      title: TITLE,
      outcome: "src/clamp.js exports clamp(x, lo, hi): x limited to the range lo..hi",
      criteria: "clamp(5, 0, 3) is 3\nclamp(-1, 0, 3) is 0\nclamp(2, 0, 3) is 2",
      who: "coder",
      budget: "0.12",
    });
    await R.step(page, "clamp-01-new-task");
    await L.submitTask(page);
    await L.openStart(page, pid);
    await L.confirmStart(page);
    await sleep(5000);
    await L.watchdog(page, Number(process.env.SPEND_LIMIT || 1.2), log);
    await sleep(3000);
    const [t] = await L.tasksOf(pid);
    log("task at end:", t.status, JSON.stringify(t.display), "attempt", t.attempt, JSON.stringify(t.check ?? null));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "clamp-02-tasks-after");
    log("row:", (await L.rowOf(page, TITLE).innerText()).replace(/\n/g, " | "));
    await L.openDrawer(page, pid, TITLE);
    await L.seeWhatWasChecked(page);
    const d = await R.step(page, "clamp-03-drawer");
    const ri = d.indexOf("Runs");
    log("drawer:", d.slice(ri, ri + 4000).replace(/\n/g, " | "));
    await page.keyboard.press("Escape");
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, "clamp-04-inbox");
    const cards = page.getByTestId("request").filter({ hasText: "clamp" });
    log("cards for clamp:", await cards.count());
    for (const c of await cards.allInnerTexts()) log("card:", c.replace(/\n/g, " | ").slice(0, 1200));
    const crit = L.callLines((c) => c.role === "critic" && c.task === t.id);
    const firsts = crit.filter((c) => (c.messages ?? []).length === 1);
    log("critic first calls:", firsts.map((c) => c.n).join(","), "carry 'not ok 1':", firsts.map((c) => /not ok 1 - clamp keeps 5/.test(JSON.stringify(c.messages))).join(","), "say changed no file:", firsts.map((c) => /changed no file/.test(JSON.stringify(c.messages))).join(","));
    const spec = L.callLines((c) => c.role === "specialist" && c.task === t.id && (c.messages ?? []).length === 1);
    log("specialist briefs:", spec.map((c) => c.n).join(","), "carry '-> Fix: ':", spec.map((c) => JSON.stringify(c.messages).includes("-> Fix: ")).join(","));
    log("src/clamp.js:", fs.existsSync(path.join(ws, "src", "clamp.js")) ? fs.readFileSync(path.join(ws, "src", "clamp.js"), "utf8").slice(0, 400) : "missing");
    log("package.json now:", fs.readFileSync(path.join(ws, "package.json"), "utf8").replace(/\n/g, " "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "clamp-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
