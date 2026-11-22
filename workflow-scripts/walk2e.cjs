// Review walk 2e: the time zone saved as the setup assistant's Welcome step saves it
// (POST /setup/profile, what the UI sends), then the chat's '# Now' facts.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-4/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = "review-d1109-chat-guard";
const OUT = "/tmp/frbench/review-d1109-chat-guard/walk2e-result.json";
const out = {};
(async () => {
  const projectId = JSON.parse(
    fs.readFileSync("/tmp/frbench/review-d1109-chat-guard/walk2-result.json", "utf8"),
  ).projectId;
  const me = await R.api(N, "GET", "/me");
  await R.api(N, "POST", "/setup/profile", { name: me.name, timezone: "Europe/Zurich" });
  out.zoneNow = (await R.api(N, "GET", "/me")).timezone;
  const { browser, page } = await R.openApp(N);
  await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/chat`);
  await page.waitForTimeout(1500);
  const c0 = R.modelCalls(N, "chat").length;
  const input = page.locator('[data-testid="chat-input"]').first();
  await input.fill("what day is it today?");
  await input.press("Enter");
  await R.until(async () => R.modelCalls(N, "chat").length > c0, 60000, 300, "chat call");
  await page.waitForTimeout(1500);
  await R.step(page, "chat-what-day-zurich");
  const calls = R.modelCalls(N, "chat");
  const m = calls[c0]?.messages?.at(-1)?.content;
  const t = typeof m === "string" ? m : JSON.stringify(m);
  out.now = t.slice(t.indexOf("# Now"), t.indexOf("# Now") + 140);
  // The cached part: the system text of this call and the one before.
  out.systemSame = calls[c0 - 1] ? JSON.stringify(calls[c0 - 1].system) === JSON.stringify(calls[c0].system) : null;
  out.toolsSame = calls[c0 - 1] ? JSON.stringify(calls[c0 - 1].tools) === JSON.stringify(calls[c0].tools) : null;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  out.error = String(e?.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(e);
  process.exit(1);
});
