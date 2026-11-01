// Intake journey: New project -> the plan card -> Approve and start, through the UI, as a person
// with a one-line brief does. Works on the stand-in (--provider bench, with or without
// FORERUNNER_BENCH_INTAKE_BAD) and on the real model (--provider bench-live): it checks what a
// person reads, never the stand-in's own words.
//   node scripts/bench/start.mjs --name intake --daemon-port 48210 --ui-port 1810 --fresh \
//     [--env FORERUNNER_BENCH_INTAKE_BAD=reason-too-long]
//   node scripts/bench/journeys/intake.cjs intake [--brief "..."] [--goal "..."] [--project "..."]
//   node scripts/bench/stop.mjs --name intake
// Every screen is a step (<bench>/steps/NN-*.png and .txt). The result, with every check and
// what the intake calls cost and sent, is <bench>/steps/intake-result.json. Planning that fails
// is retried with Try again up to twice, as a person would. Exit code 0 when the bench worked.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { openApp, skipSetup, step, api, bench, modelCalls, until } = require("../recorder.cjs");

const args = process.argv.slice(2);
const NAME = args[0] && !args[0].startsWith("--") ? args[0] : "intake";
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const BRIEF = opt("--brief", "A page that shows a random quote");
const GOAL = opt("--goal", "");
const PROJECT = opt("--project", `Quote page ${new Date().toISOString().slice(11, 19)}`);

const b = bench(NAME);
const result = { bench: NAME, brief: BRIEF, startedAt: new Date().toISOString(), checks: [] };
const out = (s) => console.log(`[intake] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return !!ok;
};

async function projectSessions(projectId) {
  const s = await api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
  return (Array.isArray(s) ? s : []).filter((x) => x.projectId === projectId);
}

async function createProject(page) {
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByLabel("Name").fill(PROJECT);
  if (GOAL) await page.getByLabel(/^Goal/).fill(GOAL);
  await page.getByLabel(/^Brief/).fill(BRIEF);
  await step(page, "new project dialog filled");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForTimeout(1000);
  if (!/\/projects\/[^/]+/.test(page.url())) {
    // The dialog refused (before the fix: the Goal was required with a one-line brief).
    const text = await step(page, "new project dialog refused");
    check("a one-line brief without a Goal creates the project", false, text.slice(0, 200));
    await page.getByLabel(/^Goal/).fill(BRIEF);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
  } else {
    check("a one-line brief without a Goal creates the project", true);
  }
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
  const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
  result.projectId = projectId;
  const project = (await api(NAME, "GET", "/projects")).find((p) => p.id === projectId);
  result.goal = project?.goal ?? null;
  result.smallProjectMode = project?.smallProjectMode ?? null;
  await step(page, "project created");
  return projectId;
}

/** Wait for the intake: "pending" (the plan waits in the Inbox) or "failed". */
async function waitForPlan(page, projectId) {
  return until(
    async () => {
      const s = await api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/intake`);
      if (s.state === "pending" || s.state === "failed") {
        await page.reload();
        await page.waitForTimeout(1500);
        return s;
      }
      return null;
    },
    // Two real planning calls (the first reply and the corrected one) take up to ~2 minutes.
    600_000,
    2000,
    "the intake to file its plan or fail",
  );
}

async function plan(page, projectId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await waitForPlan(page, projectId);
    const text = await step(page, s.state === "failed" ? "planning failed" : "plan waits");
    if (s.state === "pending") return true;
    const banner = (/Planning failed[\s\S]*?(?=Try again|$)/.exec(text)?.[0] ?? s.error)
      .replace(/\s+/g, " ")
      .trim();
    result.failures = [...(result.failures ?? []), banner];
    out(`planning failed: ${banner}`);
    if (attempt === 2) return false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.waitForTimeout(1500);
  }
  return false;
}

async function approve(page, projectId) {
  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const text = await step(page, "inbox with the plan card");
  const card = page.getByTestId("request").filter({ hasText: `Plan for "${PROJECT}"` });
  if (!check("the Inbox shows the plan card", (await card.count()) === 1)) return null;
  const tasks = await card.getByTestId("intake-task").allInnerTexts();
  result.planCard = { tasks, text: (await card.innerText()).slice(0, 4000) };
  check(
    "the plan has one to three tasks for a one-line brief",
    tasks.length >= 1 && tasks.length <= 3,
    `${tasks.length} task(s)`,
  );
  check(
    "every task line says who does it and its cost (or that it is not known)",
    tasks.every((t) => / · /.test(t) && /(about CHF \d|cost not known|you: answer)/.test(t)),
    tasks.join(" | "),
  );
  check(
    "no task title runs into Needs Docker",
    tasks.every((t) => !/[^\s·]Needs Docker/.test(t)),
  );
  const total = await card
    .getByTestId("intake-total")
    .innerText()
    .catch(() => "");
  check("the total says what it covers", /About CHF \d/.test(total), total);
  const decision = await card
    .getByTestId("intake-decision-line")
    .innerText()
    .catch(() => "");
  check(
    "the decision is one or two sentences, the full record behind a click",
    decision.length > 0 && decision.length < 400 && !/Answers: _pending_/.test(decision),
    decision.slice(0, 300),
  );
  check("the card shows no raw markdown", !/\*\*|_pending_|^#/m.test(text));
  const sessionsBefore = new Set((await projectSessions(projectId)).map((x) => x.id));
  await card.getByRole("button", { name: "Approve and start", exact: true }).click();
  await page.waitForTimeout(2500);
  const after = await step(page, "inbox after approve");
  const done = /Plan approved: (\d+) tasks? written; working on them\./.exec(after);
  check("approving says the plan was written and work started", !!done, done?.[0] ?? "");
  const started = await until(
    async () =>
      (await projectSessions(projectId)).find((x) => !sessionsBefore.has(x.id))?.id ?? null,
    30_000,
    1000,
    "the session Approve and start started",
  ).catch(() => null);
  check("Approve and start starts a session", !!started, started ?? "none in 30 s");
  return started;
}

async function main() {
  const { browser, page } = await openApp(NAME);
  try {
    await skipSetup(page);
    await step(page, "home");
    const projectId = await createProject(page);
    const planned = await plan(page, projectId);
    check(
      "planning ends in a plan card (Try again at most twice)",
      planned,
      (result.failures ?? []).join(" / "),
    );
    if (planned) {
      const sessionId = await approve(page, projectId);
      if (sessionId) {
        await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}`);
        await page.waitForTimeout(3000);
        await step(page, "project after approve");
      }
    }
    // What the intake was asked and what it cost (the model-call log; no key in it).
    const calls = modelCalls(NAME, "intake").filter((c) => (c.label ?? "").includes(projectId));
    result.intakeCalls = calls.map((c) => ({
      model: c.model,
      messages: Array.isArray(c.messages) ? c.messages.length : null,
      smallProjectLine:
        /Small-project mode: [^\n]*/.exec(
          typeof c.messages?.[0]?.content === "string" ? c.messages[0].content : "",
        )?.[0] ?? null,
      outputTokens: c.reply?.usage?.output_tokens ?? null,
      replyChars: (c.reply?.text ?? "").length,
      injected: c.injected ?? null,
    }));
    out(`intake calls: ${JSON.stringify(result.intakeCalls)}`);
  } finally {
    result.endedAt = new Date().toISOString();
    const dir = b.steps;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "intake-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await browser.close();
  }
  const failed = result.checks.filter((c) => !c.ok).length;
  out(`${result.checks.length - failed}/${result.checks.length} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
