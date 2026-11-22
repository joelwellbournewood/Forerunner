const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-9/scripts/bench/recorder.cjs");
const N = "fixup-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  await page.goto(`${ui}/settings`);
  await page.waitForTimeout(1500);
  const row = page.getByTestId("setting-row").filter({ hasText: /Quiet hours/i }).first();
  await row.getByTestId("setting-change").click();
  const dialog = page.getByTestId("setting-dialog");
  await dialog.waitFor({ timeout: 10000 });
  out.dialogText = await dialog.innerText();
  await dialog.locator('input[type="checkbox"]').first().check();
  const t = dialog.locator('input[type="time"]');
  await t.nth(0).fill("12:00");
  await t.nth(1).fill("18:00");
  await dialog.getByTestId("setting-apply").click();
  await page.waitForTimeout(2000);
  out.result = await dialog.innerText().catch(() => null);
  await R.step(page, "fx-b-quiet-result");
  const yes = dialog.getByRole("button", { name: /^(Yes|Apply|Confirm)/ });
  if (await yes.count()) {
    await yes.first().click();
    await page.waitForTimeout(1500);
    out.afterYes = await dialog.innerText().catch(() => null);
  }
  const close = dialog.getByTestId("command-close");
  if (await close.count()) await close.click();
  await page.goto(`${ui}/changes`);
  await page.waitForTimeout(2500);
  await R.step(page, "fx-b-changes");
  const r = page.getByTestId("change").first();
  out.first = {
    text: await r.innerText(),
    words: await r.getByTestId("change-words").count(),
    undo: await r.getByTestId("change-undo").count(),
    badge: await r.getByTestId("change-undo-state").innerText(),
  };
  // Undo it, then see the row
  if (out.first.undo) {
    await r.getByTestId("change-undo").click();
    await page.waitForTimeout(2000);
    out.afterUndo = (await page.getByTestId("change").allInnerTexts()).slice(0, 2);
    const rows = page.getByTestId("change");
    out.undoRowBadges = await rows.nth(0).getByTestId("change-undo-state").count();
    out.undoneRowBadge = await rows.nth(1).getByTestId("change-undo-state").innerText().catch(() => null);
    out.note = await page.getByTestId("changes-note").innerText().catch(() => null);
    await R.step(page, "fx-b-changes-after-undo");
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1); });
