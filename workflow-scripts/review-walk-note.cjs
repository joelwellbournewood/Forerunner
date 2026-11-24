// Review walk for l4-chat-final: the person's own note in chat, a model-made note, Changes rows.
// Usage: node review-walk-note.cjs <bench name> <label> <repo root> <mode: own|made>
const [name, label, repo, mode] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
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
  const out = { label, mode };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const me = await R.api(name, "GET", "/me");
    out.me = me.id;
    const project = await R.api(name, "POST", "/projects", {
      name: `Help ${label}`,
      goal: "A help page",
    });
    out.project = project.id;
    for (const title of ["Write the FAQ", "Write the intro"])
      await R.api(name, "POST", `/projects/${project.id}/tasks`, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: ["it exists"],
        riskTier: 1,
        specialist: "coder",
        status: "ready",
      });
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/projects/${project.id}/chat`);
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 });
    const send = async (line) => {
      await page.locator('[data-testid="chat-input"]').fill(line);
      await page.locator('[data-testid="chat-send"]').click();
    };
    // 1. Pause, with a note in the person's own line (own) or none (made: the model adds one).
    await send(
      mode === "own"
        ? 'tool: task_pause {"task": "Write the FAQ", "note": "Wait for the logo."}'
        : 'tool: task_pause {"task": "Write the FAQ"}',
    );
    await page.waitForSelector('[data-testid="pending-confirmation"]', { timeout: 30_000 });
    out.pauseReadback = await page.locator('[data-testid="pending-confirmation"]').innerText();
    await R.step(page, `${label}-1-pause-readback`);
    await page.locator('[data-testid="confirm-yes"]').click();
    await R.until(
      async () => /goes into its next brief/.test(await page.locator("main").innerText()),
      30_000,
      500,
      "the yes's sentence",
    );
    out.pauseAfterYes = (await page.locator("main").innerText())
      .split("\n")
      .filter((l) => /goes into its next brief/.test(l));
    await R.step(page, `${label}-2-pause-after-yes`);
    // 2. An edit with a reason: in the person's words (own) or the model's (made).
    await send(
      mode === "own"
        ? 'tool: task_update {"task": "Write the intro", "priority": "high", "note": "it opens the page"}'
        : 'tool: task_update {"task": "Write the intro", "priority": "high"}',
    );
    await page.waitForSelector('[data-testid="pending-confirmation"]', { timeout: 30_000 });
    out.updateReadback = await page.locator('[data-testid="pending-confirmation"]').innerText();
    await R.step(page, `${label}-3-update-readback`);
    await page.locator('[data-testid="confirm-yes"]').click();
    await R.until(
      async () => /Changed "Write the intro"/.test(await page.locator("main").innerText()),
      30_000,
      500,
      "the update's sentence",
    );
    out.updateAfterYes = (await page.locator("main").innerText())
      .split("\n")
      .filter((l) => /Changed "Write the intro"|goes into its next brief/.test(l));
    await R.step(page, `${label}-4-update-after-yes`);
    out.queue = rows(
      "select text, author_human, author_agent from queue_item where project_id = ?",
      project.id,
    );
    out.tasks = rows("select title, status, priority, reason from task where project_id = ?", project.id);
    // 3. The Changes screen as the person sees it.
    await page.goto(`${ui}/changes`);
    await page.waitForTimeout(2500);
    out.changesText = (await R.step(page, `${label}-5-changes`)).slice(0, 2000);
  } finally {
    fs.mkdirSync(`/tmp/frbench/${name}/steps`, { recursive: true });
    fs.writeFileSync(`/tmp/frbench/${name}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
