// Review walk 2d: set the time zone in the setup assistant (the only place a person can), then
// ask the chat what day it is and read the '# Now' facts it was given.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-4/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = "review-d1109-chat-guard";
const OUT = "/tmp/frbench/review-d1109-chat-guard/walk2d-result.json";
const out = {};
(async () => {
  const projectId = JSON.parse(
    fs.readFileSync("/tmp/frbench/review-d1109-chat-guard/walk2-result.json", "utf8"),
  ).projectId;
  const { browser, page } = await R.openApp(N);
  await page.goto(`${R.bench(N).uiUrl}/settings`);
  await page.waitForTimeout(1500);
  const open = page.getByRole("button", { name: "Open the setup assistant" }).first();
  out.openSetup = await open.count();
  if (out.openSetup) await open.click();
  else {
    const link = page.getByRole("link", { name: "Open the setup assistant" }).first();
    out.openSetupLink = await link.count();
    if (out.openSetupLink) await link.click();
  }
  await page.waitForTimeout(2000);
  const tz = page.locator('[data-testid="setup-timezone"]');
  out.tzField = await tz.count();
  if (out.tzField) {
    await tz.fill("Europe/Zurich");
    await R.step(page, "setup-timezone");
    const next = page.getByRole("button", { name: /^(Next|Continue|Save)/ }).first();
    out.next = await next.count();
    if (out.next) await next.click();
    await page.waitForTimeout(2000);
    await R.step(page, "setup-after-next");
  }
  out.zoneNow = (await R.api(N, "GET", "/me")).timezone;
  await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/chat`);
  await page.waitForTimeout(1500);
  const c0 = R.modelCalls(N, "chat").length;
  const input = page.locator('[data-testid="chat-input"]').first();
  await input.fill("what day is it today?");
  await input.press("Enter");
  await R.until(async () => R.modelCalls(N, "chat").length > c0, 60000, 300, "chat call");
  await page.waitForTimeout(1500);
  await R.step(page, "chat-what-day-zurich");
  const m = R.modelCalls(N, "chat")[c0]?.messages?.at(-1)?.content;
  const t = typeof m === "string" ? m : JSON.stringify(m);
  out.now = t.slice(t.indexOf("# Now"), t.indexOf("# Now") + 140);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  await browser.close();
})().catch((e) => {
  out.error = String(e?.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(e);
  process.exit(1);
});
