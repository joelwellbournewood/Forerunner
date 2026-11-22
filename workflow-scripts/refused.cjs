// On a bench-api bench with a refused key: a task runs into the refusal; Home's Needs you row
// for the refused-key card offers "Save a new key", which opens the setup assistant's Claude step.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
const N = "review-polish-screens";
const out = {};
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    out.skipped = await R.skipSetup(page);
    const p = await R.api(N, "POST", "/projects", { name: "Refused key", goal: "One page" });
    const me = await R.api(N, "GET", "/me");
    await R.api(N, "POST", `/projects/${p.id}/tasks`, {
      title: "Create index.html",
      outcome: "index.html exists",
      acceptanceCriteria: ["index.html exists"],
      priority: "high",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 0,
    });
    await R.api(N, "POST", "/sessions", { agentId: me.agent.id, projectId: p.id, reason: "review" });
    const card = await R.until(
      async () => {
        const inbox = await R.api(N, "GET", "/inbox");
        return inbox.requests.find((r) => r.status === "open" && /refused/i.test(`${r.title}`)) || null;
      },
      90_000,
      1000,
      "the refused-key card",
    );
    out.card = { title: card.title, choices: card.choices, reply: card.reply, links: card.links };
    await page.goto(`${R.bench(N).uiUrl}/`);
    await page.waitForSelector('[data-testid="home-needs-you"]', { timeout: 20_000 });
    await page.waitForTimeout(1000);
    out.rows = await page.locator('[data-testid="home-card"]').allInnerTexts();
    out.actions = await page
      .locator('[data-testid="home-card-action"]')
      .evaluateAll((els) => els.map((e) => `${e.textContent} -> ${e.getAttribute("href")}`));
    await R.step(page, "home-refused-key");
    const row = page.locator('[data-testid="home-card"]', { hasText: /refused/i }).first();
    await row.getByTestId("home-card-action").click();
    await page.waitForSelector('[data-testid="setup-page"]');
    await page.waitForTimeout(2500);
    out.setupCurrent = await page
      .locator('[aria-current="step"]')
      .first()
      .getAttribute("data-testid")
      .catch(() => null);
    out.noKeyBar = await page.locator('[data-testid="no-key-bar"]').count();
    await R.step(page, "setup-from-save-a-new-key");
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
