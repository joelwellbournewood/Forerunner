// Reviewer's month-cap walk, part 2: the project header's Continue (no session budget typed).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_876fbc4e-bfe-5/scripts/bench/recorder.cjs");

const NAME = process.argv[2];
const LABEL = process.argv[3] || "c";
const enc = encodeURIComponent;
const out = (s) => console.log(`[walk ${LABEL}] ${s}`);

async function main() {
  const b = R.bench(NAME);
  const res = { label: LABEL };
  const projects = await R.api(NAME, "GET", "/projects");
  const project = projects.find((p) => /Review month cap \(n\)/.test(p.name));
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} before continue`);
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await page.waitForTimeout(3000);
    res.afterContinue = await R.step(page, `${LABEL} after continue`);
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
