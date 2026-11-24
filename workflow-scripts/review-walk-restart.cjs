// Review walk: the person's own note read back, the daemon crashes, then Yes after the restart.
// Usage: node review-walk-restart.cjs <bench name> <label> <repo root>
const [name, label, repo] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

function rows(sql, ...args) {
  const db = new DatabaseSync(`/tmp/frbench/${name}/home/data/state.sqlite`, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

(async () => {
  const out = { label };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(name, "POST", "/projects", {
      name: `Help ${label}`,
      goal: "A help page",
    });
    out.project = project.id;
    await R.api(name, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the FAQ",
      outcome: "Write the FAQ is done",
      acceptanceCriteria: ["it exists"],
      riskTier: 1,
      specialist: "coder",
      status: "ready",
    });
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${project.id}/chat`);
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 });
    await page
      .locator('[data-testid="chat-input"]')
      .fill('tool: task_pause {"task": "Write the FAQ", "note": "Wait for the logo."}');
    await page.locator('[data-testid="chat-send"]').click();
    await page.waitForSelector('[data-testid="pending-confirmation"]', { timeout: 30_000 });
    out.readback = await page.locator('[data-testid="pending-confirmation"]').innerText();
    await R.step(page, `${label}-1-readback`);
    execFileSync("node", [`${repo}/scripts/bench/restart-daemon.mjs`, "--name", name, "--hard"], {
      stdio: "inherit",
    });
    await R.reconnect(page, name).catch(() => page.reload());
    await page.goto(`${ui}/projects/${project.id}/chat`);
    await page.waitForSelector('[data-testid="pending-confirmation"]', { timeout: 60_000 });
    out.readbackAfterRestart = await page.locator('[data-testid="pending-confirmation"]').innerText();
    await R.step(page, `${label}-2-readback-after-restart`);
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
    await R.step(page, `${label}-3-after-yes`);
    out.queue = rows(
      "select text, author_human, author_agent from queue_item where project_id = ?",
      project.id,
    );
  } finally {
    fs.writeFileSync(`/tmp/frbench/${name}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
