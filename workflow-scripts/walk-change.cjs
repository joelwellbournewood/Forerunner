// Walk: New project from a brief, Change the plan with words, read the new plan card;
// then the Reviews tab of the project the intake journey approved.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-4/scripts/bench/recorder.cjs");
const NAME = process.argv[2] || "fix-bench";
const WORDS = process.argv[3] || "drop the check and add a README task";
const REVIEWED = process.argv[4] || "";
(async () => {
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  const out = {};
  if (REVIEWED) {
    await page.goto(`${R.bench(NAME).uiUrl}/projects/${REVIEWED}/reviews`);
    await page.waitForTimeout(2000);
    out.reviews = await R.step(page, "reviews tab");
  }
  await page.goto(R.bench(NAME).uiUrl);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByLabel("Name").fill(`Todo app ${new Date().toISOString().slice(11, 19)}`);
  await page.getByLabel(/^Brief/).fill("A todo list");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15000 });
  const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
  out.projectId = projectId;
  const first = await R.until(
    async () => {
      const s = await R.api(NAME, "GET", `/projects/${projectId}/intake`);
      return s.state === "pending" ? s : null;
    },
    120000,
    1000,
    "first plan",
  );
  out.firstRequest = first.requestId;
  await page.goto(`${R.bench(NAME).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  out.first = await R.step(page, "first plan card");
  await page.getByRole("button", { name: "Change the plan", exact: true }).first().click();
  await page.getByTestId("choice-text").fill(WORDS);
  await R.step(page, "change the plan words");
  await page.getByTestId("choice-send").click();
  await page.waitForTimeout(1500);
  await R.until(
    async () => {
      const s = await R.api(NAME, "GET", `/projects/${projectId}/intake`);
      return s.state === "pending" && s.requestId && s.requestId !== first.requestId ? s : null;
    },
    120000,
    1000,
    "second plan",
  );
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForTimeout(2000);
  out.second = await R.step(page, "second plan card");
  require("node:fs").writeFileSync(
    `${R.bench(NAME).steps}/walk-change.json`,
    JSON.stringify(out, null, 2),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
