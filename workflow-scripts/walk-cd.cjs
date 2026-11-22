// Fix-up walk C and D (review of 2026-11-02): a failing project test keeps a task from Done
// through retries that change nothing; a page error the task did not cause is told, not blamed;
// Edit on a deploy; Settings words. Drives the real UI on the bench.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-9/scripts/bench/recorder.cjs");
const NAME = "fixup-verification";
const DIR = "/tmp/frbench/fixup-verification/steps";
const OUT = path.join(DIR, `walk-cd-${process.argv[2] || "after"}-checks.json`);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 2000) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${String(detail).slice(0, 500).replace(/\n/g, " | ")}` : ""}`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(checks, null, 1));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = process.argv[2] || "after";

async function newTask(page, { title, outcome, criteria, level, who }) {
  await page.getByRole("button", { name: "New task" }).first().click();
  const dlg = page.getByTestId("new-task-dialog");
  await dlg.getByTestId("task-title").fill(title);
  await dlg.getByTestId("task-outcome").fill(outcome);
  if (criteria) await dlg.getByTestId("task-criteria").fill(criteria);
  if (level) await dlg.getByTestId("task-risk-tier").selectOption({ label: level });
  await R.until(async () => (await dlg.getByTestId("task-who").locator("option").count()) > 2, 15000, 300, "the specialists list");
  if (who) await dlg.getByTestId("task-who").selectOption(who);
  await dlg.getByTestId("create-task").click();
  await sleep(1200);
}

async function startAndWait(page, pid) {
  const before = (await R.api(NAME, "GET", `/sessions?projectId=${pid}`)).filter((s) => s.projectId === pid).length;
  await page.getByRole("button", { name: /^Start session$/ }).first().click();
  await sleep(1000);
  await page.getByRole("dialog").getByRole("button", { name: /^Start$/ }).click();
  await sleep(1500);
  return R.until(async () => {
    const ss = (await R.api(NAME, "GET", `/sessions?projectId=${pid}`)).filter((s) => s.projectId === pid);
    return ss.length > before && ss.every((s) => !["running", "queued"].includes(s.status)) ? ss : null;
  }, 400000, 2000, "the session to end");
}

(async () => {
  const { browser, page } = await R.openApp(NAME, {});
  page.setDefaultTimeout(20000);
  const base = R.bench(NAME).uiUrl.replace(/[?#].*$/, "");
  try {
    // ---- Walk C: a project whose test always fails.
    const project = await R.api(NAME, "POST", "/projects", {
      name: `Clamp lib ${Date.now() % 10000}`,
      goal: "A tiny maths library",
      brief: "A tiny maths library with a deploy step.",
      intake: false,
    });
    const pid = project.id;
    const ws = R.workspaceOf(NAME, pid);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(
      path.join(ws, "package.json"),
      JSON.stringify({ name: "clamp-lib", private: true, scripts: { test: "node -e \"console.log('not ok 1 - clamp keeps 5 inside 0..3'); process.exit(1)\"" } }, null, 2),
    );
    await page.goto(`${base}/projects/${pid}/tasks`);
    await sleep(2500);
    await newTask(page, {
      title: "Add clamp in src/clamp.js",
      outcome: "src/clamp.js exports clamp(x, lo, hi)",
      criteria: "clamp(5, 0, 3) is 3",
      level: "Light review: the critic reads the work, nothing runs in isolation",
      who: "coder",
    });
    await newTask(page, {
      title: "Deploy the site",
      outcome: "The site is packaged for deploy with a runbook in docs/deploy.md",
      criteria: "docs/deploy.md says how to roll back",
      level: "Light review: the critic reads the work, nothing runs in isolation",
      who: "ops-deploy",
    });
    const created = await R.api(NAME, "GET", `/projects/${pid}/tasks`);
    check("tasks created", created.length === 2, created.map((t) => `${t.title}: tier ${t.riskTier}, ${t.specialist}`).join("; "));
    await page.reload();
    await sleep(2000);
    await R.step(page, `${label}-c-01-tasks-ready`);
    // Edit on the deploy: the levels offered, the note, and what Save sends.
    await page.locator("td").getByText("Deploy the site", { exact: true }).first().click();
    await sleep(1500);
    await page.getByTestId("drawer-action-edit").first().click();
    await sleep(800);
    const opts = await page.getByTestId("edit-risk-tier").locator("option").allInnerTexts();
    const sel = await page.getByTestId("edit-risk-tier").inputValue();
    check("Edit on a deploy offers no Light review", !opts.some((o) => /Light review/.test(o)), `${opts.join(" | ")} (selected ${sel})`);
    const note = await page.getByTestId("edit-full-review-note").count() ? await page.getByTestId("edit-full-review-note").innerText() : "";
    check("Edit says Save raises a deploy to the full review", /keeps the full review and your sign-off: saving moves this task to the full review/.test(note), note);
    await R.step(page, `${label}-c-02-edit-deploy`);
    await page.getByRole("button", { name: /^Cancel$/ }).first().click().catch(() => {});
    await page.keyboard.press("Escape");
    await sleep(600);

    const ss = await startAndWait(page, pid).catch((e) => { check("session ended", false, e.message); return null; });
    check("session ended", !!ss, ss && ss.map((s) => s.status).join(","));
    await sleep(2000);
    const tasks = await R.api(NAME, "GET", `/projects/${pid}/tasks`);
    for (const t of tasks) check(`task "${t.title}"`, true, `${t.status} / ${t.display && t.display.label} / attempt ${t.attempt} / tier ${t.riskTier} / ${JSON.stringify(t.check || null)}`);
    const clamp = tasks.find((t) => /clamp/.test(t.title));
    const dep = tasks.find((t) => /Deploy/.test(t.title));
    check("failing test: clamp is not Done", clamp.status !== "done", `${clamp.status} / ${clamp.display && clamp.display.label}`);
    check("deploy: not Done before sign-off", dep.status !== "done", dep.status);
    const d = await R.api(NAME, "GET", `/tasks/${clamp.id}`);
    const work = d.runs.filter((r) => r.kind === "work");
    const reviews = d.runs.filter((r) => r.kind === "review");
    check("clamp: more than one attempt, one that changed no file", work.length > 1 && work.some((r) => r.files.length === 0), work.map((r) => `${r.specialist}: [${r.files.join(",")}]`).join("; "));
    const criticCalls = R.modelCalls(NAME, "critic").filter((c) => JSON.stringify(c.messages).includes("Add clamp in src/clamp.js") && c.messages.length === 1);
    check("every clamp review ran the test and saw it fail", criticCalls.length === reviews.length && criticCalls.every((c) => /not ok 1 - clamp keeps 5 inside 0\.\.3/.test(JSON.stringify(c.messages))), `${criticCalls.length} first critic calls, ${reviews.length} review runs`);
    check("a no-change attempt is told to the critic", criticCalls.some((c) => /changed no file/.test(JSON.stringify(c.messages))), "");
    check("the drawer's evidence says test: failed", (d.review && d.review.evidence && d.review.evidence.checks || []).some((c) => c.name === "test" && !c.passed), JSON.stringify(d.review && d.review.evidence && d.review.evidence.checks).slice(0, 600));
    check("the failed test is still asked for (not resolved by an accept)", ((d.review && d.review.open) || []).some((o) => /Make the check "test" pass/.test(o)), JSON.stringify(d.review && d.review.open));
    await page.goto(`${base}/projects/${pid}/tasks`);
    await sleep(2500);
    await R.step(page, `${label}-c-03-tasks-after`);
    await page.locator("td").getByText(clamp.title, { exact: true }).first().click();
    await sleep(2000);
    const ev = page.getByText("See what was checked");
    if (await ev.count()) {
      await ev.first().click();
      await sleep(1000);
    }
    const cd = await R.step(page, `${label}-c-04-drawer-clamp`);
    check("clamp drawer shows test: failed", /test: failed/.test(cd), cd.slice(cd.indexOf("Review"), cd.indexOf("Review") + 800));
    await page.keyboard.press("Escape");
    await page.goto(`${base}/inbox`);
    await sleep(2500);
    const inbox = await R.step(page, `${label}-c-05-inbox`);
    check("Inbox has a card for the clamp task", /Add clamp in src\/clamp\.js/.test(inbox), inbox.slice(0, 1500));
    check("Inbox has the deploy's sign-off card", /Deploy the site/.test(inbox) && /sign-off|sign it off/i.test(inbox), "");

    // ---- Walk D: a page that throws before the task; the task only styles it.
    const p2 = await R.api(NAME, "POST", "/projects", { name: `Broken page ${Date.now() % 10000}`, goal: "A page", brief: "A page.", intake: false });
    const ws2 = R.workspaceOf(NAME, p2.id);
    fs.mkdirSync(ws2, { recursive: true });
    fs.writeFileSync(
      path.join(ws2, "index.html"),
      '<!doctype html><html><head><title>Club</title><link rel="stylesheet" href="styles.css"></head><body><h1>Club</h1><script>document.getElementById("quote").textContent = "x";</script></body></html>\n',
    );
    await R.api(NAME, "POST", `/projects/${p2.id}/tasks`, {
      title: "Style the page in styles.css",
      outcome: "styles.css gives the page a green heading",
      acceptanceCriteria: ["The heading is green"],
      riskTier: 1,
      specialist: "coder",
    });
    await page.goto(`${base}/projects/${p2.id}/tasks`);
    await sleep(2500);
    await startAndWait(page, p2.id).catch((e) => check("walk D session ended", false, e.message));
    await sleep(2000);
    const [t2] = await R.api(NAME, "GET", `/projects/${p2.id}/tasks`);
    const d2 = await R.api(NAME, "GET", `/tasks/${t2.id}`);
    const tried = (d2.review && d2.review.evidence && d2.review.evidence.tried) || [];
    check("walk D: the styling task", true, `${t2.status} / ${t2.display && t2.display.label} / ${JSON.stringify(t2.check || null)}`);
    check("walk D: the page was tried and its error is told as not caused by this task", tried.some((t) => /not caused by this task/.test(t.output)), JSON.stringify(tried).slice(0, 800));
    check("walk D: the styling task is not sent back for an error it did not cause", t2.status === "done", t2.status);
    await page.reload();
    await sleep(2500);
    await R.step(page, `${label}-d-01-tasks-after`);
    await page.locator("td").getByText(t2.title, { exact: true }).first().click();
    await sleep(2000);
    const ev2 = page.getByText("See what was checked");
    if (await ev2.count()) {
      await ev2.first().click();
      await sleep(1500);
    }
    const dd = await R.step(page, `${label}-d-02-drawer`);
    check("walk D drawer says not caused by this task", /not caused by this task/.test(dd), dd.slice(dd.indexOf("Review"), dd.indexOf("Review") + 1200));
    await page.keyboard.press("Escape");

    // ---- Settings words: no tier on Sandbox, Models, Advanced.
    await page.goto(`${base}/settings`);
    await sleep(2500);
    await page.locator("details").filter({ hasText: /Advanced/ }).first().evaluate((el) => { el.open = true; }).catch(() => {});
    await sleep(1500);
    const st = await R.step(page, `${label}-s-01-settings`);
    check("Settings: Sandbox says no tier", /Full-review tasks run their tests and builds/.test(st) && !/risk tier/i.test(st), "");
    check("Settings: Models names the critic's reviews", /Critic · light review/.test(st) && !/review tier/i.test(st), "");
    check("Settings: no 'tier' anywhere on the page", !/\btier\b/i.test(st), (st.match(/.{0,60}\btier\b.{0,60}/gi) || []).join(" || "));
    fs.writeFileSync(path.join(DIR, `walk-cd-${label}-projects.json`), JSON.stringify({ clamp: pid, page: p2.id }));
  } catch (e) {
    console.error("WALK ERROR", e);
    check("walk completed without error", false, e && e.stack);
    await R.step(page, `${label}-error`).catch(() => {});
  } finally {
    await browser.close();
  }
})();
