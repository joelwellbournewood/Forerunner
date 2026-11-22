// w15-words bench walk: the screens whose words this area changed, read where a person reads them.
// node walk15.cjs <repo> <bench name> <label>
const [repo, n, label] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const out = {};

async function main() {
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    const base = (await R.api(n, "GET", "/me")) ?? {};
    void base;
    // A project with planned work (the stand-in's 4-5 tasks), approved, no session yet.
    const brief = "A one-page site for the garden club: a home page, a page for events, a contact form and a short guide for members.";
    const { projectId } = await R.createPlannedProject(n, {
      project: "Garden club",
      goal: "A small site",
      brief,
    }).then((r) => (typeof r === "string" ? { projectId: r } : r));
    out.projectId = projectId;
    const ui = R.bench(n).uiUrl;

    // Settings: the session budget's 0 and a negative amount (W15B-16).
    await page.goto(`${ui}/settings`);
    await page.getByTestId("settings-basics").waitFor();
    const cap = page.locator('[data-testid="setting-row"][data-key="project.session_cap"]').first();
    await cap.getByTestId("setting-change").click();
    const dialog = page.getByTestId("setting-dialog");
    const input = dialog.getByTestId("setting-value");
    await input.fill("0");
    out.sessionZero = await dialog.getByTestId("setting-value-problem").innerText().catch(() => null);
    await R.step(page, `${label}-settings-session-zero`);
    await input.fill("-3");
    out.sessionNegative = await dialog.getByTestId("setting-value-problem").innerText().catch(() => null);
    await R.step(page, `${label}-settings-session-negative`);
    await page.keyboard.press("Escape");

    // Opus fast mode: the change's sentence (W15B-16).
    const fast = await R.api(n, "POST", "/commands/execute", {
      commands: [{ name: "settings.set", params: { key: "fast_mode", value: true, project: projectId } }],
      wordsUsed: "Settings: Opus fast mode to On",
      source: "ui",
      confirm: "tap",
    });
    out.fastMode = fast.sentence ?? fast.readback ?? null;

    // Changes: undo of a lowered monthly cap that needs this device (W15B-24), and the fake's
    // budget sentence's twin from the daemon (W15B-16).
    const lowered = await R.api(n, "POST", "/commands/execute", {
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      wordsUsed: "Settings: Monthly spending cap to 100",
      source: "ui",
      confirm: "tap",
    });
    out.lowered = lowered.sentence ?? null;
    await page.goto(`${ui}/changes`);
    const row = page.locator(`[data-testid="change"][data-change-id="${lowered.changeLogId}"]`);
    await row.getByTestId("change-undo").click();
    const asking = page.getByTestId("changes-undo-pending");
    out.undoReadback = await asking.getByTestId("command-readback").innerText().catch(() => null);
    await R.step(page, `${label}-changes-undo-device`);
    await asking.getByTestId("command-no").click().catch(() => {});

    // The Start dialog with CHF 0.04: the tasks left for next time (W15-38), and 0 (W15B-16).
    await page.goto(`${ui}/projects/${projectId}`);
    await page.getByTestId("start-session").click();
    const start = page.getByTestId("start-session-dialog");
    const budget = start.getByLabel(/Session budget/);
    await budget.fill("0.04");
    await page.waitForTimeout(1500);
    out.overBudget = await start.getByTestId("start-session-over-budget").allInnerTexts().catch(() => []);
    out.planLine = await start.getByTestId("start-session-plan").innerText().catch(() => null);
    await R.step(page, `${label}-start-dialog-0.04`);
    await budget.fill("0");
    out.startZero = await start.getByTestId("start-session-budget-error").innerText().catch(() => null);
    await R.step(page, `${label}-start-dialog-zero`);
    await page.keyboard.press("Escape");

    // The Docs tab: no zero count (W15-40).
    await page.goto(`${ui}/projects/${projectId}/docs`);
    await page.getByTestId("docs").waitFor();
    out.docsBadges = await page.getByTestId("docs").locator('[data-testid^="docs-"]').allInnerTexts();
    await R.step(page, `${label}-docs-tab`);

    // The Tasks tab: who does each, in words (W15-43).
    await page.goto(`${ui}/projects/${projectId}/tasks`);
    await page.getByTestId("tasks").waitFor();
    out.taskRows = await page.getByTestId("task-row").allInnerTexts();
    await R.step(page, `${label}-tasks-tab`);
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    console.log(JSON.stringify(out, null, 2));
  })
  .catch((e) => {
    console.log(JSON.stringify(out, null, 2));
    console.error(e);
    process.exit(1);
  });
