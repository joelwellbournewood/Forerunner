// Review walk 2 (l4-chat-depth): dependency lines, the start read-back, the history window,
// Chat asks first and Changes.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk2.json";

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
    const kite = await R.api(N, "POST", "/projects", { name: "Kite club", goal: "A page for the kite club" });
    out.kite = kite.id;
    await page.goto(`${UI}/projects/${kite.id}/chat`);
    await page.waitForTimeout(2500);
    await say("add a task: Write the README");
    if (await page.getByRole("button", { name: "Yes", exact: true }).count()) await press("Yes");
    await say("add a task: Write the FAQ");
    if (await page.getByRole("button", { name: "Yes", exact: true }).count()) await press("Yes");
    await shot("w2-01-tasks-added");
    // L4-chat-207 in chat.
    await say("make the FAQ task depend on the README task");
    await shot("w2-02-depends-readback");
    await press("Yes");
    await shot("w2-03-depends-done");
    await say("let the FAQ run on its own");
    await shot("w2-04-on-its-own-readback");
    await press("Yes");
    await shot("w2-05-on-its-own-done");
    await say("make the FAQ task depend on the README task");
    await press("Yes");
    // The Tasks drawer's Change what it waits for.
    await page.goto(`${UI}/projects/${kite.id}/tasks`);
    await page.waitForTimeout(2500);
    await page.getByText("Write the FAQ", { exact: false }).first().click();
    await page.waitForTimeout(1500);
    await shot("w2-06-drawer");
    const change = page.getByRole("button", { name: "Change what it waits for", exact: true });
    out.drawerChange = await change.count();
    if (out.drawerChange) {
      await change.first().click();
      await page.waitForTimeout(1000);
      await shot("w2-07-deps-dialog");
      const boxes = page.getByRole("dialog").getByRole("checkbox");
      const nBoxes = await boxes.count();
      for (let i = 0; i < nBoxes; i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
      const dlg = page.getByRole("dialog");
      const btns = await dlg.getByRole("button").allTextContents();
      out.dialogButtons = btns;
      const save2 = dlg.getByRole("button", { name: /^(Save|Change|Apply|Done|OK)/ });
      if (await save2.count()) await save2.first().click();
      await page.waitForTimeout(2000);
      await shot("w2-08-deps-saved");
    }
    // L4-chat-210: run it now.
    await page.goto(`${UI}/projects/${kite.id}/chat`);
    await page.waitForTimeout(2500);
    await say("run it now");
    await shot("w2-09-run-it-now");
    await press("No");
    // L4-chat-205: many quick turns in this project (14 more).
    const lines = [
      "what is left?",
      "what is the next task?",
      "how much did this project cost?",
      "what does the FAQ task wait for?",
      "is anything running?",
      "what is the README task?",
      "what is left?",
      "any open questions?",
      "what is the next task?",
      "what is left?",
      "is anything running?",
      "what is the FAQ task?",
      "what is left?",
      "what is the next task?",
    ];
    for (const l of lines) await say(l);
    await shot("w2-10-many-turns");
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
      // A raise asks a yes.
      const yes = page.getByRole("button", { name: /^(Yes|Confirm|Apply)/ });
      if ((await page.getByTestId("setting-dialog").count()) && (await yes.count())) {
        await yes.last().click();
        await page.waitForTimeout(1500);
        await shot(`w2-13-after-yes-${v}`);
      }
    };
    await setTo(0);
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
