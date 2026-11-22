// Review walk 2b: set the time zone in Settings > Advanced as a person, then ask the chat.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-4/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = "review-d1109-chat-guard";
const OUT = "/tmp/frbench/review-d1109-chat-guard/walk2b-result.json";
const out = {};
(async () => {
  const projectId = JSON.parse(
    fs.readFileSync("/tmp/frbench/review-d1109-chat-guard/walk2-result.json", "utf8"),
  ).projectId;
  const { browser, page } = await R.openApp(N);
  await page.goto(`${R.bench(N).uiUrl}/settings`);
  await page.waitForTimeout(1500);
  const adv = page.getByText(/^Advanced/).first();
  if (await adv.count()) await adv.click();
  await page.waitForTimeout(1000);
  const text = await page.evaluate(() => document.body.innerText);
  const i = text.indexOf("Time zone");
  out.around = i >= 0 ? text.slice(i - 100, i + 300) : null;
  // The row: "Time zone" ... "Change".
  const row = page.locator("div,li,section,tr").filter({ hasText: /^Time zone/ }).last();
  out.rows = await row.count();
  const change = row.getByRole("button", { name: "Change" }).first();
  out.change = await change.count();
  if (out.change) {
    await change.click();
    await page.waitForTimeout(800);
    await R.step(page, "settings-zone-edit");
    const input = row.locator("input,select").first();
    const tag = await input.evaluate((el) => el.tagName).catch(() => null);
    out.tag = tag;
    if (tag === "SELECT") await input.selectOption("Europe/Zurich");
    else if (tag) await input.fill("Europe/Zurich");
    const save = row.getByRole("button", { name: /^Save/ }).first();
    if (await save.count()) await save.click();
    await page.waitForTimeout(1500);
    await R.step(page, "settings-zone-saved");
  }
  out.zoneNow = (await R.api(N, "GET", "/me")).human?.timezone ?? JSON.stringify(await R.api(N, "GET", "/me")).slice(0, 400);
  // Ask the chat.
  await page.goto(`${R.bench(N).uiUrl}/projects/${projectId}/chat`);
  await page.waitForTimeout(1500);
  const c0 = R.modelCalls(N, "chat").length;
  const input = page.locator('[data-testid="chat-input"]').first();
  await input.fill("what did we do yesterday?");
  await input.press("Enter");
  await R.until(async () => R.modelCalls(N, "chat").length > c0, 60000, 300, "chat call");
  await page.waitForTimeout(1500);
  await R.step(page, "chat-yesterday");
  const m = R.modelCalls(N, "chat")[c0]?.messages?.at(-1)?.content;
  const t = typeof m === "string" ? m : JSON.stringify(m);
  out.now = t.slice(t.indexOf("# Now"), t.indexOf("# Now") + 140);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  out.error = String(e?.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(e);
  process.exit(1);
});
