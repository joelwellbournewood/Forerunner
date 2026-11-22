const R = require("/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-5/scripts/bench/recorder.cjs");
const N = "review-d1109-selftasks-run";
const pname = process.argv[2];
(async () => {
  const ps = await R.api(N, "GET", "/projects");
  const p = ps.find((x) => x.name === pname);
  await R.until(async () => {
    const ts = await R.api(N, "GET", `/projects/${p.id}/tasks`);
    return ts.every((t) => !["in_progress", "in_review"].includes(t.status)) ? ts : null;
  }, 300000, 2000, "idle");
  const before = await R.api(N, "GET", `/projects/${p.id}/tasks`);
  const sb = (await R.api(N, "GET", `/projects/${p.id}/sessions`)).rows.length;
  const { browser, page } = await R.openApp(N);
  await page.goto(`${R.bench(N).uiUrl}/inbox`);
  await page.waitForTimeout(1500);
  const cardEl = page
    .locator("article, section, li, div")
    .filter({ hasText: `${pname}: the agent suggests` })
    .filter({ has: page.getByRole("button", { name: "Keep the tasks" }) })
    .last();
  await R.step(page, `keep-${pname}-card`);
  await cardEl.getByRole("button", { name: "Keep the tasks" }).first().click();
  await page.waitForTimeout(3000);
  const t = await R.step(page, `keep-${pname}-done`);
  console.log("Done lines:", t.split("\n").filter((l) => /^Done:/.test(l)));
  await page.waitForTimeout(12000);
  const after = await R.api(N, "GET", `/projects/${p.id}/tasks`);
  const sa = (await R.api(N, "GET", `/projects/${p.id}/sessions`)).rows;
  console.log("sessions before", sb, "after", sa.length, sa.map((r) => r.working));
  console.log(
    "tasks unchanged:",
    JSON.stringify(before.map((x) => [x.title, x.status])) === JSON.stringify(after.map((x) => [x.title, x.status])),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
