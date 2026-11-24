// Review walk for l4-chat-final: a failed task's card answered in chat with the person's own note.
// Usage: node review-walk-card.cjs <bench name> <label> <repo root>
const [name, label, repo] = process.argv.slice(2);
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
  const out = { label };
  const { browser, page } = await R.openApp(name, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(name, "POST", "/projects", {
      name: `Digest ${label}`,
      goal: "A digest page",
    });
    out.project = project.id;
    const task = await R.api(name, "POST", `/projects/${project.id}/tasks`, {
      title: "Write the digest page",
      outcome: "digest.html lists the week's news",
      acceptanceCriteria: ["digest.html exists"],
      riskTier: 1,
      specialist: "coder",
      status: "ready",
    });
    out.task = task.id ?? task.task?.id;
    const started = await R.startSession(name, project.id);
    out.session = started?.sessionId ?? started?.id ?? started;
    await R.waitForSession(name, out.session).catch((e) => {
      out.waitError = String(e);
    });
    await R.until(
      async () =>
        rows(
          "select id from human_request where project_id = ? and status = 'open'",
          project.id,
        ).length > 0,
      120_000,
      1000,
      "a card for the failed task",
    );
    out.cards = rows(
      "select id, kind, why, options, risk, status from human_request where project_id = ? and status = 'open'",
      project.id,
    );
    const ui = R.bench(name).uiUrl.replace(/\/$/, "");
    await page.goto(`${ui}/inbox`);
    await page.waitForTimeout(2500);
    out.inboxBefore = (await R.step(page, `${label}-1-inbox-card`)).slice(0, 1500);
    await page.goto(`${ui}/projects/${project.id}/chat`);
    await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 });
    const line =
      process.env.WALK_LINE ||
      'tool: task_transition {"task": "Write the digest page", "to": "ready", "note": "Use the old layout."}';
    await page.locator('[data-testid="chat-input"]').fill(line);
    await page.locator('[data-testid="chat-send"]').click();
    await R.until(
      async () =>
        (await page.locator('[data-testid="pending-confirmation"]').count()) > 0 ||
        /Answer it on its card|Nothing else was filed/.test(await page.locator("main").innerText()),
      30_000,
      500,
      "a read-back or a refusal",
    );
    if ((await page.locator('[data-testid="pending-confirmation"]').count()) > 0) {
      out.readback = await page.locator('[data-testid="pending-confirmation"]').innerText();
      await R.step(page, `${label}-2-readback`);
      if (process.env.WALK_NO_YES !== "1") {
        await page.locator('[data-testid="confirm-yes"]').click();
        await page.waitForTimeout(3000);
        out.afterYes = (await page.locator("main").innerText()).slice(-800);
        await R.step(page, `${label}-3-after-yes`);
      }
    } else {
      out.refusal = (await page.locator("main").innerText()).slice(-800);
      await R.step(page, `${label}-2-refusal`);
    }
    out.cardsAfter = rows(
      "select id, status, answer from human_request where project_id = ?",
      project.id,
    );
    out.queue = rows(
      "select kind, text, author_human, author_agent, status from queue_item where project_id = ?",
      project.id,
    );
    out.taskAfter = rows("select title, status, reason from task where project_id = ?", project.id);
  } finally {
    fs.mkdirSync(`/tmp/frbench/${name}/steps`, { recursive: true });
    fs.writeFileSync(`/tmp/frbench/${name}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
