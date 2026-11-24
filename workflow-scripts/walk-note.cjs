// l4-chat-final bench walk: the person's own words as a chat note (L4h-left-1).
// Usage: node walk-note.cjs <bench name> <label> <repo root>
const [name, label, repo] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");

(async () => {
  const out = { label };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const me = await R.api(name, "GET", "/me");
    const project = await R.api(name, "POST", "/projects", {
      name: `Help ${label}`,
      goal: "A help page",
    });
    await R.api(name, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the FAQ",
      outcome: "faq.html answers the five questions people ask most",
      acceptanceCriteria: ["faq.html exists"],
      riskTier: 1,
      specialist: "coder",
      status: "ready",
    });
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${project.id}/chat`);
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 });
    const input = page.locator('[data-testid="chat-input"]');
    await input.fill(process.env.WALK_LINE || 'tool: task_pause {"task": "Write the FAQ", "note": "Wait for the logo."}');
    await page.locator('[data-testid="chat-send"]').click();
    await page.waitForSelector('[data-testid="pending-confirmation"]', { timeout: 30_000 });
    out.readback = await page.locator('[data-testid="pending-confirmation"]').innerText();
    await R.step(page, `${label}-1-readback-of-the-persons-note`);
    await page.locator('[data-testid="confirm-yes"]').click();
    await R.until(
      async () => /goes into its next brief/.test(await page.locator("main").innerText()),
      30_000,
      500,
      "the yes's sentence",
    );
    out.afterYes = (await page.locator("main").innerText())
      .split("\n")
      .filter((l) => /goes into its next brief/.test(l));
    await R.step(page, `${label}-2-after-yes`);
    // Who the note is by, as the store holds it (the queued note's author).
    out.me = me.id;
  } finally {
    fs.writeFileSync(`/tmp/frbench/${name}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
