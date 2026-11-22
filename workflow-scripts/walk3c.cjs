// Review walk 3c (L4-chat-204): Yes on the restored Kite club card in the Inbox.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk3c.json";
(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N);
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  try {
    const kite = JSON.parse(
      fs.readFileSync("/tmp/frbench/review-l4-chat-depth/walk3a.json", "utf8"),
    ).kite;
    await page.goto(`${UI}/inbox`);
    await page.waitForTimeout(3000);
    const yes = page.getByRole("button", { name: "Yes", exact: true });
    out.yesCount = await yes.count();
    if (out.yesCount) {
      await yes.first().click();
      await page.waitForTimeout(3000);
    }
    await shot("w3-05-inbox-after-yes");
    out.tasksAfter = (await R.api(N, "GET", `/projects/${kite}/tasks`)).map((t) => ({
      title: t.title,
      dependsOn: t.dependsOn,
    }));
    await page.goto(`${UI}/projects/${kite}/chat`);
    await page.waitForTimeout(3000);
    await shot("w3-06-kite-chat-after-yes");
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
