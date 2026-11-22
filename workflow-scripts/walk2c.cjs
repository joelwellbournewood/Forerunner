// Review walk 2 (l4-chat-depth): dependency lines, the start read-back, the history window,
// Chat asks first and Changes.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk2c.json";

(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N);
  const idle = async (wait = 40_000) => {
    const until = Date.now() + wait;
    while (Date.now() < until) {
      const busy = await page.getByRole("button", { name: "Stop", exact: true }).count();
      if (!busy) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1200);
  };
  const say = async (text) => {
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill(text);
    await box.press("Enter");
    await page.waitForTimeout(900);
    await idle();
  };
  const press = async (name) => {
    const b = page.getByRole("button", { name, exact: true });
    const n = await b.count();
    out.buttons = [...(out.buttons ?? []), { name, count: n }];
    if (!n) return false;
    await b.last().click();
    await page.waitForTimeout(900);
    await idle();
    return true;
  };
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  try {
    const kite = { id: JSON.parse(fs.readFileSync("/tmp/frbench/review-l4-chat-depth/walk2.json", "utf8")).kite };
    out.kite = kite.id;
    // L4-chat-211: Settings, Chat asks first: 0, then 0.10.
    await page.goto(`${UI}/settings`);
    await page.waitForTimeout(2500);
    const setTo = async (v) => {
      const row = page.locator('[data-testid="setting-row"][data-key="human.chat_ask_above"]');
      await row.getByTestId("setting-change").click();
      await page.waitForTimeout(800);
      const dialog = page.getByTestId("setting-dialog");
      await dialog.getByTestId("setting-value").fill(String(v));
      await shot(`w2-11-chat-asks-first-${v}`);
      await dialog.getByTestId("setting-apply").click();
      await page.waitForTimeout(1500);
      await shot(`w2-12-after-apply-${v}`);
      out.dialogButtonsAfter = await page.getByTestId("setting-dialog").getByRole("button").allTextContents().catch(() => []);
      // A raise asks a yes.
      const yes = page.getByTestId("setting-dialog").getByRole("button", { name: /^(Yes|Confirm|Apply|Set)/ });
      if ((await page.getByTestId("setting-dialog").count()) && (await yes.count())) {
        await yes.last().click();
        await page.waitForTimeout(1500);
        await shot(`w2-13-after-yes-${v}`);
      }
    };
    await setTo(0.1);
    await page.goto(`${UI}/changes`);
    await page.waitForTimeout(2500);
    await shot("w2-14-changes");
    out.changes = (await R.api(N, "GET", "/changes?limit=12")).map((c) => c.sentence ?? c);
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
