// Review walk 4 (l4-chat-depth): after the restart, Garden club's chat and the Talk panel keep
// the older ask lines in the past; a new ask still has Go ahead.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk4.json";
(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N);
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  const idle = async (wait = 40_000) => {
    const until = Date.now() + wait;
    while (Date.now() < until) {
      if (!(await page.getByRole("button", { name: "Stop", exact: true }).count())) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1200);
  };
  try {
    const garden = JSON.parse(
      fs.readFileSync("/tmp/frbench/review-l4-chat-depth/walk1.json", "utf8"),
    ).projectId;
    await page.goto(`${UI}/projects/${garden}/chat`);
    await page.waitForTimeout(3000);
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill("compare the two ways to style the page");
    await box.press("Enter");
    await page.waitForTimeout(900);
    await idle();
    await shot("w4-01-garden-new-ask-after-restart");
    out.goAhead = await page.getByRole("button", { name: "Go ahead", exact: true }).count();
    // The Talk panel shows the same conversation.
    await page.goto(`${UI}/projects/${garden}/summary`);
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Talk", exact: true }).first().click();
    await page.waitForTimeout(2500);
    await shot("w4-02-talk-panel");
    out.talkGoAhead = await page.getByRole("button", { name: "Go ahead", exact: true }).count();
    out.offeredLines = await page.getByText(/^Offered: /).allTextContents();
    out.questionLines = await page.getByText(/Go ahead\?$/).allTextContents();
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
