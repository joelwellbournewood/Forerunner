// Reviewer's month-cap walk: Settings > Monthly spending cap just above this month's spend; a
// task with a larger budget of its own; Start; what the person reads.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");

const NAME = process.argv[2];
const LABEL = process.argv[3] || "m";
const CAP = process.argv[4] || "0.05";
const enc = encodeURIComponent;
const out = (s) => console.log(`[walk ${LABEL}] ${s}`);

async function main() {
  const b = R.bench(NAME);
  const res = { label: LABEL };
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Review month cap (${LABEL})`,
    goal: "A manual for the club",
  });
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    // The earlier walk's unanswered change card: No.
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    const oldCard = page.getByText("Lower the monthly cap to CHF 0.06?").first();
    if (await oldCard.count()) {
      const card = oldCard.locator("xpath=ancestor::*[.//button[normalize-space()='No']][1]");
      await card.getByRole("button", { name: "No", exact: true }).click();
      await page.waitForTimeout(1500);
      await R.step(page, `${LABEL} old change card answered no`);
    }
    await page.goto(`${b.uiUrl}/settings`);
    await page.waitForTimeout(2000);
    const row = page.getByTestId("setting-row").filter({ hasText: "Monthly spending cap" }).first();
    res.rowBefore = await row.innerText();
    await row.getByTestId("setting-change").click();
    await page.waitForTimeout(500);
    const input = page.getByTestId("setting-value").first();
    await input.fill(CAP);
    await R.step(page, `${LABEL} settings month cap`);
    await page.getByTestId("setting-apply").first().click();
    await page.waitForTimeout(1500);
    await R.step(page, `${LABEL} settings month cap confirm`);
    await page.getByRole("button", { name: "Yes", exact: true }).first().click();
    await page.waitForTimeout(1500);
    res.settings = await R.step(page, `${LABEL} settings month cap saved`);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2000);
    await page.getByTestId("new-task").click();
    const dlg = page.getByTestId("new-task-dialog");
    await dlg.getByTestId("task-title").fill("Write the manual");
    await dlg.getByTestId("task-outcome").fill("manual.md explains the club");
    await dlg.getByTestId("task-criteria").fill("manual.md exists");
    const who = dlg.getByTestId("task-who");
    const opts = await who.locator("option").allTextContents();
    const coder = opts.find((o) => /coder/i.test(o));
    if (coder) await who.selectOption({ label: coder });
    await dlg.getByTestId("task-budget").fill("1.00");
    await dlg.getByTestId("create-task").click();
    await page.waitForTimeout(1500);
    await page.getByTestId("start-session").first().click();
    await page.waitForTimeout(2000);
    res.startDialog = await R.step(page, `${LABEL} start dialog`);
    const confirm = page.getByTestId("confirm-start-session");
    if (await confirm.isDisabled()) {
      out("Start is disabled");
      return;
    }
    await confirm.click();
    await page.waitForTimeout(3000);
    await R.step(page, `${LABEL} after start`);
    const sessions = await R.until(
      async () => {
        const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
        return list.length && list.every((x) => !["running", "planned", "paused"].includes(x.status))
          ? list
          : null;
      },
      300_000,
      2000,
      "the session to end",
    );
    res.sessions = sessions.map((s) => ({ id: s.id, status: s.status, summary: s.summary }));
    out(JSON.stringify(res.sessions));
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    res.tasksTab = await R.step(page, `${LABEL} tasks after`);
    await page.getByText("Write the manual").first().click();
    await page.waitForTimeout(1500);
    res.drawer = await R.step(page, `${LABEL} drawer`);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    res.inbox = await R.step(page, `${LABEL} inbox`);
    const sid = res.sessions[0]?.id;
    if (sid) {
      await page.goto(`${b.uiUrl}/sessions/${enc(sid)}`);
      await page.waitForTimeout(2000);
      res.session = await R.step(page, `${LABEL} session`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(R.bench(NAME).steps, `${LABEL}-walk.json`), JSON.stringify(res, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
