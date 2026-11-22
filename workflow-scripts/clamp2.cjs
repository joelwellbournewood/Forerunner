// Walk C, second try: the person's project already has a failing test of another module
// (src/round.js rounds down). A coder task adds clamp. Expected (fixup blocking 1): not Done;
// every critic request carries the failing test output; if the specialist says the test failed
// before its change, the Inbox has one question card.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lc.cjs");
const { R, N, sleep, ui } = L;
const log = L.logTo("clamp2-log.txt");
const TITLE = "Add clamp(x, lo, hi) in src/clamp.js";

(async () => {
  const { browser, page } = await R.openApp(N);
  page.setDefaultTimeout(20000);
  try {
    await L.noRunningSession();
    const pid = await L.newProject(page, { name: "Money lib", goal: "Small number helpers for the club's accounts" });
    fs.writeFileSync(`${L.STEPS}/clamp2-pid.txt`, pid);
    const ws = R.workspaceOf(N, pid);
    await R.until(() => fs.existsSync(ws), 30000, 500, "the project folder");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.mkdirSync(path.join(ws, "test"), { recursive: true });
    fs.writeFileSync(path.join(ws, "package.json"), `${JSON.stringify({ name: "money-lib", private: true, scripts: { test: "node --test" } }, null, 2)}\n`);
    fs.writeFileSync(path.join(ws, "src", "round.js"), "'use strict';\n// Rounds an amount to cents.\nexports.round2 = (x) => Math.floor(x * 100) / 100;\n");
    fs.writeFileSync(
      path.join(ws, "test", "round.test.js"),
      "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { round2 } = require('../src/round.js');\n\ntest('round2 rounds 1.006 to 1.01', () => {\n  assert.strictEqual(round2(1.006), 1.01);\n});\n",
    );
    log("planted: package.json test=node --test, src/round.js (rounds down), test/round.test.js (fails)");
    await L.newTask(page, pid, {
      title: TITLE,
      outcome: "src/clamp.js exports clamp(x, lo, hi): x limited to the range lo..hi",
      criteria: "clamp(5, 0, 3) is 3\nclamp(-1, 0, 3) is 0\nclamp(2, 0, 3) is 2",
      who: "coder",
      budget: "0.08",
    });
    await L.submitTask(page);
    await L.openStart(page, pid);
    await L.confirmStart(page);
    await sleep(5000);
    await L.watchdog(page, Number(process.env.SPEND_LIMIT || 1.56), log);
    await sleep(3000);
    const [t] = await L.tasksOf(pid);
    log("task at end:", t.status, JSON.stringify(t.display), "attempt", t.attempt, JSON.stringify(t.check ?? null));
    await page.goto(`${ui()}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, "clamp2-01-tasks-after");
    log("row:", (await L.rowOf(page, TITLE).innerText()).replace(/\n/g, " | "));
    await L.openDrawer(page, pid, TITLE);
    await L.seeWhatWasChecked(page);
    const d = await R.step(page, "clamp2-02-drawer");
    const ri = d.indexOf("Runs");
    log("drawer:", d.slice(ri, ri + 3500).replace(/\n/g, " | "));
    await page.keyboard.press("Escape");
    await page.goto(`${ui()}/inbox`);
    await sleep(2500);
    await R.step(page, "clamp2-03-inbox");
    const cards = page.getByTestId("request").filter({ hasText: TITLE });
    log("cards for the task:", await cards.count());
    for (const c of await cards.allInnerTexts()) log("card:", c.replace(/\n/g, " | ").slice(0, 1200));
    const crit = L.callLines((c) => c.role === "critic" && (c.label ?? "").includes(t.id) && (c.messages ?? []).length === 1);
    log("critic first calls:", crit.map((c) => c.n).join(","), "| carry 'not ok':", crit.map((c) => /not ok 1 - round2 rounds 1\.006/.test(JSON.stringify(c.messages))).join(","), "| 'changed no file':", crit.map((c) => /changed no file/.test(JSON.stringify(c.messages))).join(","));
    log("round.js now:", fs.readFileSync(path.join(ws, "src", "round.js"), "utf8").replace(/\n/g, " "));
    log("round.test.js now:", fs.readFileSync(path.join(ws, "test", "round.test.js"), "utf8").replace(/\n/g, " ").slice(0, 300));
    log("package.json now:", fs.readFileSync(path.join(ws, "package.json"), "utf8").replace(/\n/g, " "));
  } catch (e) {
    log("ERROR", e.stack);
    await R.step(page, "clamp2-error").catch(() => {});
  } finally {
    await browser.close();
  }
})();
