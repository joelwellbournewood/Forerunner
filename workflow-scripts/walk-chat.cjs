"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_32611db3-691-8/scripts/bench/recorder.cjs");
const NAME = "review-bench";
(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Todo list");
    await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(p.id)}/chat`);
    await page.waitForTimeout(2000);
    await page.getByTestId("chat-input").fill("what is going on?");
    await page.getByTestId("chat-send").click();
    await R.until(async () => (await page.getByTestId("chat-agent").count()) > 0, 60_000);
    await page.waitForTimeout(1500);
    const t = await R.step(page, "c01 chat reply");
    const replies = await page.getByTestId("chat-agent").allInnerTexts();
    console.log(JSON.stringify(replies));
    console.log("(s) in page:", /\(s\)/.test(t));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
