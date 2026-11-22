/* Bench re-walk of the d1109-selftasks-chat fix-up (run from the scratchpad; drives the UI). */
const R = require("/home/user/Forerunner/.claude/worktrees/wf_b8a050fb-2fb-1/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-d1109-selftasks-chat";
const OUT = "/tmp/frbench/fixup-d1109-selftasks-chat/steps/walk-result.json";
const BRIEF = (what) =>
  `A small ${what} for a tea seller.\n\nFeatures:\n- a home page in index.html with a page skeleton\n- styles in styles.css\n- a basket script in script.js\n- a check that every link works\n- a README for the owner`;

const result = { checks: [], notes: [] };
const check = (name, ok, seen) => {
  result.checks.push({ name, ok: !!ok, seen });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(seen).slice(0, 400)}`}`);
};

async function planned(project, level) {
  const have = (await R.api(N, "GET", "/projects")).find((x) => x.name === project);
  if (have) return have.id;
  const created = await R.api(N, "POST", "/projects", {
    name: project,
    goal: `A ${project.toLowerCase()} that sells tea`,
    brief: BRIEF(project.toLowerCase()),
    intake: true,
    autonomyLevel: level,
  });
  const id = created.id;
  const pending = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/projects/${id}/intake`);
      if (s.state === "failed") throw new Error(`intake failed: ${s.error}`);
      return s.state === "pending" ? s : null;
    },
    90_000,
    1000,
    "the plan",
  );
  const inbox = await R.api(N, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.id === pending.requestId);
  await R.api(N, "POST", `/requests/${card.id}/answer`, { version: card.version, answer: "approve" });
  await R.until(async () => (await R.api(N, "GET", `/projects/${id}/tasks`)).length > 0, 30_000, 500, "tasks");
  return id;
}

async function say(page, text, until) {
  const input = page.getByTestId("chat-input");
  await input.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-input"]')?.disabled, null, { timeout: 30_000 });
  const before = await page.getByTestId("chat-agent").count();
  await input.fill(text);
  await page.getByTestId("chat-send").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="chat-agent"]').length > n &&
      document.querySelectorAll('[data-testid="chat-agent"]')[n].getAttribute("data-streaming") === "false",
    before,
    { timeout: 60_000 },
  );
  if (until) await page.getByTestId("chat-agent").nth(before).getByText(until).first().waitFor({ timeout: 30_000 }).catch(() => {});
  return (await page.getByTestId("chat-agent").nth(before).innerText()).trim();
}

const checkCalls = () => R.modelCalls(N).filter((c) => String(c.label ?? "").startsWith("task-check"));

(async () => {
  const shop = await planned("Shop page", 2);
  const garden = await planned("Garden club", 1);
  const shopTasks = await R.api(N, "GET", `/projects/${shop}/tasks`);
  const gardenTasks = await R.api(N, "GET", `/projects/${garden}/tasks`);
  result.notes.push({ shopTasks: shopTasks.map((t) => [t.title, t.status]), gardenTasks: gardenTasks.map((t) => [t.title, t.status]) });
  const style = shopTasks.find((t) => /styles\.css/i.test(t.title))?.title;
  const readme = gardenTasks.find((t) => /README/i.test(t.title))?.title;
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page);
    // W1: Standard, "fix the tasks" makes the changes; the drawer says what the agent did.
    await page.goto(`${R.bench(N).uiUrl}/projects/${shop}/chat`);
    await R.step(page, "w1-shop-chat-before");
    const line = `fix the tasks: "${style}" is two jobs, the layout and the colours; nothing checks that the links work.`;
    if (!shopTasks.some((t) => t.title === "Check that the links work")) {
      const r1 = await say(page, line, "I changed");
      await R.step(page, "w1-shop-after-fix");
      check("W1 Standard reply 'I changed 2 tasks of Shop page.'", r1.includes("I changed 2 tasks of Shop page."), r1);
    }
    await page.goto(`${R.bench(N).uiUrl}/projects/${shop}/tasks`);
    const row = page.getByTestId("task-row").filter({ hasText: "Check that the links work" }).first();
    await row.waitFor({ timeout: 20_000 });
    await row.getByTestId("task-title").click();
    const line1 = page.getByTestId("drawer-agent-change");
    await line1.waitFor({ timeout: 20_000 }).catch(() => {});
    const drawerText = (await line1.count()) ? await line1.innerText() : null;
    await R.step(page, "w1-drawer-added-step");
    check("W1 drawer of the added step reads 'Added by the agent: ...' with no id", drawerText && /^Added by the agent: /.test(drawerText) && !/[0-9a-f]{8}-[0-9a-f]{4}|via chat|by you/.test(drawerText), drawerText);
    await page.keyboard.press("Escape");
    const part = page.getByTestId("task-row").filter({ hasText: ": colours" }).first();
    if (await part.count()) {
      await part.getByTestId("task-title").click();
      const l2 = page.getByTestId("drawer-agent-change");
      await l2.waitFor({ timeout: 20_000 }).catch(() => {});
      const t2 = (await l2.count()) ? await l2.innerText() : null;
      await R.step(page, "w1-drawer-split-part");
      check("W1 drawer of a split part reads 'Split from \"…\" by the agent.'", t2 === `Split from "${style}" by the agent.`, t2);
      await page.keyboard.press("Escape");
    }

    // W2: Assisted, a priority edit is read back as what it changes (no 'reword').
    await page.goto(`${R.bench(N).uiUrl}/projects/${garden}/chat`);
    if (!gardenTasks.some((t) => t.title === "Check that the links work")) {
    const before = checkCalls().length;
    const r2 = await say(page, `fix the tasks: "${readme}" is urgent; nothing checks that the links work.`, "Make these");
    await R.step(page, "w2-garden-read-back");
    const readback = (await page.getByTestId("pending-confirmation").count())
      ? await page.getByTestId("pending-confirmation").last().innerText()
      : r2;
    check("W2 Assisted read-back names the priority change", readback.includes(`change "${readme}": priority to High`) && !/reword/i.test(readback), readback);
    check("W2 one task-check call", checkCalls().length - before === 1, checkCalls().length - before);
    await page.getByTestId("confirm-yes").last().click();
    await page.waitForTimeout(1500);
    await R.step(page, "w2-garden-after-yes");
    const g2 = await R.api(N, "GET", `/projects/${garden}/tasks`);
    const rd = g2.find((t) => t.title === readme);
    check("W2 after Yes the README task is High and the step is added", rd?.priority === "high" && g2.some((t) => t.title === "Check that the links work"), { priority: rd?.priority, titles: g2.map((t) => t.title) });
    const card = (await R.api(N, "GET", "/inbox")).requests.filter((r) => r.projectId === garden && r.status === "open" && /Make these/.test(r.title ?? ""));
    check("W2 no read-back card left open in the Inbox after Yes", card.length === 0, card.map((c) => c.title));
    }

    // W3/W4: lines that are not the plain "fix the tasks" go to the chat model.
    await page.goto(`${R.bench(N).uiUrl}/projects/${shop}/chat`);
    if (!process.env.SKIP34) {
    const c3 = checkCalls().length;
    const r3 = await say(page, "check the tasks for errors");
    await R.step(page, "w3-shop-check-for-errors");
    check("W3 'check the tasks for errors' is answered, never 'There is no project called'", !/There is no project called/.test(r3) && r3.length > 0, r3);
    result.notes.push({ w3TaskChecks: checkCalls().length - c3 });
    const c4 = checkCalls().length;
    const r4 = await say(page, "review the tasks");
    await R.step(page, "w4-shop-review-the-tasks");
    check("W4 'review the tasks' goes to the chat model (no task check)", checkCalls().length === c4 && /\[stand-in model\]/.test(r4), { reply: r4, checks: checkCalls().length - c4 });
    }

    // W5: the principal's planning override is the check's model (C5-left-7).
    const me = await R.api(N, "GET", "/me");
    const set = await R.apiRaw(N, "POST", "/commands/execute", {
      commands: [{ name: "model.settings.set", params: { agent: me.agent.id, mode: "planning", field: "tier", value: "opus" } }],
      confirm: "tap",
      source: "ui",
    });
    result.notes.push({ overrideSet: set.status, body: JSON.stringify(set.body).slice(0, 300) });
    await page.goto(`${R.bench(N).uiUrl}/projects/${garden}/chat`);
    const c5 = checkCalls().length;
    const r5 = await say(page, "tidy up the task list");
    await R.step(page, "w5-garden-tidy-after-override");
    const calls5 = checkCalls().slice(c5);
    check("W5 the check after a planning override runs on the override's model", calls5.length === 1 && calls5[0].model === "fake-opus", { reply: r5, models: calls5.map((c) => c.model) });
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e);
    console.error(e);
    await R.step(page, "error").catch(() => {});
  } finally {
    result.problems = R.problems(N);
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    await browser.close();
  }
})();
