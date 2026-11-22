const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-10/scripts/bench/recorder.cjs");
(async () => {
  const { browser, page } = await R.openApp("fixup-polish-screens");
  await R.skipSetup(page);
  await page.getByTestId("active-project").waitFor();
  console.log("active:", await page.getByTestId("active-project").innerText());
  await page.keyboard.press("Control+k");
  await page.getByTestId("command-input").fill("switch Quote page");
  await page.waitForTimeout(300);
  console.log("items:", await page.getByTestId("command-item").allInnerTexts());
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
