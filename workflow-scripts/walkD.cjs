// Review walk D: the chat lines of this area in a project's Chat tab (bench started with
// FORERUNNER_BENCH_CHAT_HOLD_MS). Usage: node walkD.cjs <repo> <bench> <label> <projectId> <atlasName> <shopId>
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label, pid, atlasName, shopId] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label, replies: {}, checks: {} };
(async () => {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  const lastAgent = async () =>
    (await page.locator("[data-testid='chat-agent']").allTextContents()).at(-1) ?? null;
  const send = async (text) => {
    const box = page.getByTestId("chat-input");
    await box.fill(text);
    await page.getByTestId("chat-send").click();
  };
  const settled = async (ms = 60_000) => {
    await R.until(async () => (await page.getByTestId("chat-stop").count()) === 0, ms, 500, "the reply");
    await sleep(800);
  };
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/chat`);
    await sleep(2500);
    // 1. C3-left-11: Stop during the claim guard's nudge.
    const callsBefore = R.modelCalls(n, "chat").length;
    await send(`say: I've added the task "Write the FAQ" for you.`);
    await R.until(
      async () => /Checking what changed/.test(await page.getByTestId("chat").textContent()),
      30_000,
      200,
      "the guard's step",
    );
    out.checks.sawCheckingStep = true;
    await R.step(page, `${label}-checking-step`);
    await page.getByTestId("chat-stop").click();
    await settled();
    out.replies.stopDuringNudge = await lastAgent();
    out.checks.chatCallsForStop = R.modelCalls(n, "chat").length - callsBefore;
    await R.step(page, `${label}-stopped`);
    // 2. L4c-left-7: a yes asked in words, twice.
    await send("say: Shall I set research for Price page to any public website again?");
    await settled();
    out.replies.asks = await lastAgent();
    await R.step(page, `${label}-asks`);
    // 3. L4c-left-8: an absence about now.
    const before3 = R.modelCalls(n, "chat").length;
    await send("say: Two tasks are left. I don't see any failed tasks.");
    await settled();
    out.replies.absentNow = await lastAgent();
    out.checks.callsAbsentNow = R.modelCalls(n, "chat").length - before3;
    // 4. L4c-left-9: "there" with several projects and no switch here.
    await send("add a task there: write the about page");
    await settled();
    out.replies.there = await lastAgent();
    out.checks.thereButtons = await page.getByRole("button").allTextContents();
    await R.step(page, `${label}-there-question`);
    // 5. L4c-left-10: switch here, then a header switch, then "there".
    await send(`switch to ${atlasName}`);
    await settled();
    out.replies.switch = await lastAgent();
    await R.api(n, "POST", "/commands/execute", {
      commands: [{ name: "project.switch", params: { project: shopId } }],
      wordsUsed: "Switch project",
      source: "ui",
    }).catch((e) => (out.checks.headerSwitchError = String(e)));
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/chat`);
    await sleep(2500);
    await send("add a task there: write the about page");
    await settled();
    out.replies.thereAfterSwitches = await lastAgent();
    await R.step(page, `${label}-there-after-switches`);
    // Reload: the stopped turn and the others read the same.
    await page.reload();
    await sleep(3000);
    out.afterReload = await R.step(page, `${label}-after-reload`);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ replies: out.replies, checks: out.checks }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
