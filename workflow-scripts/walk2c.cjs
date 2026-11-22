// Review walk 2c: open Settings > Advanced (a summary), change Time zone, then ask the chat.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-4/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = "review-d1109-chat-guard";
const OUT = "/tmp/frbench/review-d1109-chat-guard/walk2c-result.json";
const out = {};
(async () => {
  const projectId = JSON.parse(
    fs.readFileSync("/tmp/frbench/review-d1109-chat-guard/walk2-result.json", "utf8"),
  ).projectId;
  const { browser, page } = await R.openApp(N);
  await page.goto(`${R.bench(N).uiUrl}/settings`);
  await page.waitForTimeout(1500);
  await page.locator("summary").filter({ hasText: /^Advanced/ }).first().click();
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  const i = text.indexOf("Time zone");
  out.around = i >= 0 ? text.slice(i - 50, i + 250) : null;
  // Find the element holding exactly the label "Time zone" and its nearest Change button.
  const label = page.getByText("Time zone", { exact: true }).first();
  out.label = await label.count();
  if (out.label) {
    const box = label.locator("xpath=ancestor::*[.//button][1]");
    const change = box.getByRole("button", { name: "Change" }).first();
    out.change = await change.count();
    if (out.change) {
      await change.click();
      await page.waitForTimeout(800);
      const field = box.locator("input,select").first();
      const tag = await field.evaluate((el) => el.tagName).catch(() => null);
      out.tag = tag;
      if (tag === "SELECT") await field.selectOption("Europe/Zurich");
      else if (tag) await field.fill("Europe/Zurich");
      await R.step(page, "settings-zone-edit");
      const save = box.getByRole("button", { name: /^(Save|Set|Change it)/ }).first();
      out.save = await save.count();
      if (out.save) await save.click();
      await page.waitForTimeout(2000);
      out.afterSave = await R.step(page, "settings-zone-saved");
      // A read-back to confirm, if the row asks.
      const yes = page.getByRole("button", { name: /^(Yes|Confirm)/ }).first();
      if (await yes.count()) {
        await yes.click();
        await page.waitForTimeout(1500);
      }
    }
  }
  out.zoneNow = (await R.api(N, "GET", "/me")).timezone;
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
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  await browser.close();
})().catch((e) => {
  out.error = String(e?.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(e);
  process.exit(1);
});
