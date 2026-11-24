// Review walk: the Inbox's Updates list shows a warning Update's tone as a named dot.
const [name, label, repo] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
(async () => {
  const out = { label };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/inbox`);
    await page.waitForTimeout(3000);
    const text = await R.step(page, `${label}-1-inbox-updates`);
    out.hasWarningWord = /\bwarning\b/i.test(text);
    const dots = page.locator('[data-testid="message-tone"]');
    out.dots = await dots.count();
    if (out.dots) {
      out.dotLabel = await dots.first().getAttribute("aria-label");
      out.dotTitle = await dots.first().getAttribute("title");
      const msg = page.locator('[data-testid="message"]', { has: dots.first() });
      out.messageText = await msg.first().innerText();
      await msg.first().screenshot({ path: `/tmp/frbench/${name}/steps/${label}-2-warning-update.png` });
    }
  } finally {
    fs.writeFileSync(`/tmp/frbench/${name}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
