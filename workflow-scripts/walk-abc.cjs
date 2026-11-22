// Re-walk of the stops acceptance (a), (b), (c) on the fixup-stops bench (critic delay 8 s).
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_7dea540b-2f3-9";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fixup-stops";
const OUT = "/tmp/frbench/fixup-stops/steps/walk-abc-result.json";
const ui = () => R.bench(N).uiUrl;

function restart(hard) {
  const r = spawnSync(
    "node",
    [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", N, ...(hard ? ["--hard"] : [])],
    { encoding: "utf8", timeout: 180_000 },
  );
  return `${r.status} ${(r.stdout || "").split("\n").slice(-3).join(" ")} ${(r.stderr || "").slice(-300)}`;
}

async function newProject(page, name, brief) {
  await page.goto(`${ui()}/`);
  await page.getByTestId("new-project").first().click();
  const dlg = page.getByTestId("new-project-dialog");
  await dlg.locator('[name="name"]').fill(name);
  await dlg.locator('[name="brief"]').fill(brief);
  await dlg.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
  const projectId = /\/projects\/([^/?#]+)/.exec(page.url())[1];
  await R.until(
    async () => (await R.api(N, "GET", `/projects/${projectId}/intake`)).state === "pending" || null,
    120_000,
    1000,
    "the plan",
  );
  await page.goto(`${ui()}/inbox`);
  await page.getByRole("button", { name: "Approve and start" }).first().click({ timeout: 30_000 });
  return projectId;
}

const tasksOf = (projectId) => R.api(N, "GET", `/projects/${projectId}/tasks`);
async function lastSessionId(projectId) {
  const s = await R.api(N, "GET", `/projects/${projectId}/summary`);
  return s.lastSession?.id ?? null;
}

(async () => {
  const out = { checks: [] };
  const check = (name, ok, seen) => out.checks.push({ name, ok: !!ok, seen });
  let { browser, page } = await R.openApp(N);
  try {
    await R.skipSetup(page);
    // ---- (a) Quit and crash during "Being reviewed" ----
    const a = await newProject(
      page,
      "Garden club",
      "A small web page for the garden club that shows the next meeting date.",
    );
    out.a = { projectId: a };
    let reviewed = null;
    await R.until(
      async () => {
        reviewed = (await tasksOf(a)).find((t) => t.display?.label === "Being reviewed") || null;
        return reviewed;
      },
      180_000,
      150,
      "(a) a task being reviewed",
    );
    await page.goto(`${ui()}/projects/${a}/tasks`);
    await R.step(page, "a-01-being-reviewed", { settleMs: 500 });
    out.a.restart = restart(false);
    await R.reconnect(page, N);
    await page.goto(`${ui()}/projects/${a}/tasks`);
    let text = await R.step(page, "a-02-tasks-after-quit", { settleMs: 1500 });
    let row = (await tasksOf(a)).find((t) => t.id === reviewed.id);
    check("(a) after Quit the task reads Ready", row.display?.label === "Ready", row.display);
    await page.goto(`${ui()}/inbox`);
    text = await R.step(page, "a-03-inbox-after-quit", { settleMs: 1500 });
    check(
      "(a) after Quit the Update or the session says it is ready",
      text.includes(`"${reviewed.title}" is ready again`) ||
        text.includes(`"${reviewed.title}" is ready to continue`) ||
        /ready again|ready to continue/.test(JSON.stringify(await R.api(N, "GET", `/projects/${a}/summary`))),
      text.split("\n").filter((l) => /ready again|ready to continue|interrupted|closed/i.test(l)),
    );
    const check1 = await R.api(N, "GET", `/projects/${a}/start-check`).catch((e) => ({ error: String(e) }));
    out.a.startCheck = check1;
    // Start again, crash during the review.
    await R.startSession(N, a);
    await R.until(
      async () =>
        (await tasksOf(a)).find((t) => t.id === reviewed.id && t.display?.label === "Being reviewed") ||
        null,
      180_000,
      150,
      "(a) the review again",
    );
    await page.goto(`${ui()}/projects/${a}/tasks`);
    await R.step(page, "a-04-being-reviewed-again", { settleMs: 500 });
    out.a.crash = restart(true);
    await R.reconnect(page, N);
    await page.goto(`${ui()}/projects/${a}/tasks`);
    await R.step(page, "a-05-tasks-after-crash", { settleMs: 1500 });
    row = (await tasksOf(a)).find((t) => t.id === reviewed.id);
    check("(a) after a crash the task reads Ready", row.display?.label === "Ready", row.display);
    await page.goto(`${ui()}/inbox`);
    text = await R.step(page, "a-06-inbox-after-crash", { settleMs: 1500 });
    check(
      "(a) after a crash the Update names it ready again",
      text.includes(`"${reviewed.title}" is ready again`),
      text.split("\n").filter((l) => /ready again|interrupted/i.test(l)),
    );
    // The next Start runs and reviews it.
    const started = await R.startSession(N, a);
    const sid = started.session?.id ?? started.id;
    await R.waitForSession(N, sid, 300_000);
    // A small plan: the check runs after the page; run once more if one is left ready.
    let all = await tasksOf(a);
    if (all.some((t) => t.status === "ready")) {
      const again = await R.startSession(N, a);
      await R.waitForSession(N, again.session?.id ?? again.id, 300_000);
      all = await tasksOf(a);
    }
    await page.goto(`${ui()}/projects/${a}/tasks`);
    await R.step(page, "a-07-tasks-after-next-start", { settleMs: 1500 });
    out.a.final = all.map((t) => ({ title: t.title, label: t.display?.label, critic: t.review ?? null }));
    check(
      "(a) the next Start finishes the work",
      all.every((t) => t.status === "done"),
      out.a.final,
    );
    const detail = await R.api(N, "GET", `/tasks/${reviewed.id}`);
    check(
      "(a) the reviewed task has a review run",
      (detail.runs || []).some((r) => r.kind === "review"),
      (detail.runs || []).map((r) => `${r.kind}:${r.outcome}`),
    );

    // ---- (b) Cancel 0.5 s into "Being reviewed" ----
    const b = await newProject(
      page,
      "Bird club",
      "A small web page for the bird club that lists this month's walks.",
    );
    out.b = { projectId: b };
    await page.goto(`${ui()}/projects/${b}/tasks`);
    let target = null;
    let seenAt = 0;
    await R.until(
      async () => {
        target = (await tasksOf(b)).find((t) => t.status === "in_review") || null;
        if (target) seenAt = Date.now();
        return target;
      },
      180_000,
      80,
      "(b) a review",
    );
    const rowB = page.locator(`[data-testid="task-row"][data-task-id="${target.id}"]`);
    await rowB.getByTestId("action-cancel").click({ timeout: 15_000 });
    const explainB = await page.getByTestId("action-explain").innerText();
    const wait = 500 - (Date.now() - seenAt);
    if (wait > 0) await page.waitForTimeout(wait);
    const cancelAt = new Date();
    await page.getByTestId("confirm-action").click();
    out.b.msIntoReview = cancelAt.getTime() - seenAt;
    out.b.dialog = explainB;
    await page.getByTestId("task-moved-sentence").waitFor({ timeout: 15_000 });
    const lineB = await page.getByTestId("task-moved-sentence").innerText();
    out.b.line = lineB;
    await R.step(page, "b-01-after-cancel", { settleMs: 500 });
    check(
      "(b) the dialog says the review stops and its changes are removed",
      /Its review stops now and what it changed is removed/.test(explainB),
      explainB,
    );
    check(
      "(b) the line says the review stopped and what it changed is removed",
      lineB.startsWith(`Cancelled "${target.title}": its review stopped and what it changed is removed.`),
      lineB,
    );
    const sidB = await R.until(async () => lastSessionId(b), 120_000, 500, "(b) the session to end");
    const ws = R.workspaceOf(N, b);
    const files = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
    out.b.files = files;
    const critic = R.modelCalls(N, "critic").filter(
      (c) => new Date(c.time) > cancelAt && (c.label || "").includes(target.id.slice(0, 8)),
    );
    const criticAny = R.modelCalls(N, "critic").filter((c) => new Date(c.time) > cancelAt);
    out.b.criticAfter = criticAny.map((c) => ({ time: c.time, label: c.label }));
    check("(b) no critic call after the Cancel", criticAny.length === 0 || critic.length === 0, out.b.criticAfter);
    check("(b) the page left the folder", !files.includes("index.html"), files);
    const rowAfter = (await tasksOf(b)).find((t) => t.id === target.id);
    check("(b) the row reads Cancelled", rowAfter.display?.label === "Cancelled", rowAfter.display);
    out.b.session = sidB;

    // ---- (c) Cancel on a task with nothing going on ----
    const ready = await R.api(N, "POST", `/projects/${a}/tasks`, {
      title: "Contact page in contact.html",
      outcome: "contact.html says how to reach the club",
      riskTier: 1,
      specialist: "coder",
    });
    await page.goto(`${ui()}/projects/${a}/tasks`);
    const rowC = page.locator(`[data-testid="task-row"][data-task-id="${ready.task?.id ?? ready.id}"]`);
    await rowC.getByTestId("action-cancel").click({ timeout: 15_000 });
    const explainC = await page.getByTestId("action-explain").innerText();
    await R.step(page, "c-01-cancel-ready-dialog", { settleMs: 500 });
    check("(c) a Ready task's Cancel says only 'Drops it.'", explainC.trim() === "Drops it.", explainC);
    await page.getByTestId("dismiss-action").click();
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, "abc-error").catch(() => undefined);
  } finally {
    out.ok = !out.error && out.checks.every((c) => c.ok);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
