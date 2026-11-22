// Fix-up walk 2 (W15-42): the person answers their own task's card; the task is done and its
// Critic column shows "—", not "Not reviewed".
const R = require("/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-11/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "fixup-w15-review";
const STEPS = "/tmp/frbench/fixup-w15-review/steps";
const enc = encodeURIComponent;
const out = {};
(async () => {
  const b = R.bench(NAME);
  const w1 = JSON.parse(fs.readFileSync(`${STEPS}/walk1.json`, "utf8"));
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    const card = page
      .locator("li, article, section")
      .filter({ hasText: '"Send the club logo" needs your answers' })
      .filter({ has: page.getByRole("button", { name: "Send answers" }) })
      .last();
    const box = card.locator("textarea, input[type=text]").first();
    await box.fill("The logo is the green oak leaf; I put logo.png in the project folder.");
    await R.step(page, "w2 inbox person card typed");
    await card.getByRole("button", { name: "Send answers" }).click();
    await page.waitForTimeout(3000);
    out.inboxAfter = await R.step(page, "w2 inbox after answer");
    out.logo = await R.api(NAME, "GET", `/tasks/${enc(w1.tasks.logo)}`);
    await page.goto(`${b.uiUrl}/projects/${enc(w1.projectId)}/tasks`);
    await page.waitForTimeout(2500);
    out.tasksAfter = await R.step(page, "w2 tasks after person answered");
    out.critic = await page.locator('[data-testid="task-critic"]').allInnerTexts();
  } finally {
    fs.writeFileSync(`${STEPS}/walk2.json`, JSON.stringify(out, null, 1));
    await browser.close();
  }
  console.log(JSON.stringify({ status: out.logo?.task?.status ?? out.logo?.status, critic: out.critic }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
