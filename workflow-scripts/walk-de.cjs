// Re-walk of the stops acceptance (e) and (d) on the fixup-stops bench (each specialist reply
// waits 2.5 s, the critic does not wait).
const fs = require("node:fs");
const path = require("node:path");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_7dea540b-2f3-9";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fixup-stops";
const OUT = "/tmp/frbench/fixup-stops/steps/walk-de-result.json";
const ui = () => R.bench(N).uiUrl;
const A = process.argv[2];
const tasksOf = (projectId) => R.api(N, "GET", `/projects/${projectId}/tasks`);
const ws = () => R.workspaceOf(N, A);
const files = () => (fs.existsSync(ws()) ? fs.readdirSync(ws()) : []);

async function addTask(title, outcome, priority) {
  const r = await R.api(N, "POST", `/projects/${A}/tasks`, {
    title,
    outcome,
    riskTier: 1,
    specialist: "coder",
    ...(priority ? { priority } : {}),
  });
  return r.task?.id ?? r.id;
}

async function sessionEnds(sid) {
  return R.waitForSession(N, sid, 300_000);
}

(async () => {
  const out = { checks: [] };
  const check = (name, ok, seen) => out.checks.push({ name, ok: !!ok, seen });
  const { browser, page } = await R.openApp(N);
  try {
    await R.reconnect(page, N);
    await R.skipSetup(page);
    // ---- (e) "Skip the Credits page task" in Chat while it runs ----
    const credits = await addTask("Credits page in credits.html", "credits.html names who made the page", "high");
    const faq = await addTask("FAQ page in faq.html", "faq.html answers the club's common questions");
    const startedE = await R.startSession(N, A);
    const sidE = startedE.session?.id ?? startedE.id;
    await R.until(
      async () => (await tasksOf(A)).find((t) => t.id === credits && t.display?.label === "Running") || null,
      120_000,
      200,
      "(e) the Credits page to run",
    );
    await page.goto(`${ui()}/projects/${A}/chat`);
    const input = page.getByTestId("chat-input");
    await input.fill("Skip the Credits page task");
    await page.getByTestId("chat-send").click();
    const confirm = page.getByTestId("pending-confirmation");
    await confirm.waitFor({ timeout: 30_000 });
    const readback = await confirm.innerText();
    out.e = { readback };
    await R.step(page, "e-01-readback", { settleMs: 500 });
    check(
      "(e) the read-back is a cancel: the run stops and what it changed is removed",
      readback.startsWith(
        'Cancel "Credits page in credits.html"? It is dropped; its run stops now and what it changed is removed.',
      ),
      readback,
    );
    let before = await page.getByTestId("chat-agent").count();
    await confirm.getByTestId("confirm-yes").click();
    await R.until(
      async () => ((await page.getByTestId("chat-agent").count()) > before ? true : null),
      30_000,
      250,
      "the reply to yes",
    );
    await page.waitForTimeout(1000);
    const yes = await page.getByTestId("chat-agent").last().innerText();
    out.e.yes = yes;
    await R.step(page, "e-02-after-yes", { settleMs: 500 });
    check(
      "(e) Yes cancels it with the row Cancel's line and an Undo",
      yes.startsWith(
        'Cancelled "Credits page in credits.html": its run stopped and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.',
      ) && /Undo/.test(yes),
      yes,
    );
    // "skip … for now" still pauses: asked while the FAQ page runs, answered No.
    await R.until(
      async () => (await tasksOf(A)).find((t) => t.id === faq && t.display?.label === "Running") || null,
      120_000,
      200,
      "(e) the FAQ page to run",
    );
    await input.fill("skip the FAQ page task for now");
    await page.getByTestId("chat-send").click();
    await confirm.waitFor({ timeout: 30_000 });
    const pause = await confirm.innerText();
    out.e.pause = pause;
    await R.step(page, "e-03-skip-for-now-readback", { settleMs: 500 });
    check(
      "(e) 'skip … for now' reads back a pause",
      pause.startsWith('Stop "FAQ page in faq.html"? Its run stops now and it is paused'),
      pause,
    );
    await confirm.getByTestId("confirm-no").click();
    await sessionEnds(sidE);
    const rowsE = await tasksOf(A);
    out.e.rows = rowsE.filter((t) => [credits, faq].includes(t.id)).map((t) => `${t.title}: ${t.display?.label}`);
    check(
      "(e) Credits reads Cancelled, FAQ goes on",
      rowsE.find((t) => t.id === credits)?.display?.label === "Cancelled" &&
        rowsE.find((t) => t.id === faq)?.status === "done",
      out.e.rows,
    );
    check("(e) credits.html is not in the folder", !files().includes("credits.html"), files());
    await page.goto(`${ui()}/projects/${A}/tasks`);
    await R.step(page, "e-04-tasks", { settleMs: 1500 });

    // ---- (d) Cancel then Undo while the session's next task writes the same file ----
    const print = await addTask(
      "Add a print stylesheet print.css and link it from index.html",
      "print.css styles the page for printing; index.html links it",
      "high",
    );
    const menu = await addTask("Put the menu into index.html", "index.html has the club's menu");
    const startedD = await R.startSession(N, A);
    const sidD = startedD.session?.id ?? startedD.id;
    await R.until(
      async () =>
        (await tasksOf(A)).find((t) => t.id === print && t.display?.label === "Running") &&
        files().includes("print.css")
          ? true
          : null,
      120_000,
      150,
      "(d) print.css written while its task runs",
    );
    await page.goto(`${ui()}/projects/${A}/tasks`);
    const row = page.locator(`[data-testid="task-row"][data-task-id="${print}"]`);
    await row.getByTestId("task-status").filter({ hasText: "Running" }).waitFor({ timeout: 10_000 });
    await row.getByTestId("action-cancel").click({ timeout: 15_000 });
    const dialog = await page.getByTestId("action-explain").innerText();
    out.d = { dialog };
    await R.step(page, "d-01-cancel-dialog", { settleMs: 300 });
    check(
      "(d) the dialog promises only what Undo does",
      dialog.startsWith(
        "Drops it. Its run stops now and what it changed is removed. Undo reopens it, and its changes come back unless the same files changed since.",
      ),
      dialog,
    );
    await page.getByTestId("confirm-action").click();
    await page.getByTestId("task-moved-sentence").waitFor({ timeout: 15_000 });
    out.d.line = await page.getByTestId("task-moved-sentence").innerText();
    await R.step(page, "d-02-after-cancel", { settleMs: 300 });
    await sessionEnds(sidD);
    out.d.menuDone = (await tasksOf(A)).find((t) => t.id === menu)?.status;
    // Changes > Undo.
    await page.goto(`${ui()}/changes`);
    const change = page
      .getByTestId("change")
      .filter({ hasText: 'Cancelled "Add a print stylesheet print.css' })
      .first();
    await change.getByTestId("change-undo").click({ timeout: 15_000 });
    await page.getByTestId("changes-note").waitFor({ timeout: 15_000 });
    const undone = await page.getByTestId("changes-note").innerText();
    out.d.undo = undone;
    await R.step(page, "d-03-after-undo", { settleMs: 500 });
    const printRow = (await tasksOf(A)).find((t) => t.id === print);
    check(
      "(d) Undo says what it did: reopened, and whether the work came back",
      /^Undone: reopened the task "Add a print stylesheet print\.css and link it from index\.html"; it is ready again/.test(
        undone,
      ) &&
        (undone.includes(
          "What it changed could not be put back: the same files changed since. Its next run does the work again.",
        ) ||
          undone.includes("What it changed is back in the folder.")),
      undone,
    );
    check("(d) the row reads Ready after Undo", printRow.display?.label === "Ready", printRow.display);
    await page.goto(`${ui()}/projects/${A}/tasks`);
    await R.step(page, "d-04-tasks-after-undo", { settleMs: 1500 });
    const again = await R.startSession(N, A);
    await sessionEnds(again.session?.id ?? again.id);
    const end = await tasksOf(A);
    out.d.final = end.filter((t) => [print, menu].includes(t.id)).map((t) => `${t.title}: ${t.display?.label}`);
    check(
      "(d) the next Start redoes print.css",
      end.find((t) => t.id === print)?.status === "done" && files().includes("print.css"),
      out.d.final,
    );
    await page.goto(`${ui()}/projects/${A}/tasks`);
    await R.step(page, "d-05-tasks-after-redo", { settleMs: 1500 });
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, "de-error").catch(() => undefined);
  } finally {
    out.ok = !out.error && out.checks.every((c) => c.ok);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
