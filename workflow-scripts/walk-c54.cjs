// C-54: the Overview's Last result after Mark done anyway in the Inbox.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-5/scripts/bench/recorder.cjs");
const N = "review-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const projects = await R.api(N, "GET", "/projects");
  const p = projects.find((x) => x.name === process.argv[2]);
  await page.goto(`${ui}/projects/${p.id}`);
  await page.waitForTimeout(2500);
  out.before = await R.step(page, "rv-c54-overview-before");
  await page.goto(`${ui}/inbox`);
  await page.waitForTimeout(2500);
  const card = page.getByTestId("request").filter({ hasText: process.argv[3] }).first();
  out.card = await card.innerText().catch(() => null);
  await R.step(page, "rv-c54-inbox-card");
  const btn = card.getByRole("button", { name: process.argv[4] || "Mark done anyway", exact: true });
  out.btn = await btn.count();
  if (out.btn) {
    await btn.click();
    await page.waitForTimeout(800);
    out.confirm = await page.getByRole("dialog").innerText().catch(() => null);
    const yes = page.getByTestId("choice-confirm-yes");
    if (await yes.count()) await yes.first().click();
    await page.waitForTimeout(2500);
    out.inboxAfter = await R.step(page, "rv-c54-inbox-after");
  }
  await page.goto(`${ui}/projects/${p.id}`);
  await page.waitForTimeout(2500);
  out.after = await R.step(page, "rv-c54-overview-after");
  out.since = await page.getByTestId("last-result-since").innerText().catch(() => null);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1); });
