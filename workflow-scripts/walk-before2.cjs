const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-1/scripts/bench/recorder.cjs");
const n = "fix-d1109-starts-engine";
const label = process.argv[2] ?? "before";
(async () => {
  const projects = await R.api(n, "GET", "/projects");
  const p = (projects.projects ?? projects).find((x) => x.name === `Quote page ${label}`);
  const pid = p.id;
  const { browser, page } = await R.openApp(n);
  await page.waitForTimeout(3000);
  await R.skipSetup(page).catch(() => undefined);
  await R.step(page, `${label}-home`);
  await page.getByText("Answer", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await R.step(page, `${label}-inbox-card`);
  const s0 = await R.api(n, "GET", "/sessions");
  const before = (s0.sessions ?? s0).filter((x) => x.projectId === pid).length;
  for (const box of await page.locator("main textarea, main input[type=text]").all()) await box.fill("Use the short quote.").catch(() => undefined);
  await page.getByRole("button", { name: "Send answers" }).first().click();
  await page.waitForTimeout(5000);
  await R.step(page, `${label}-inbox-after-answer`);
  const s1 = await R.api(n, "GET", "/sessions");
  const list = (s1.sessions ?? s1).filter((x) => x.projectId === pid);
  console.log(JSON.stringify({ before, after: list.length, statuses: list.map((x) => [x.status, x.trigger]) }));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
